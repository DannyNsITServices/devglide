import { spawn } from 'child_process';
import path from 'path';
import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, ShellConfig } from '../../types.js';

const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

const ENV_DENYLIST = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const shellExecutor: ExecutorFunction = async (
  config: NodeConfig,
  context: ExecutionContext,
  emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as ShellConfig;

  try {
    const basePath = context.project?.path ?? process.cwd();
    const cwd = cfg.cwd ? path.resolve(basePath, cfg.cwd) : basePath;

    const env = { ...process.env };
    if (cfg.env) {
      for (const [key, value] of Object.entries(cfg.env)) {
        if (!ENV_DENYLIST.has(key.toUpperCase())) {
          env[key] = value;
        }
      }
    }

    const ac = new AbortController();

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const child = spawn(cfg.command, {
        shell: true,
        cwd,
        env,
        signal: ac.signal,
      });

      const timer = setTimeout(() => {
        ac.abort();
      }, DEFAULT_TIMEOUT);

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;

      child.stdout?.on('data', (data: Buffer) => {
        totalBytes += data.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          ac.abort();
          return;
        }
        const chunk = data.toString();
        stdout += chunk;
        emit({ type: 'output', nodeId: context.runId, data: chunk });
      });

      child.stderr?.on('data', (data: Buffer) => {
        totalBytes += data.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          ac.abort();
          return;
        }
        const chunk = data.toString();
        stderr += chunk;
        emit({ type: 'output', nodeId: context.runId, data: chunk });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          resolve({ stdout, stderr, exitCode: 137 });
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });

    const output = (result.stdout + result.stderr).trim();
    const variables: Record<string, unknown> = {};
    if (cfg.captureOutput && cfg.outputVariable) {
      variables[cfg.outputVariable] = output;
    }

    return {
      status: result.exitCode === 0 ? 'passed' : 'failed',
      output,
      exitCode: result.exitCode,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    };
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
};
