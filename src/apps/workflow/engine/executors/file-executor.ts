import fs from 'fs/promises';
import path from 'path';
import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, FileConfig } from '../../types.js';

async function safePath(reqPath: string, root: string): Promise<string> {
  const abs = path.resolve(root, reqPath.replace(/^\/+/, ''));
  if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('Path traversal denied');

  // Resolve symlinks to prevent symlink-based traversal.
  // For non-existing targets (write/append), walk up to the nearest existing ancestor.
  const realRoot = await fs.realpath(root);
  let check = abs;
  while (true) {
    try {
      const real = await fs.realpath(check);
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

export const fileExecutor: ExecutorFunction = async (
  config: NodeConfig,
  _context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as FileConfig;
  const root = _context.project?.path ?? process.cwd();

  try {
    const target = await safePath(cfg.path, root);

    switch (cfg.operation) {
      case 'read': {
        const content = await fs.readFile(target, 'utf-8');
        return { status: 'passed', output: content };
      }

      case 'write': {
        if (cfg.content === undefined) {
          return { status: 'failed', error: 'content is required for write' };
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, cfg.content, 'utf-8');
        return { status: 'passed', output: `Written to ${target}` };
      }

      case 'append': {
        if (cfg.content === undefined) {
          return { status: 'failed', error: 'content is required for append' };
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, cfg.content, 'utf-8');
        return { status: 'passed', output: `Appended to ${target}` };
      }

      case 'exists': {
        try {
          await fs.access(target);
          return { status: 'passed', output: true };
        } catch {
          return { status: 'passed', output: false };
        }
      }

      case 'tree': {
        const entries = await fs.readdir(target, { withFileTypes: true });
        const listing = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
        return { status: 'passed', output: listing };
      }

      default:
        return { status: 'failed', error: `Unknown file operation: ${(cfg as FileConfig).operation}` };
    }
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
};
