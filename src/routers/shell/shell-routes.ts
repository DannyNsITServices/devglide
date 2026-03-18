import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { getActiveProject } from '../../project-context.js';
import {
  globalPtys,
  dashboardState,
  getShellNsp,
  MAX_PANES,
  nextPaneId,
  paneActiveSocket,
  socketDimensions,
  renumberPanes,
} from './shell-state.js';
import { SHELL_CONFIGS } from './shell-config.js';
import { killPty, spawnGlobalPty } from './pty-manager.js';
import type { PaneInfo } from '../../apps/shell/src/shell-types.js';

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

// ── Proxy SSRF protection ────────────────────────────────────────────────────

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'metadata.google.internal']);

function isBlockedUrl(urlStr: string): string | null {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only HTTP/HTTPS allowed';
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) return 'Blocked host';
  // Block private/internal IP ranges
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    const [a, b] = parts;
    if (a === 10) return 'Private IP blocked';
    if (a === 172 && b >= 16 && b <= 31) return 'Private IP blocked';
    if (a === 192 && b === 168) return 'Private IP blocked';
    if (a === 169 && b === 254) return 'Link-local IP blocked';
    if (a === 127) return 'Loopback IP blocked';
    if (a === 0) return 'Invalid IP blocked';
  }
  return null;
}

// ── HTTP Router ──────────────────────────────────────────────────────────────

export const router: Router = Router();

// ── Preview route — serve static files from active project ─────────────────

router.use('/preview', (req: Request, res: Response, next: NextFunction) => {
  const projectPath = getActiveProject()?.path;
  if (!projectPath) return res.status(404).json({ error: 'No active project' });

  const reqPath = decodeURIComponent(req.path).replace(/^\//, '') || 'index.html';
  if (reqPath.includes('\0') || /\.\.[\\/]/.test(reqPath)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  let resolved = path.resolve(projectPath, reqPath);
  if (!resolved.startsWith(projectPath)) {
    return res.status(403).json({ error: 'Path traversal denied' });
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

router.get('/proxy', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string | undefined;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  const blocked = isBlockedUrl(targetUrl);
  if (blocked) return res.status(403).json({ error: blocked });

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0',
        'Accept': 'text/html,*/*',
        'Accept-Language': (req.headers['accept-language'] as string) || 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    const html: string = await upstream.text();
    res.setHeader('X-Final-URL', upstream.url);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(html);
  } catch (err: unknown) {
    res.status(502).json({ error: (err as Error).message });
  }
});

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

// POST /panes — create a new terminal pane
router.post('/panes', (req: Request, res: Response) => {
  const { shellType = 'default', cwd } = req.body ?? {};

  if (globalPtys.size >= MAX_PANES) {
    res.status(409).json({ error: `Maximum pane limit (${MAX_PANES}) reached` });
    return;
  }

  if (cwd) {
    if (!path.isAbsolute(cwd) || cwd.includes('\0') || /\.\.[\\/]/.test(cwd)) {
      res.status(400).json({ error: 'Invalid cwd: must be absolute without traversal or null bytes' });
      return;
    }
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      res.status(400).json({ error: 'cwd path does not exist or is not a directory' });
      return;
    }
  }

  const config = SHELL_CONFIGS[shellType] || SHELL_CONFIGS.default;
  const startCwd = cwd || process.env.HOME || process.env.USERPROFILE || '/';

  try {
    const id = nextPaneId();
    const num = dashboardState.panes.length + 1;
    const title = String(num);

    spawnGlobalPty(id, config.command, config.args, config.env, 80, 24, true, false, startCwd);

    const paneInfo: PaneInfo = { id, shellType, title, num, cwd: startCwd, projectId: getActiveProject()?.id || null };
    dashboardState.panes.push(paneInfo);
    dashboardState.activePaneId = id;
    getShellNsp()?.emit('state:pane-added', paneInfo);
    getShellNsp()?.emit('state:active-pane', { paneId: id });

    res.status(201).json(paneInfo);
  } catch (err: unknown) {
    res.status(500).json({ error: `Failed to start ${shellType}: ${(err as Error).message}` });
  }
});

// DELETE /panes/:id — close a terminal pane
router.delete('/panes/:id', (req: Request, res: Response) => {
  const paneId = req.params.id;
  const entry = globalPtys.get(paneId);
  const existed = dashboardState.panes.some((p) => p.id === paneId);

  if (!entry && !existed) {
    res.status(404).json({ error: 'Pane not found' });
    return;
  }

  if (entry) {
    killPty(entry.ptyProcess);
    globalPtys.delete(paneId);
  }

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
router.post('/panes/:id/run', async (req: Request, res: Response) => {
  const paneId = req.params.id;
  const { command, timeout } = req.body ?? {};

  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: 'command is required' });
    return;
  }

  const entry = globalPtys.get(paneId);
  if (!entry) {
    res.status(404).json({ error: 'Pane not found' });
    return;
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
});

// GET /panes/:id/scrollback — get recent scrollback from a pane
router.get('/panes/:id/scrollback', (req: Request, res: Response) => {
  const paneId = req.params.id;
  const entry = globalPtys.get(paneId);

  if (!entry) {
    res.status(404).json({ error: 'Pane not found' });
    return;
  }

  const limit = parseInt(req.query.lines as string, 10) || 100;
  const fullOutput = entry.chunks.join('');
  const allLines = fullOutput.split('\n');
  const recent = allLines.slice(-limit).join('\n');

  res.json({ output: recent || '(empty)' });
});
