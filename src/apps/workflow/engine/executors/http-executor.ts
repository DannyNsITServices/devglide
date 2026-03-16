import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, HttpConfig } from '../../types.js';

const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0',
  'metadata.google.internal', '169.254.169.254',
]);

function isBlockedUrl(urlStr: string): string | null {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only HTTP/HTTPS allowed';
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) return `Blocked host: ${hostname}`;
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    const [a, b] = parts;
    if (a === 10) return 'Private IP blocked';
    if (a === 172 && b >= 16 && b <= 31) return 'Private IP blocked';
    if (a === 192 && b === 168) return 'Private IP blocked';
    if (a === 169 && b === 254) return 'Link-local IP blocked';
    if (a === 127) return 'Loopback IP blocked';
  }
  return null;
}

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

    const blocked = isBlockedUrl(cfg.url);
    if (blocked) {
      return { status: 'failed', error: `SSRF blocked: ${blocked}` };
    }

    const init: RequestInit = {
      method: cfg.method,
      headers: cfg.headers,
    };

    if (cfg.body && cfg.method !== 'GET') {
      init.body = cfg.body;
    }

    const response = await fetch(cfg.url, init);
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
