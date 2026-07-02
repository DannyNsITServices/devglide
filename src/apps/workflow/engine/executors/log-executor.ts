import fs from 'fs/promises';
import path from 'path';
import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, LogConfig } from '../../types.js';
import { LogWriter } from '../../../../apps/log/src/services/log-writer.js';
import { safePath } from './file-executor.js';

const writer = new LogWriter();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveLogPath(projectPath: string | undefined, targetPath?: string): Promise<string> {
  const base = projectPath ?? process.cwd();
  // Contain custom target paths within the project root (same guard as file-executor)
  if (targetPath) return safePath(targetPath, base);
  return path.join(base, '.devglide', 'logs', 'workflow.jsonl');
}

export const logExecutor: ExecutorFunction = async (
  config: NodeConfig,
  _context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as LogConfig;

  try {
    switch (cfg.operation) {
      case 'write': {
        if (!cfg.message) {
          return { status: 'failed', error: 'message is required for write' };
        }
        const targetPath = await resolveLogPath(_context.project?.path, cfg.targetPath);
        await writer.append(targetPath, {
          type: cfg.type || 'WORKFLOW',
          ts: new Date().toISOString(),
          message: cfg.message,
          source: 'workflow',
        });
        return { status: 'passed', output: `Logged to ${targetPath}` };
      }

      case 'read': {
        const targetPath = await resolveLogPath(_context.project?.path, cfg.targetPath);
        const lines = cfg.lines ?? 50;
        try {
          const content = await fs.readFile(targetPath, 'utf-8');
          const allLines = content.split('\n').filter(Boolean);
          const tail = allLines.slice(-lines);
          return { status: 'passed', output: tail.join('\n') };
        } catch {
          return { status: 'passed', output: '' };
        }
      }

      case 'clear': {
        const targetPath = await resolveLogPath(_context.project?.path, cfg.targetPath);
        await writer.clear(targetPath);
        return { status: 'passed', output: `Cleared ${targetPath}` };
      }

      default:
        return { status: 'failed', error: `Unknown log operation: ${(cfg as LogConfig).operation}` };
    }
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
};
