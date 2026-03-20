import { spawn } from 'child_process';
import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, GitConfig } from '../../types.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const GIT_TIMEOUT_MS = 60_000; // 1 minute
const BRANCH_RE = /^[a-zA-Z0-9._/\-]+$/;

function runGit(args: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const child = spawn('git', args, { cwd, signal: ac.signal });
    const timer = setTimeout(() => ac.abort(), GIT_TIMEOUT_MS);
    let output = '';

    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        resolve({ output: output.trim() + '\n[TIMEOUT]', exitCode: 124 });
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output: output.trim(), exitCode: code ?? 1 });
    });
  });
}

/** Validate branch name — reject flag-like values and invalid characters. */
function safeBranch(name: string): string | null {
  if (!name || name.startsWith('-') || !BRANCH_RE.test(name)) return null;
  return name;
}

/** Sanitize file paths — reject flag-like values. */
function safeFiles(files: string[]): string[] | null {
  for (const f of files) {
    if (f.startsWith('-')) return null;
  }
  return files;
}

export const gitExecutor: ExecutorFunction = async (
  config: NodeConfig,
  _context: ExecutionContext,
  emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as GitConfig;
  const cwd = _context.project?.path ?? process.cwd();

  try {
    let result: { output: string; exitCode: number };

    switch (cfg.operation) {
      case 'status':
        result = await runGit(['status', '--porcelain'], cwd);
        break;

      case 'diff':
        result = await runGit(['diff'], cwd);
        break;

      case 'commit': {
        if (!cfg.message) {
          return { status: 'failed', error: 'message is required for commit' };
        }
        let addArgs: string[];
        if (cfg.files && cfg.files.length > 0) {
          const safe = safeFiles(cfg.files);
          if (!safe) return { status: 'failed', error: 'Invalid file path — must not start with -' };
          addArgs = ['add', '--', ...safe];
        } else {
          addArgs = ['add', '-A'];
        }
        const addResult = await runGit(addArgs, cwd);
        if (addResult.exitCode !== 0) {
          return { status: 'failed', output: addResult.output, exitCode: addResult.exitCode, error: addResult.output };
        }
        result = await runGit(['commit', '-m', cfg.message], cwd);
        break;
      }

      case 'push':
        result = await runGit(['push'], cwd);
        break;

      case 'branch-create': {
        if (!cfg.branch) {
          return { status: 'failed', error: 'branch is required for branch-create' };
        }
        const newBranch = safeBranch(cfg.branch);
        if (!newBranch) return { status: 'failed', error: 'Invalid branch name' };
        result = await runGit(['checkout', '-b', '--', newBranch], cwd);
        break;
      }

      case 'checkout': {
        if (!cfg.branch) {
          return { status: 'failed', error: 'branch is required for checkout' };
        }
        const target = safeBranch(cfg.branch);
        if (!target) return { status: 'failed', error: 'Invalid branch name' };
        result = await runGit(['checkout', '--', target], cwd);
        break;
      }

      case 'add': {
        let addArgs: string[];
        if (cfg.files && cfg.files.length > 0) {
          const safe = safeFiles(cfg.files);
          if (!safe) return { status: 'failed', error: 'Invalid file path — must not start with -' };
          addArgs = ['add', '--', ...safe];
        } else {
          addArgs = ['add', '-A'];
        }
        result = await runGit(addArgs, cwd);
        break;
      }

      default:
        return { status: 'failed', error: `Unknown git operation: ${(cfg as GitConfig).operation}` };
    }

    emit({ type: 'output', nodeId: _context.runId, data: result.output });

    return {
      status: result.exitCode === 0 ? 'passed' : 'failed',
      output: result.output,
      exitCode: result.exitCode,
      error: result.exitCode !== 0 ? result.output : undefined,
    };
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
};
