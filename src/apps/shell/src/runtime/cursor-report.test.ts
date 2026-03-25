import { describe, expect, it } from 'vitest';
import type { PtyEntry } from '../shell-types.js';
import {
  CURSOR_REPORT_REQUEST_TTL_MS,
  consumePendingCursorReportRequests,
  countStandaloneCursorReportResponses,
  noteCursorReportRequests,
} from './cursor-report.js';

function makeEntry(): PtyEntry {
  return {
    ptyProcess: {} as never,
    chunks: [],
    totalLen: 0,
  };
}

describe('cursor-report', () => {
  it('tracks CPR requests written by the PTY', () => {
    const entry = makeEntry();

    noteCursorReportRequests(entry, 'prompt\x1b[6n', 100);

    expect(entry.pendingCursorReportRequests).toBe(1);
    expect(entry.lastCursorReportRequestAt).toBe(100);
    expect(entry.cursorReportRequestCarry).toBe('');
  });

  it('tracks split CPR requests across PTY chunks', () => {
    const entry = makeEntry();

    noteCursorReportRequests(entry, 'prompt\x1b[', 100);
    noteCursorReportRequests(entry, '6n', 125);

    expect(entry.pendingCursorReportRequests).toBe(1);
    expect(entry.lastCursorReportRequestAt).toBe(125);
    expect(entry.cursorReportRequestCarry).toBe('');
  });

  it('counts only standalone CPR response chunks', () => {
    expect(countStandaloneCursorReportResponses('\x1b[26;132R')).toBe(1);
    expect(countStandaloneCursorReportResponses('\x1b[12;20R\x1b[18;12R')).toBe(2);
    expect(countStandaloneCursorReportResponses('x\x1b[26;132R')).toBe(0);
    expect(countStandaloneCursorReportResponses('\x1b[26;132Rz')).toBe(0);
  });

  it('consumes pending requests for matching responses', () => {
    const entry = makeEntry();

    noteCursorReportRequests(entry, '\x1b[6n\x1b[?6n', 200);

    expect(consumePendingCursorReportRequests(entry, 2, 250)).toBe(true);
    expect(entry.pendingCursorReportRequests).toBe(0);
  });

  it('rejects unsolicited or stale CPR responses', () => {
    const entry = makeEntry();

    expect(consumePendingCursorReportRequests(entry, 1, 50)).toBe(false);

    noteCursorReportRequests(entry, '\x1b[6n', 100);

    expect(consumePendingCursorReportRequests(entry, 1, 100 + CURSOR_REPORT_REQUEST_TTL_MS + 1)).toBe(false);
    expect(entry.pendingCursorReportRequests).toBe(0);
  });
});
