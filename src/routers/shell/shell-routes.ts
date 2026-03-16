import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { getActiveProject } from '../../project-context.js';

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
