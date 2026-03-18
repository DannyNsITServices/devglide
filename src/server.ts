/**
 * Devglide Unified Server
 *
 * Consolidates all 9 Devglide micro-services into a single Express/Socket.io
 * server. Each app's routes live in src/routers/<app>.ts and are mounted under
 * /api/<app>. Static assets are served from the original app public dirs.
 */

import express from 'express';
import { createServer } from 'http';
import { Server, type Namespace } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

// Shared packages
import { isLocalhostOrigin } from './packages/auth-middleware.js';
import { LOGS_DIR, projectDataDir } from './packages/paths.js';
import { snifferSource, runnerSource } from './packages/devtools-middleware.js';
import { initServerSniffer, shutdownServerSniffer } from './packages/server-sniffer.js';
import { mountMcpHttp } from './packages/mcp-utils/src/index.js';

// Project context
import { getActiveProject, setActiveProject } from './project-context.js';

// Initial stored project
import { getActiveProject as getStoredProject } from './packages/project-store.js';

// Routers
import { router as dashboardRouter, initDashboard } from './routers/dashboard.js';
import { router as kanbanRouter, createKanbanMcpServer } from './routers/kanban.js';
import { router as logRouter, initLog, shutdownLog, createLogMcpServer } from './routers/log.js';
import { recordSession } from './apps/log/src/routes/log.js';
import { router as testRouter, initTest, shutdownTest, createTestMcpServer } from './routers/test.js';
import { router as shellRouter, initShell, mountShellMcp, shutdownShell } from './routers/shell/index.js';
import { router as coderRouter } from './routers/coder.js';
import { router as workflowRouter, initWorkflow, shutdownWorkflow, createWorkflowMcpServer } from './routers/workflow.js';
import { router as voiceRouter, createVoiceMcpServer } from './routers/voice.js';
import { router as vocabularyRouter, createVocabularyMcpServer } from './routers/vocabulary.js';
import { router as promptsRouter, createPromptsMcpServer } from './routers/prompts.js';


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '7000', 10);

// ---------------------------------------------------------------------------
// Server sniffer — captures server-side console output to disk
// ---------------------------------------------------------------------------

initServerSniffer({ service: 'devglide', targetPath: path.join(ROOT, 'server.log'), logPort: PORT });

// ---------------------------------------------------------------------------
// Express + HTTP + Socket.io
// ---------------------------------------------------------------------------

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || isLocalhostOrigin(origin)) return cb(null, true);
      cb(null, false);
    },
  },
});

// No auth — local-only dev tool; CORS restricts cross-origin access.

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  next();
});

// ---------------------------------------------------------------------------
// Shared CORS middleware
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isLocalhostOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Body parser — 1 MB default, 25 MB for voice transcription uploads
// ---------------------------------------------------------------------------

const jsonDefault = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '25mb' });

app.use((req, res, next) => {
  const isVoiceUpload = req.path.startsWith('/api/voice/transcribe') || req.path === '/api/transcribe';
  (isVoiceUpload ? jsonLarge : jsonDefault)(req, res, next);
});

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

app.use('/shared-assets', express.static(path.join(ROOT, 'src/packages/shared-assets')));
app.use('/df', express.static(path.join(ROOT, 'src/packages/design-tokens/dist')));
app.use('/design-tokens', express.static(path.join(ROOT, 'src/packages/design-tokens/dist')));

// App-specific static dirs
app.use('/app/kanban', express.static(path.join(ROOT, 'src/apps/kanban/public')));
app.use('/app/log', express.static(path.join(ROOT, 'src/apps/log/public')));
app.use('/app/test', express.static(path.join(ROOT, 'src/apps/test/public')));
app.use('/app/shell', express.static(path.join(ROOT, 'src/apps/shell/public')));
app.use('/app/coder', express.static(path.join(ROOT, 'src/apps/coder/public')));
app.use('/app/workflow', express.static(path.join(ROOT, 'src/apps/workflow/public')));
app.use('/app/voice', express.static(path.join(ROOT, 'src/apps/voice/public')));
app.use('/app/vocabulary', express.static(path.join(ROOT, 'src/apps/vocabulary/public')));
app.use('/app/keymap', express.static(path.join(ROOT, 'src/apps/keymap/public')));
app.use('/app/prompts', express.static(path.join(ROOT, 'src/apps/prompts/public')));
app.use('/app/documentation', express.static(path.join(ROOT, 'src/apps/documentation/public')));

// App shell (unified SPA) is the default landing page at root
app.use('/', express.static(path.join(ROOT, 'src/public')));

// ---------------------------------------------------------------------------
// Rate limiter — per-IP request throttling for sensitive endpoints
// ---------------------------------------------------------------------------

const rateLimitState = new Map<string, { count: number; resetAt: number }>();

