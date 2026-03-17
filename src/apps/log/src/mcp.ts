import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { createDevglideMcpServer } from "../../../packages/mcp-utils/src/index.js";
import { LogWriter } from "./services/log-writer.js";
import { getTargetPaths } from "./routes/log.js";
import { LOGS_DIR } from "../../../packages/paths.js";

const LOG_ROOT = LOGS_DIR;
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

const logWriter = new LogWriter();

export function createLogMcpServer() {
  const server = createDevglideMcpServer(
    "devglide-log",
    "0.1.0",
    "Browser console capture and log streaming. " +
    "The unified server serves GET /devtools.js — a central bootstrap for external apps. " +
    "Add <script src=\"http://localhost:7000/devtools.js\"></script> to any external app " +
    "to inject console-sniffer and scenario-runner. The active project context provides the target automatically."
  );

  server.tool(
    "log_write",
    "Append a log entry to a JSONL file",
    {
      targetPath: z.string().describe("Absolute path to the JSONL log file"),
      type: z.string().optional().describe("Log type (e.g. LOG, ERROR, WARN). Default: LOG"),
      message: z.string().optional().describe("Log message"),
      source: z.string().optional().describe("Source file"),
      line: z.number().optional().describe("Line number"),
      col: z.number().optional().describe("Column number"),
      stack: z.string().optional().describe("Stack trace"),
    },
    async ({ targetPath, type, message, source, line, col, stack }) => {
      const safePath = safeLogPath(targetPath);
      const entry: Record<string, unknown> = {
        type: type || "LOG",
        ts: new Date().toISOString(),
      };
      if (message) entry.message = message;
      if (source) entry.source = source;
      if (line !== undefined) entry.line = line;
      if (col !== undefined) entry.col = col;
      if (stack) entry.stack = stack;

      await logWriter.append(safePath, entry);
      return { content: [{ type: "text" as const, text: "Log entry written." }] };
    }
  );

  server.tool(
    "log_clear",
    "Truncate a JSONL log file",
    {
      targetPath: z.string().describe("Absolute path to the JSONL log file"),
    },
    async ({ targetPath }) => {
      const safePath = safeLogPath(targetPath);
      await logWriter.clear(safePath);
      return {
        content: [{ type: "text" as const, text: `Log file cleared: ${safePath}` }],
      };
    }
  );

  server.tool(
    "log_clear_all",
    "Truncate log files for all currently tracked sessions",
    {},
    async () => {
      const paths = getTargetPaths();
      await Promise.all(paths.map((p) => logWriter.clear(p).catch(() => {})));
      return {
        content: [
          { type: "text" as const, text: `Cleared ${paths.length} log file(s): ${paths.join(", ") || "(none)"}` },
        ],
      };
    }
  );

  server.tool(
    "log_read",
    "Read recent log entries from a JSONL file",
    {
      targetPath: z.string().describe("Absolute path to the JSONL log file"),
      lines: z.number().optional().describe("Number of recent lines to return (default: 50)"),
    },
    async ({ targetPath, lines }) => {
      const safePath = safeLogPath(targetPath);
      const limit = lines ?? 50;
      try {
        const content = await fs.readFile(safePath, "utf-8");
        const allLines = content.trim().split("\n").filter(Boolean);
        const recent = allLines.slice(-limit);
        return {
          content: [{ type: "text" as const, text: recent.join("\n") || "(empty)" }],
        };
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: [{ type: "text" as const, text: "(file does not exist)" }] };
        }
        throw err;
      }
    }
  );

  return server;
}
