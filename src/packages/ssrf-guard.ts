/**
 * Shared SSRF (Server-Side Request Forgery) guard.
 *
 * Validates URLs before outbound fetches by:
 *  1. Checking the URL string for blocked protocols and known-bad hostnames
 *  2. Resolving the hostname via DNS and rejecting private/internal IPs
 *
 * Also provides `safeFetch()` which additionally handles redirects safely
 * by re-validating each Location header before following it.
 */

import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';

// ── Blocked hostnames (cloud metadata endpoints, loopback aliases, etc.) ─────

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
  'metadata.google.internal',
  '169.254.169.254',
]);

// ── IP classification ────────────────────────────────────────────────────────

/**
 * Returns `true` when `ip` belongs to a loopback, private, link-local, or
 * otherwise non-routable range.  Handles both IPv4 and IPv6 addresses.
 */
function isPrivateIP(ip: string): boolean {
  // --- IPv4 ---
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                              // 0.0.0.0/8
    if (a === 10) return true;                             // 10.0.0.0/8
    if (a === 127) return true;                            // 127.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local
    return false;
  }

  // --- IPv6 ---
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;                 // loopback
    if (normalized === '::') return true;                  // unspecified
    if (normalized.startsWith('fe80:')) return true;       // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    const v4match = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4match) return isPrivateIP(v4match[1]);
    return false;
  }

  // If we can't classify it, block defensively
  return true;
}

// ── URL validation ───────────────────────────────────────────────────────────

/**
 * Validates that `urlString` is safe to fetch.
 *
 * 1. Parses the URL and rejects non-HTTP(S) schemes.
 * 2. Rejects hostnames in the static blocked set.
 * 3. Resolves the hostname via DNS and rejects private/internal IPs.
 *
 * Returns the resolved IP address (or `null` for literal-IP URLs) so callers
 * can pin subsequent fetches to the validated IP, closing the DNS TOCTOU gap.
 *
 * Throws an `Error` describing the reason when the URL is unsafe.
 */
async function validateUrl(urlString: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS allowed');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }

  // If the hostname is already a literal IP, validate it directly
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new Error(`Blocked IP: ${hostname}`);
    }
    return null;
  }

  // Resolve hostname and check the resulting IP
  let resolved: { address: string; family: number };
  try {
    resolved = await dns.promises.lookup(hostname);
  } catch {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }

  if (isPrivateIP(resolved.address)) {
    throw new Error(`DNS rebinding blocked: ${hostname} resolved to private IP ${resolved.address}`);
  }

  return resolved.address;
}

// ── Safe fetch with redirect validation ──────────────────────────────────────

const MAX_REDIRECTS = 5;

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect'> {
  /** Maximum number of redirects to follow (default: 5). */
  maxRedirects?: number;
}

/** Execute an HTTPS request with a custom agent for DNS pinning. */
function httpsRequestPinned(
  url: string,
  headers: Headers,
  options: SafeFetchOptions,
  agent: https.Agent,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => { headerObj[k] = v; });

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: (options as RequestInit).method || 'GET',
        headers: headerObj,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) responseHeaders.set(key, Array.isArray(val) ? val.join(', ') : val);
          }
          resolve(new Response(body, {
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }));
        });
      },
    );
    req.on('error', reject);
    if (options.body && typeof options.body === 'string') req.write(options.body);
    req.end();
  });
}

/**
 * Wrapper around `fetch()` that:
 * - Validates the initial URL (including DNS resolution)
 * - Pins HTTP and HTTPS requests to the resolved IP to close the DNS TOCTOU gap
 * - Uses `redirect: 'manual'` so we can intercept 3xx responses
 * - Re-validates each redirect Location before following it
 * - Enforces a maximum redirect count
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { maxRedirects = MAX_REDIRECTS, ...fetchOptions } = options;
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const resolvedIp = await validateUrl(currentUrl);

    // Pin HTTP/HTTPS requests to the resolved IP to prevent DNS rebinding TOCTOU
    let fetchUrl = currentUrl;
    const mergedHeaders = new Headers(fetchOptions.headers);

    let fetchRequestInit: RequestInit & { dispatcher?: unknown } = {
      ...fetchOptions,
      headers: mergedHeaders,
      redirect: 'manual' as const,
    };

    if (resolvedIp) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol === 'http:') {
        // HTTP: replace hostname with resolved IP, set Host header
        mergedHeaders.set('Host', parsed.host);
        parsed.hostname = net.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
        fetchUrl = parsed.href;
      } else if (parsed.protocol === 'https:') {
        // HTTPS: pin DNS lookup via custom Agent to prevent rebinding TOCTOU
        const pinnedAgent = new https.Agent({
          servername: parsed.hostname,
          lookup: (_hostname, _opts, cb) => {
            cb(null, resolvedIp, net.isIPv6(resolvedIp) ? 6 : 4);
          },
        });
        // Node undici-based fetch doesn't accept `agent` directly;
        // fall back to node:https request for pinned HTTPS connections.
        const pinnedResponse = await httpsRequestPinned(fetchUrl, mergedHeaders, fetchOptions, pinnedAgent);
        if (pinnedResponse.status >= 300 && pinnedResponse.status < 400) {
          const location = pinnedResponse.headers.get('location');
          if (!location) throw new Error(`Redirect ${pinnedResponse.status} without Location header`);
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
        return pinnedResponse;
      }
    }

    const response = await fetch(fetchUrl, fetchRequestInit);

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect ${status} without Location header`);
      }

      // Resolve relative redirects against the original (non-pinned) URL
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (max ${maxRedirects})`);
}
