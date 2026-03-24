import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { getActiveProject } from '../../project-context.js';
import { asyncHandler, errorMessage, badRequest, forbidden, notFound, conflict, badGateway } from '../../packages/error-middleware.js';
import {
  globalPtys,
  dashboardState,
  getShellNsp,
  MAX_PANES,
  nextPaneId,
  nextNumForProject,
  panesForProject,
  paneActiveSocket,
  socketDimensions,
  renumberPanes,
} from '../../apps/shell/src/runtime/shell-state.js';
import { SHELL_CONFIGS } from '../../apps/shell/src/runtime/shell-config.js';
import { killPty, spawnGlobalPty } from '../../apps/shell/src/runtime/pty-manager.js';
import { onPaneClosed as onChatPaneClosed } from '../../apps/chat/services/chat-registry.js';
import type { PaneInfo } from '../../apps/shell/src/shell-types.js';
import { safeFetch } from '../../packages/ssrf-guard.js';

// ── Preview helpers ──────────────────────────────────────────────────────────

const PREVIEW_ENTRY_POINTS: string[] = [
  'public/index.html',
  'dist/index.html',
  'index.html',
  'build/index.html',
  'src/index.html',
];

export function detectEntryPoint(projectPath: string): { file: string; base: string } | null {
  for (const entry of PREVIEW_ENTRY_POINTS) {
    const full = path.join(projectPath, entry);
    if (fs.existsSync(full)) return { file: entry, base: path.dirname(entry) };
  }
  return null;
}

// ── HTTP Router ──────────────────────────────────────────────────────────────

export const router: Router = Router();


const proxyQuerySchema = z.object({
  url: z.string().min(1, 'url is required'),
});

const paneIdParamSchema = z.object({
  id: z.string().min(1, 'pane id is required'),
});

// ── Preview route — serve static files from active project ─────────────────

router.use('/preview', (req: Request, res: Response, next: NextFunction) => {
  const projectPath = getActiveProject()?.path;
  if (!projectPath) return notFound(res, 'No active project');

  const reqPath = decodeURIComponent(req.path).replace(/^\//, '') || 'index.html';
  if (reqPath.includes('\0') || /\.\.[\\/]/.test(reqPath)) {
    return badRequest(res, 'Invalid path');
  }

  let resolved = path.resolve(projectPath, reqPath);
  if (!resolved.startsWith(projectPath)) {
    return forbidden(res, 'Path traversal denied');
  }

  // Resolve symlinks to prevent symlink-based traversal
  try {
    const realRoot = fs.realpathSync(projectPath);
    const realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return forbidden(res, 'Symlink traversal denied');
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return forbidden(res, 'Symlink traversal denied');
    }
    // ENOENT: file doesn't exist, sendFile will handle it below
  }

  // Directory requests: try serving index.html from within
  try {
    if (fs.statSync(resolved).isDirectory()) {
      resolved = path.join(resolved, 'index.html');
    }
  } catch {}

  res.sendFile(resolved, (err: Error | null) => {
    if (err) next();
  });
});

// ── Proxy route — fetch relay for browser pane ──────────────────────────────
// Minimal fetch relay — client uses srcdoc to render HTML (bypasses X-Frame-Options).

router.get('/proxy', asyncHandler(async (req: Request, res: Response) => {
  const query = proxyQuerySchema.safeParse(req.query);
  if (!query.success) {
    return badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
  }
  const targetUrl = query.data.url;

  try {
    const upstream = await safeFetch(targetUrl, {
      headers: {
        'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0',
        'Accept': 'text/html,*/*',
        'Accept-Language': (req.headers['accept-language'] as string) || 'en-US,en;q=0.9',
      },
    });

    const html: string = await upstream.text();
    res.setHeader('X-Final-URL', upstream.url);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(html);
  } catch (err: unknown) {
    const message = errorMessage(err);
    // SSRF validation errors get 403, network errors get 502
    const status = message.includes('Blocked') || message.includes('blocked') || message.includes('Only HTTP') || message.includes('Invalid URL') || message.includes('Too many redirects') ? 403 : 502;
    if (status === 403) {
      forbidden(res, message);
      return;
    }
    badGateway(res, message);
  }
}));

// ── Pane management REST API ────────────────────────────────────────────────
// Mirrors the shell MCP tools so non-MCP clients can manage terminal panes.

// GET /panes — list active terminal panes
router.get('/panes', (_req: Request, res: Response) => {
  const panes = dashboardState.panes.map((p) => ({
    id: p.id,
    num: p.num,
    shellType: p.shellType,
    title: p.title,
    cwd: p.cwd,
  }));
  res.json(panes);
});

const createPaneSchema = z.object({
  shellType: z.enum(['default', 'bash', 'cmd']).optional().default('default'),
  cwd: z.string().optional(),
});

const runCommandSchema = z.object({
  command: z.string().min(1, 'command is required'),
  timeout: z.number().optional(),
});

const scrollbackQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(10000).optional().default(100),
});

