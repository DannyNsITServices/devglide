/**
 * Server-side console sniffer for Devglide apps.
 * Writes log entries directly to disk and forwards them to the Log service.
 *
 * Usage:
 *   import { initServerSniffer } from '@devglide/log/server-sniffer';
 *   initServerSniffer({ service: 'kanban', targetPath: '/abs/path/server.log' });
 */

import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";


interface ServerSnifferOptions {
  /** Service name (e.g. 'kanban', 'voice') */
  service: string;
  /** Absolute path to the JSONL log file */
  targetPath: string;
  /** Log service port (default: 7001) */
  logPort?: number;
}

let _initialized = false;

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

  function writeEntry(entry: Record<string, unknown>): void {
    try {
      appendFileSync(targetPath, JSON.stringify(entry) + "\n");
    } catch {}
  }

  function forward(entry: Record<string, unknown>): void {
    fetch(`${baseUrl}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(500),
    }).catch(() => {});
  }

  function send(type: string, args: unknown[]): void {
    const message = args
      .map((a) => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(" ");

    const entry: Record<string, unknown> = {
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

  // Truncate log file and write SESSION_START directly
  const sessionStart: Record<string, unknown> = {
    type: "SESSION_START",
    session: sessionId,
    seq: seq++,
    ts: new Date().toISOString(),
    url: `server://${service}`,
    ua: `node/${process.version}`,
    persistent: true,
  };
  writeFileSync(targetPath, JSON.stringify(sessionStart) + "\n");
  forward({ ...sessionStart, targetPath });

  console.log = function (...args: unknown[]) {
    origLog.apply(console, args);
    send("SERVER_LOG", args);
  };

  console.warn = function (...args: unknown[]) {
    origWarn.apply(console, args);
    send("SERVER_WARN", args);
  };

  console.error = function (...args: unknown[]) {
    origError.apply(console, args);
    send("SERVER_ERROR", args);
  };

  process.on("uncaughtException", (err) => {
    send("SERVER_ERROR", [`Uncaught Exception: ${err.message}\n${err.stack || ""}`]);
    // Allow the write to complete, then exit
    setTimeout(() => process.exit(1), 1000).unref();
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error
      ? `Unhandled Rejection: ${reason.message}\n${reason.stack || ""}`
      : `Unhandled Rejection: ${String(reason)}`;
    send("SERVER_ERROR", [msg]);
  });
}