function rateLimit(maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    let entry = rateLimitState.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitState.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitState) {
    if (now > entry.resetAt) rateLimitState.delete(key);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// No auth middleware — local-only dev tool; CORS handles access control.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Devtools — serves /__devtools.js with inlined sniffer + runner.
// Placed after auth to prevent unauthenticated path disclosure.
// ---------------------------------------------------------------------------

app.get('/__devtools.js', (_req, res) => {
  let script = `window.__devglideSnifferConfig=${JSON.stringify({
    serverOrigin: `http://localhost:${PORT}`,
    targetPath: path.join(LOGS_DIR, 'devglide-console.log'),
    persistent: true,
    allowedTypes: {},
  })};\n`;

  script += `window.__devglideRunnerConfig=${JSON.stringify({
    serverOrigin: `http://localhost:${PORT}`,
    target: ROOT,
    spaMode: true,
  })};\n`;

  script += snifferSource + '\n' + runnerSource;
  res.type('application/javascript').send(script);
});

app.get('/devtools.js', (req, res) => {
  const project = getActiveProject();
  if (!project) {
    return res.type('application/javascript').send('/* devtools: no target */');
  }

  let script = `window.__devglideSnifferConfig=${JSON.stringify({
    serverOrigin: `http://localhost:${PORT}`,
    targetPath: path.join(projectDataDir(project.id, 'logs'), project.name + '-console.log'),
    persistent: true,
    allowedTypes: {},
  })};\n`;

  script += `window.__devglideRunnerConfig=${JSON.stringify({
    serverOrigin: `http://localhost:${PORT}`,
    target: project.path,
  })};\n`;

  script += snifferSource + '\n' + runnerSource;
  res.type('application/javascript').send(script);
});

// ---------------------------------------------------------------------------
// API routers
// ---------------------------------------------------------------------------

app.use('/api/dashboard', dashboardRouter);
app.use('/api/kanban', kanbanRouter);
app.use('/api/log', logRouter);
app.use('/api/test', testRouter);
app.use('/api/shell', rateLimit(100, 60_000), shellRouter);
app.use('/api/coder', coderRouter);
app.use('/api/workflow', workflowRouter);
app.use('/api/voice', voiceRouter);
app.use('/api/vocabulary', vocabularyRouter);
app.use('/api/prompts', promptsRouter);


app.use('/', rateLimit(60, 60_000), shellRouter);  // /preview, /proxy

// ---------------------------------------------------------------------------
// MCP endpoints
// ---------------------------------------------------------------------------

mountMcpHttp(app, () => createKanbanMcpServer(), '/mcp/kanban');
mountMcpHttp(app, createLogMcpServer, '/mcp/log');
mountMcpHttp(app, createTestMcpServer, '/mcp/test');
mountMcpHttp(app, createVoiceMcpServer, '/mcp/voice');
mountMcpHttp(app, createWorkflowMcpServer, '/mcp/workflow');
mountMcpHttp(app, createVocabularyMcpServer, '/mcp/vocabulary');
mountMcpHttp(app, createPromptsMcpServer, '/mcp/prompts');

mountShellMcp(app, '/mcp/shell');

// ---------------------------------------------------------------------------
// Socket.io namespaces
// ---------------------------------------------------------------------------

// Dashboard and shell events use the default namespace for backward
// compatibility — the iframe-loaded frontends connect with io() which
// hits the default namespace.  The event names don't conflict (dashboard
// uses project:*, shell uses terminal:*/state:*/browser:*).
initDashboard(io.of('/'));
initShell(io.of('/'));

// ---------------------------------------------------------------------------
// Service initialization
// ---------------------------------------------------------------------------

async function bootstrap() {
  initLog();

  // Register the server log session directly (same process — no HTTP needed).
  // The sniffer's initial SESSION_START POST fires before the server is listening,
  // so this ensures the session is always discoverable in the log UI.
  const serverLogPath = path.join(ROOT, 'server.log');
  recordSession({
    type: 'SESSION_START',
    session: 'devglide-server',
    ts: new Date().toISOString(),
    url: 'server://devglide',
    ua: `node/${process.version}`,
    persistent: true,
    targetPath: serverLogPath,
  });

  await initTest();
  initWorkflow();

  // Restore active project from persistent store
  const stored = getStoredProject();
  if (stored) setActiveProject(stored);

  // Start listening
  httpServer.listen(PORT, () => {
    console.log(`[devglide] unified server listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[devglide] bootstrap failed:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  console.log('[devglide] shutting down...');
  shutdownLog();
  shutdownTest();
  shutdownWorkflow();
  shutdownShell();
  shutdownServerSniffer();
  io.close();
  httpServer.close(() => {
    console.log('[devglide] server closed');
    process.exit(0);
  });

  // Force exit after 5 s if open connections prevent graceful shutdown
  setTimeout(() => {
    console.warn('[devglide] forced exit — open connections did not close in time');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
