import { Router } from "express";
import type { Request, Response, Router as RouterType } from "express";
import fs from "fs/promises";
import path from "path";
import { LogWriter } from "../services/log-writer.js";
import { DEVGLIDE_DIR } from "../../../../packages/paths.js";

const LOG_ROOT = DEVGLIDE_DIR;
const ALLOWED_EXTENSIONS = new Set(['.log', '.jsonl']);

function safeLogPath(targetPath: string): string {
  const resolved = path.resolve(LOG_ROOT, targetPath.replace(/^\/+/, ''));
  if (!resolved.startsWith(LOG_ROOT + path.sep)) {
    throw new Error('Path traversal denied');
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error('Invalid log file extension');
  }
  return resolved;
}

export const logRouter: RouterType = Router();
const logWriter = new LogWriter();

// ── Session tracking ──────────────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  targetPath: string;
  url: string;
  ua: string;
  firstSeen: string;
  lastSeen: string;
  logCount: number;
  errorCount: number;
  source: "browser" | "server" | "file";
}

const STALE_MS = 5 * 60 * 1000;

const sessions = new Map<string, SessionInfo>();

// Periodic cleanup — evict stale sessions even when getSessions() isn't called
const sessionCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, session] of sessions) {
    if (new Date(session.lastSeen).getTime() < cutoff) {
      sessions.delete(id);
      if (persistentByTarget.get(session.targetPath) === id) {
        persistentByTarget.delete(session.targetPath);
      }
    }
  }
}, 60_000);
sessionCleanupTimer.unref();
// For persistent sessions: targetPath → canonical sessionId
const persistentByTarget = new Map<string, string>();
// Remap transient sessionId → canonical sessionId for persistent reconnects
const SESSION_ID_REMAP_MAX = 1000;
const sessionIdRemap = new Map<string, string>();

export function recordSession(entry: Record<string, unknown>): void {
  let sessionId = entry.session as string | undefined;
  if (!sessionId) return;

  const targetPath = (entry.targetPath as string) || "";
  const now = new Date().toISOString();
  const type = (entry.type as string) || "";
  const isPersistent = entry.persistent === true;
  const isFileType = type.startsWith("FILE_");
  const isServerType = type.startsWith("SERVER_");
  const source: "browser" | "server" | "file" = isFileType ? "file" : isServerType ? "server" : "browser";
  const isError =
    type === "ERROR" || type === "WINDOW_ERROR" || type === "UNHANDLED_REJECTION" || type === "SERVER_ERROR" || type === "FILE_ERROR";

  if (type === "SESSION_START" && isPersistent) {
    const canonicalId = persistentByTarget.get(targetPath);
    if (canonicalId && sessions.has(canonicalId)) {
      // Cap remap size to prevent unbounded growth
      if (sessionIdRemap.size >= SESSION_ID_REMAP_MAX) {
        const firstKey = sessionIdRemap.keys().next().value!;
        sessionIdRemap.delete(firstKey);
      }
      sessionIdRemap.set(sessionId, canonicalId);
      const existing = sessions.get(canonicalId)!;
      existing.lastSeen = now;
      if (entry.url) existing.url = entry.url as string;
      return;
    }
    persistentByTarget.set(targetPath, sessionId);
  }

  const remapped = sessionIdRemap.get(sessionId);
  if (remapped) sessionId = remapped;

  const isSessionMeta = type === "SESSION_START";
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeen = now;
    if (!isSessionMeta) existing.logCount++;
    if (isError) existing.errorCount++;
    if (entry.url) existing.url = entry.url as string;
  } else {
    sessions.set(sessionId, {
      sessionId,
      targetPath,
      url: (entry.url as string) || "",
      ua: (entry.ua as string) || "",
      firstSeen: now,
      lastSeen: now,
      logCount: isSessionMeta ? 0 : 1,
      errorCount: isError ? 1 : 0,
      source,
    });
  }
}

