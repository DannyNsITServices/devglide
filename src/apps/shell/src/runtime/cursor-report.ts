import type { PtyEntry } from '../shell-types.js';

export const CURSOR_REPORT_REQUEST_TTL_MS = 2_000;

const CURSOR_REPORT_REQUEST_RE = /\x1b\[(?:\?6|6)n/g;
const CURSOR_REPORT_RESPONSE_RE = /\x1b\[\??\d+;\d+R/g;
const CURSOR_REPORT_RESPONSE_ONLY_RE = /^(?:\x1b\[\??\d+;\d+R)+$/;
const CURSOR_REPORT_REQUEST_PREFIXES = ['\x1b[?6', '\x1b[6', '\x1b[?', '\x1b[', '\x1b'];

function countMatches(re: RegExp, value: string): number {
  return [...value.matchAll(re)].length;
}

function trailingCursorReportRequestPrefix(value: string): string {
  for (const prefix of CURSOR_REPORT_REQUEST_PREFIXES) {
    if (value.endsWith(prefix)) return prefix;
  }
  return '';
}

export function noteCursorReportRequests(entry: PtyEntry, data: string, now = Date.now()): void {
  const carry = entry.cursorReportRequestCarry ?? '';
  const combined = carry + data;
  const requestCount = countMatches(CURSOR_REPORT_REQUEST_RE, combined);

  if (requestCount > 0) {
    entry.pendingCursorReportRequests = (entry.pendingCursorReportRequests ?? 0) + requestCount;
    entry.lastCursorReportRequestAt = now;
  }

  entry.cursorReportRequestCarry = trailingCursorReportRequestPrefix(combined);
}

export function countStandaloneCursorReportResponses(data: string): number {
  if (!CURSOR_REPORT_RESPONSE_ONLY_RE.test(data)) return 0;
  return countMatches(CURSOR_REPORT_RESPONSE_RE, data);
}

export function consumePendingCursorReportRequests(entry: PtyEntry, count: number, now = Date.now()): boolean {
  const pending = entry.pendingCursorReportRequests ?? 0;
  const lastRequestAt = entry.lastCursorReportRequestAt ?? 0;

  if (pending <= 0) return false;
  if (now - lastRequestAt > CURSOR_REPORT_REQUEST_TTL_MS) {
    entry.pendingCursorReportRequests = 0;
    return false;
  }
  if (pending < count) return false;

  entry.pendingCursorReportRequests = pending - count;
  return true;
}
