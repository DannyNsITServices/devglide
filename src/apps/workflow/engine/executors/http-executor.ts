import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, HttpConfig } from '../../types.js';
import { safeFetch, type SafeFetchOptions } from '../../../../packages/ssrf-guard.js';

export const httpExecutor: ExecutorFunction = async (
  config: NodeConfig,
  _context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as HttpConfig;

  try {
    if (!cfg.url) {
      return { status: 'failed', error: 'url is required' };
    }

    const init: SafeFetchOptions = {
      method: cfg.method,
      headers: cfg.headers,
    };

    if (cfg.body && cfg.method !== 'GET') {
      init.body = cfg.body;
    }

    const response = await safeFetch(cfg.url, init);
    const body = await response.text();
    const ok = response.status >= 200 && response.status < 300;

    return {
      status: ok ? 'passed' : 'failed',
      output: body,
      exitCode: response.status,
      error: ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
};
