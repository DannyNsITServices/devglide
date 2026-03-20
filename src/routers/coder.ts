import { Router } from 'express';
import fs from 'fs';
import type { Dirent } from 'fs';
import { open, readFile, writeFile, readdir, stat, realpath } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { getActiveProject } from '../project-context.js';
import { asyncHandler, errorMessage } from '../packages/error-middleware.js';

// ── Zod schema for HTTP input validation ─────────────────────────────────────

const writeFileSchema = z.object({
  root: z.string().optional(),
  path: z.string().min(1, 'path is required'),
  content: z.string().default(''),
});

const treeQuerySchema = z.object({
  root: z.string().optional(),
});

const fileQuerySchema = z.object({
  root: z.string().optional(),
  path: z.string().optional(),
});

export const router: Router = Router();

const SKIP = new Set([
  'node_modules', '.git', 'dist', '.next', '.turbo',
  '__pycache__', '.pnpm-store', 'pnpm-store', '.cache',
  'build', 'coverage', '.nyc_output', '.venv', 'venv',
]);

const MAX_TREE_ENTRIES = 5000;

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function safeRoot(reqRoot: string | undefined): Promise<string> {
  if (!reqRoot) return getActiveProject()?.path || MONOREPO_ROOT;
  const resolved = path.resolve(reqRoot);
  const allowed = getActiveProject()?.path || MONOREPO_ROOT;
  if (resolved !== allowed && !resolved.startsWith(allowed + path.sep)) {
    throw new Error('Root path outside allowed directory');
  }
  return resolved;
}

async function safePath(reqPath: string | undefined, root: string): Promise<string> {
  const abs = path.resolve(root, (reqPath || '').replace(/^\/+/, ''));
  if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('Path traversal denied');

  // Resolve symlinks to prevent symlink-based traversal.
  // For non-existing targets (write), walk up to the nearest existing ancestor.
  const realRoot = await realpath(root);
  let check = abs;
  while (true) {
    try {
      const real = await realpath(check);
      if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
        throw new Error('Symlink traversal denied');
      }
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(check);
      if (parent === check) break; // hit filesystem root
      check = parent;
    }
  }

  return abs;
}

interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: TreeEntry[];
}

async function buildTree(
  dir: string,
  depth: number = 0,
  root: string,
  counter: { count: number } = { count: 0 },
): Promise<TreeEntry[]> {
  if (depth > 8 || counter.count >= MAX_TREE_ENTRIES) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs: Dirent[] = [];
  const files: Dirent[] = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isDirectory()) dirs.push(entry);
    else files.push(entry);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const result: TreeEntry[] = [];

  // Process directories in parallel
  const dirResults = await Promise.all(dirs.map(async (entry) => {
    if (counter.count >= MAX_TREE_ENTRIES) return null;
    const abs = path.join(dir, entry.name);
    counter.count++;
    return {
      name: entry.name,
      path: path.relative(root, abs),
      type: 'dir' as const,
      children: await buildTree(abs, depth + 1, root, counter),
    };
  }));
  for (const d of dirResults) {
    if (d) result.push(d);
  }

  // Process files
  for (const entry of files) {
    if (counter.count >= MAX_TREE_ENTRIES) break;
    counter.count++;
    result.push({ name: entry.name, path: path.relative(root, path.join(dir, entry.name)), type: 'file' });
  }
  return result;
}

async function isBinary(filePath: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fh?.close();
  }
}

function badRequest(res: { status: (code: number) => { json: (body: unknown) => void } }, message: string): void {
  res.status(400).json({ error: message });
}

function forbidden(res: { status: (code: number) => { json: (body: unknown) => void } }, message: string): void {
  res.status(403).json({ error: message });
}

router.get('/tree', asyncHandler(async (req, res) => {
  try {
    const qp = treeQuerySchema.safeParse(req.query);
    const root = await safeRoot(qp.success ? qp.data.root : undefined);
    if (!fs.existsSync(root)) return badRequest(res, 'Root path does not exist');
    res.json(await buildTree(root, 0, root));
  } catch (err: unknown) {
    const message = errorMessage(err);
    const status = message.includes('outside allowed') || message.includes('traversal') ? 403 : 500;
    if (status === 403) {
      forbidden(res, message);
      return;
    }
    throw err;
  }
}));

router.get('/file', asyncHandler(async (req, res) => {
  try {
    const qp = fileQuerySchema.safeParse(req.query);
    const root = await safeRoot(qp.success ? qp.data.root : undefined);
    const abs = await safePath(qp.success ? qp.data.path : undefined, root);
    const s = await stat(abs);
    if (s.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>2MB)' });
    if (await isBinary(abs)) return res.status(422).json({ error: 'Binary file cannot be displayed' });
    const content = await readFile(abs, 'utf8');
    res.json({ content });
  } catch (err: unknown) {
    const message = errorMessage(err);
    const status = message.includes('traversal') ? 403 : 500;
    if (status === 403) {
      forbidden(res, message);
      return;
    }
    throw err;
  }
}));

router.put('/file', asyncHandler(async (req, res) => {
  try {
    const parsed = writeFileSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
      return;
    }
    const root = await safeRoot(parsed.data.root);
    const abs = await safePath(parsed.data.path, root);
    await writeFile(abs, parsed.data.content, 'utf8');
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = errorMessage(err);
    const status = message.includes('traversal') ? 403 : 500;
    if (status === 403) {
      forbidden(res, message);
      return;
    }
    throw err;
  }
}));