export function getSessions(): SessionInfo[] {
  const cutoff = Date.now() - STALE_MS;
  const result: SessionInfo[] = [];
  for (const [id, session] of sessions) {
    if (new Date(session.lastSeen).getTime() < cutoff) {
      sessions.delete(id);
      if (persistentByTarget.get(session.targetPath) === id) {
        persistentByTarget.delete(session.targetPath);
      }
    } else {
      result.push(session);
    }
  }
  return result.sort(
    (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
  );
}

export function getTargetPaths(): string[] {
  return [...new Set(getSessions().map((s) => s.targetPath))];
}

function resetSessionCounters(targetPath?: string): void {
  for (const session of sessions.values()) {
    if (!targetPath || session.targetPath === targetPath) {
      session.logCount = 0;
      session.errorCount = 0;
    }
  }
}

// ── Tail reader ──────────────────────────────────────────────────────────────

/** Read the last `n` non-empty lines from a file without loading the whole file. */
async function tailLines(filePath: string, n: number): Promise<string[]> {
  const stat = await fs.stat(filePath);
  const size = stat.size;
  if (size === 0) return [];

  // For small files (< 128 KB), just read the whole thing
  const SMALL_THRESHOLD = 128 * 1024;
  if (size <= SMALL_THRESHOLD) {
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim().split("\n").filter(Boolean).slice(-n);
  }

  // For larger files, read chunks from the end
  let chunkSize = 64 * 1024;
  const fh = await fs.open(filePath, "r");
  try {
    let collected: string[] = [];
    let offset = size;
    let trailing = "";

    while (offset > 0 && collected.length < n) {
      const readSize = Math.min(chunkSize, offset);
      offset -= readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, offset);
      const chunk = buf.toString("utf-8") + trailing;
      const lines = chunk.split("\n").filter(Boolean);
      collected = lines.concat(collected);
      trailing = "";
      // Double chunk size for next iteration if we still need more lines
      chunkSize = Math.min(chunkSize * 2, 1024 * 1024);
    }

    return collected.slice(-n);
  } finally {
    await fh.close();
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

interface LogRequestBody {
  type?: string;
  session?: string;
  seq?: number;
  ts?: string;
  url?: string;
  ua?: string;
  message?: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  targetPath?: string;
  persistent?: boolean;
}

/**
 * POST /api/log — Append a log entry to the target JSONL file.
 */
logRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body as LogRequestBody;
  const targetPath = body.targetPath;

  if (!targetPath || targetPath.trim() === "") {
    res.status(400).end();
    return;
  }

  const type = body.type && body.type.trim() !== "" ? body.type : "LOG";
  const ts = body.ts && body.ts.trim() !== "" ? body.ts : new Date().toISOString();

  const entry: Record<string, unknown> = { type };
  if (body.session) entry.session = body.session;
  if (body.seq !== undefined && body.seq !== null) entry.seq = body.seq;
  entry.ts = ts;
  if (body.url) entry.url = body.url;
  if (body.ua) entry.ua = body.ua;
  if (body.message) entry.message = body.message;
  if (body.source) entry.source = body.source;
  if (body.line !== undefined && body.line !== null) entry.line = body.line;
  if (body.col !== undefined && body.col !== null) entry.col = body.col;
  if (body.stack) entry.stack = body.stack;
  if (body.persistent !== undefined) entry.persistent = body.persistent;

  let safePath: string;
  try {
    safePath = safeLogPath(targetPath);
  } catch {
    res.status(403).json({ error: "Path traversal denied" });
    return;
  }

  try {
    recordSession({ ...entry, targetPath });
    // Server-side sniffers write directly to disk — skip file write to avoid duplicates.
    // Browser entries (non-persistent or non-server types) still need the log service to write.
    const isServerEntry = type.startsWith("SERVER_") || (type === "SESSION_START" && body.persistent);
    if (!isServerEntry) {
      await logWriter.append(safePath, entry);
    }
    res.status(200).end();
  } catch (err) {
    console.error("[log] Failed to write log:", (err as Error).message);
    res.status(500).end();
  }
});

/**
 * DELETE /api/log/all — Truncate log files for all tracked sessions.
 */
logRouter.delete("/all", async (_req: Request, res: Response) => {
  const paths = getTargetPaths();
  await Promise.all(paths.map((p) => logWriter.clear(p).catch(() => {})));
  resetSessionCounters();
  res.status(200).json({ cleared: paths.length });
});

/**
 * DELETE /api/log?targetPath=... — Truncate (clear) the log file.
 */
logRouter.delete("/", async (req: Request, res: Response) => {
  const targetPath = req.query.targetPath as string | undefined;

  if (!targetPath || targetPath.trim() === "") {
    res.status(400).end();
    return;
  }

  let safePath: string;
  try {
    safePath = safeLogPath(targetPath);
  } catch {
    res.status(403).json({ error: "Path traversal denied" });
    return;
  }

  try {
    await logWriter.clear(safePath);
    resetSessionCounters(targetPath);
    res.status(200).end();
  } catch (err) {
    console.error("[log] Failed to clear log:", (err as Error).message);
    res.status(500).end();
  }
});

/**
 * GET /api/log/view?targetPath=...&limit=200 — Read parsed JSONL entries.
 */
logRouter.get("/view", async (req: Request, res: Response) => {
  const targetPath = req.query.targetPath as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 500, 2000);

  if (!targetPath || targetPath.trim() === "") {
    res.status(400).json({ error: "targetPath is required" });
    return;
  }

  let safePath: string;
  try {
    safePath = safeLogPath(targetPath);
  } catch {
    res.status(403).json({ error: "Path traversal denied" });
    return;
  }

  try {
    const lines = await tailLines(safePath, limit);
    const entries = lines.map((line) => {
      try { return JSON.parse(line); } catch { return { type: "PARSE_ERROR", message: line }; }
    });
    res.json({ entries });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      res.json({ entries: [] });
      return;
    }
    res.status(500).json({ error: "Failed to read log file" });
  }
});
