/**
 * Server-side console sniffer for Devglide apps.
 * Writes log entries directly to disk and forwards them to the Log service.
 *
 * Usage:
 *   import { initServerSniffer } from '../../packages/server-sniffer.js';
 *   initServerSniffer({ service: 'kanban', targetPath: '/abs/path/server.log' });
 */

import { writeFileSync, mkdirSync, createWriteStream } from 'fs';
import { dirname } from 'path';


export interface ServerSnifferOptions {
  /** Service name (e.g. 'kanban', 'voice') */
  service: string;
  /** Absolute path to the JSONL log file */
  targetPath: string;
  /** Log service port (default: 7000) */
  logPort?: number;
}

interface LogEntry {
  type: string;
  session: string;
  seq: number;
  ts: string;
  message?: string;
  url?: string;
  ua?: string;
  persistent?: boolean;
  targetPath?: string;
}

let _initialized = false;
let _logStream: ReturnType<typeof createWriteStream> | null = null;

/** Close the log stream opened by initServerSniffer. Safe to call multiple times. */
export function shutdownServerSniffer(): void {
  if (_logStream) {
    _logStream.end();
    _logStream = null;
  }
}

export function initServerSniffer(opts: ServerSnifferOptions): void {
  if (_initialized) return;
  _initialized = true;

  const { service, targetPath, logPort = 7000 } = opts;
  const baseUrl = `http://localhost:${logPort}`;
  const sessionId = `${service}-server`;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  let seq = 0;

  // Ensure target directory exists
  mkdirSync(dirname(targetPath), { recursive: true });

  // Truncate log file and write SESSION_START directly (sync, runs once)
  const sessionStart: LogEntry = {
    type: 'SESSION_START',
    session: sessionId,
    seq: seq++,
    ts: new Date().toISOString(),
    url: `server://${service}`,
    ua: `node/${process.version}`,
    persistent: true,
  };
  writeFileSync(targetPath, JSON.stringify(sessionStart) + '\n');

  // Open append stream AFTER truncation for non-blocking writes
  const logStream = createWriteStream(targetPath, { flags: 'a' });
  _logStream = logStream;
  logStream.on('error', () => {});

  function writeEntry(entry: LogEntry): void {
    logStream.write(JSON.stringify(entry) + '\n');
  }

  function forward(entry: LogEntry): void {
    fetch(`${baseUrl}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(500),
    }).catch(() => {});
  }

  forward({ ...sessionStart, targetPath });

  function send(type: string, args: unknown[]): void {
    const message = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');

    const entry: LogEntry = {
      type,
      session: sessionId,
      seq: seq++,
      ts: new Date().toISOString(),
      message,
      persistent: true,
    };

    writeEntry(entry);
    forward({ ...entry, targetPath });
  }

  console.log = function (...args: unknown[]) {
    origLog.apply(console, args);
    send('SERVER_LOG', args);
  };

  console.warn = function (...args: unknown[]) {
    origWarn.apply(console, args);
    send('SERVER_WARN', args);
  };

  console.error = function (...args: unknown[]) {
    origError.apply(console, args);
    send('SERVER_ERROR', args);
  };

  process.on('uncaughtException', (err: Error) => {
    send('SERVER_ERROR', [`Uncaught Exception: ${err.message}\n${err.stack || ''}`]);
    setTimeout(() => process.exit(1), 1000).unref();
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error
      ? `Unhandled Rejection: ${reason.message}\n${reason.stack || ''}`
      : `Unhandled Rejection: ${String(reason)}`;
    send('SERVER_ERROR', [msg]);
  });
}