// POST /panes — create a new terminal pane
router.post('/panes', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createPaneSchema.safeParse(req.body);
  if (!parsed.success) {
    return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { shellType, cwd } = parsed.data;

  const currentProjectId = getActiveProject()?.id || null;
  if (panesForProject(currentProjectId) >= MAX_PANES) {
    return conflict(res, `Maximum pane limit (${MAX_PANES}) per project reached`);
  }

  if (cwd) {
    if (!path.isAbsolute(cwd) || cwd.includes('\0') || /\.\.[\\/]/.test(cwd)) {
      return badRequest(res, 'Invalid cwd: must be absolute without traversal or null bytes');
    }
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      return badRequest(res, 'cwd path does not exist or is not a directory');
    }
  }

  const config = SHELL_CONFIGS[shellType] || SHELL_CONFIGS.default;
  const startCwd = cwd || process.env.HOME || process.env.USERPROFILE || '/';

  const id = nextPaneId();
  const num = nextNumForProject(currentProjectId);
  const title = String(num);

  spawnGlobalPty(id, config.command, config.args, config.env, 80, 24, true, false, startCwd);

  const paneInfo: PaneInfo = { id, shellType, title, num, cwd: startCwd, projectId: currentProjectId };
  dashboardState.panes.push(paneInfo);
  dashboardState.activePaneId = id;
  getShellNsp()?.emit('state:pane-added', paneInfo);
  getShellNsp()?.emit('state:active-pane', { paneId: id });

  res.status(201).json(paneInfo);
}));

// DELETE /panes/:id — close a terminal pane
router.delete('/panes/:id', (req: Request, res: Response) => {
  const params = paneIdParamSchema.safeParse(req.params);
  if (!params.success) {
    return badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
  }
  const paneId = params.data.id;
  const entry = globalPtys.get(paneId);
  const existed = dashboardState.panes.some((p) => p.id === paneId);

  if (!entry && !existed) {
    return notFound(res, 'Pane not found');
  }

  if (entry) {
    killPty(entry.ptyProcess);
    globalPtys.delete(paneId);
  }

  // Notify chat before removing the pane (need projectId from pane info)
  const closingPane = dashboardState.panes.find((p) => p.id === paneId);
  onChatPaneClosed(paneId, closingPane?.projectId ?? null);

  const closedIdx = dashboardState.panes.findIndex((p) => p.id === paneId);
  dashboardState.panes = dashboardState.panes.filter((p) => p.id !== paneId);
  getShellNsp()?.emit('state:pane-removed', { id: paneId });

  paneActiveSocket.delete(paneId);
  if (socketDimensions) {
    for (const dims of socketDimensions.values()) dims.delete(paneId);
  }

  renumberPanes();
  if (dashboardState.panes.length > 0) {
    getShellNsp()?.emit(
      'state:panes-renumbered',
      dashboardState.panes.map(({ id, num }) => ({ id, num })),
    );
  }

  const prevIdx = Math.max(0, closedIdx - 1);
  const nextPane = dashboardState.panes.length > 0 ? dashboardState.panes[prevIdx].id : null;

  if (dashboardState.activeTab === paneId) {
    const next = nextPane ?? 'grid';
    dashboardState.activeTab = next;
    dashboardState.activePaneId = nextPane;
    getShellNsp()?.emit('state:active-tab', { tabId: next });
  }

  dashboardState.activePaneId = nextPane;
  getShellNsp()?.emit('state:active-pane', { paneId: nextPane });

  res.json({ ok: true, message: `Pane ${paneId} closed` });
});

// POST /panes/:id/run — send a command to a terminal pane and return output
router.post('/panes/:id/run', asyncHandler(async (req: Request, res: Response) => {
  const params = paneIdParamSchema.safeParse(req.params);
  if (!params.success) {
    return badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
  }
  const paneId = params.data.id;
  const parsed = runCommandSchema.safeParse(req.body);
  if (!parsed.success) {
    return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { command, timeout } = parsed.data;

  const entry = globalPtys.get(paneId);
  if (!entry) {
    return notFound(res, 'Pane not found');
  }

  const maxMs = Math.min((timeout ?? 3) * 1000, 30000);
  const beforeLen = entry.totalLen;

  entry.ptyProcess.write(command + '\r');

  // Poll for output quiescence
  let lastLen = beforeLen;
  let stableCount = 0;
  const POLL_MS = 100;
  const STABLE_THRESHOLD = 3;

  await new Promise<void>((resolve) => {
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += POLL_MS;
      const currentLen = entry.totalLen;
      if (currentLen > lastLen) {
        lastLen = currentLen;
        stableCount = 0;
      } else {
        stableCount++;
      }
      if (stableCount >= STABLE_THRESHOLD || elapsed >= maxMs) {
        clearInterval(interval);
        resolve();
      }
    }, POLL_MS);
  });

  const fullOutput = entry.chunks.join('');
  let newOutput = fullOutput.slice(Math.min(beforeLen, fullOutput.length));

  // Strip echoed command and ANSI escapes
  const lines = newOutput.split('\n');
  if (lines.length > 1) lines.shift();
  newOutput = lines.join('\n').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

  res.json({ output: newOutput || '(no output)' });
}));

// GET /panes/:id/scrollback — get recent scrollback from a pane
router.get('/panes/:id/scrollback', (req: Request, res: Response) => {
  const params = paneIdParamSchema.safeParse(req.params);
  if (!params.success) {
    return badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
  }
  const paneId = params.data.id;
  const entry = globalPtys.get(paneId);

  if (!entry) {
    return notFound(res, 'Pane not found');
  }

  const qp = scrollbackQuerySchema.safeParse(req.query);
  const limit = qp.success ? qp.data.lines : 100;
  const fullOutput = entry.chunks.join('');
  const allLines = fullOutput.split('\n');
  const recent = allLines.slice(-limit).join('\n');

  res.json({ output: recent || '(empty)' });
});
