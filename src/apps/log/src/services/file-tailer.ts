import { watch, type FSWatcher } from "chokidar";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { LogWriter } from "./log-writer.js";
import { parseLine } from "./line-parser.js";
import { recordSession, getTargetPaths } from "../routes/log.js";
import {
  INCLUDE_PATTERNS,
  IGNORED_GLOBS,
  MAX_DEPTH,
  MAX_WATCHED_FILES,
  MAX_FILE_SIZE,
} from "./file-patterns.js";

function fileSessionId(filePath: string): string {
  const hash = crypto.createHash("md5").update(filePath).digest("hex").slice(0, 12);
  return `file-${hash}`;
}

function filetailTargetPath(projectPath: string, filePath: string): string {
  const basename = path.basename(filePath, ".log");
  return path.join(projectPath, `${basename}.filetail.log`);
}

export class FileTailer {
  private watcher: FSWatcher | null = null;
  private offsets = new Map<string, number>();
  private partials = new Map<string, string>();
  private changeQueues = new Map<string, Promise<void>>();
  private logWriter = new LogWriter();
  private projectPath: string | null = null;
  private watchedCount = 0;

  async start(projectPath: string): Promise<void> {
    this.stop();
    this.projectPath = projectPath;

    const globs = INCLUDE_PATTERNS.map((p) => path.join(projectPath, p));

    this.watcher = watch(globs, {
      ignored: IGNORED_GLOBS,
      depth: MAX_DEPTH,
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher.on("add", (filePath: string) => this.onAdd(filePath));
    this.watcher.on("change", (filePath: string) => this.onChange(filePath));
    this.watcher.on("unlink", (filePath: string) => this.onUnlink(filePath));
    this.watcher.on("error", (err: unknown) => {
      console.error("[file-tailer] watcher error:", (err as Error).message);
    });

    console.log(`[file-tailer] Watching for log files in ${projectPath}`);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    this.offsets.clear();
    this.partials.clear();
    this.changeQueues.clear();
    this.watchedCount = 0;
    if (this.projectPath) {
      console.log(`[file-tailer] Stopped watching ${this.projectPath}`);
    }
    this.projectPath = null;
  }

  private async onAdd(filePath: string): Promise<void> {
    if (this.watchedCount >= MAX_WATCHED_FILES) return;

    // Skip files already managed by DevGlide sniffers (browser/server)
    const absPath = path.resolve(filePath);
    const managedPaths = getTargetPaths();
    if (managedPaths.some((p) => path.resolve(p) === absPath)) {
      console.log(`[file-tailer] Skipping managed file: ${filePath}`);
      return;
    }

    try {
      const stat = await fsp.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        console.log(`[file-tailer] Skipping large file: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        return;
      }

      // Peek at first line — skip if it looks like a DevGlide JSONL file
      if (stat.size > 0 && (await this.isDevGlideJsonl(filePath))) {
        console.log(`[file-tailer] Skipping DevGlide JSONL file: ${filePath}`);
        return;
      }

      // Start from end of file — only tail new content
      this.offsets.set(filePath, stat.size);
      this.partials.set(filePath, "");
      this.watchedCount++;

      const sessionId = fileSessionId(filePath);
      const targetPath = filetailTargetPath(this.projectPath!, filePath);
      const basename = path.basename(filePath);

      const entry = {
        type: "FILE_SESSION_START",
        session: sessionId,
        ts: new Date().toISOString(),
        message: `Tailing ${basename}`,
        targetPath,
        persistent: true,
        source: filePath,
      };

      recordSession(entry);
      await this.logWriter.append(targetPath, entry);

      console.log(`[file-tailer] Tailing: ${filePath}`);
    } catch (err) {
      console.error(`[file-tailer] Failed to add ${filePath}:`, (err as Error).message);
    }
  }

  /** Serialize change processing per file to prevent duplicate reads from concurrent events */
  private onChange(filePath: string): void {
    const prev = this.changeQueues.get(filePath) || Promise.resolve();
    const next = prev.then(() => this.processChange(filePath)).catch(() => {});
    this.changeQueues.set(filePath, next);
  }

  private async processChange(filePath: string): Promise<void> {
    const prevOffset = this.offsets.get(filePath);
    if (prevOffset === undefined) return;

    try {
      const stat = await fsp.stat(filePath);
      const currentSize = stat.size;

      // File was truncated/rotated — reset to beginning
      if (currentSize < prevOffset) {
        this.offsets.set(filePath, 0);
        this.partials.set(filePath, "");
        return this.processChange(filePath);
      }

      // No new data
      if (currentSize === prevOffset) return;

      const bytesToRead = currentSize - prevOffset;
      const buffer = Buffer.alloc(bytesToRead);

      const fd = await fsp.open(filePath, "r");
      try {
        await fd.read(buffer, 0, bytesToRead, prevOffset);
      } finally {
        await fd.close();
      }

      this.offsets.set(filePath, currentSize);

      const chunk = buffer.toString("utf-8");
      const partial = this.partials.get(filePath) || "";
      const combined = partial + chunk;
      const lines = combined.split("\n");

      // Last element is either empty (line ended with \n) or an incomplete line
      this.partials.set(filePath, lines.pop()!);

      if (lines.length === 0) return;

      const sessionId = fileSessionId(filePath);
      const targetPath = filetailTargetPath(this.projectPath!, filePath);

      for (const line of lines) {
        if (!line.trim()) continue;

        const parsed = parseLine(line);
        const entry: Record<string, unknown> = {
          type: parsed.type,
          session: sessionId,
          ts: parsed.ts,
          message: parsed.message,
          targetPath,
          source: filePath,
        };

        recordSession(entry);
        await this.logWriter.append(targetPath, entry);
      }
    } catch (err) {
      // File may have been deleted between stat and read
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[file-tailer] Error reading ${filePath}:`, (err as Error).message);
      }
    }
  }

  /** Check if a file is a DevGlide JSONL log (has session + type fields on first line) */
  private async isDevGlideJsonl(filePath: string): Promise<boolean> {
    try {
      const fd = await fsp.open(filePath, "r");
      try {
        const buf = Buffer.alloc(512);
        const { bytesRead } = await fd.read(buf, 0, 512, 0);
        if (bytesRead === 0) return false;
        const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0].trim();
        if (!firstLine.startsWith("{")) return false;
        const obj = JSON.parse(firstLine);
        return typeof obj.session === "string" && typeof obj.type === "string";
      } finally {
        await fd.close();
      }
    } catch {
      return false;
    }
  }

  private onUnlink(filePath: string): void {
    if (this.offsets.has(filePath)) {
      this.offsets.delete(filePath);
      this.partials.delete(filePath);
      this.watchedCount--;
      console.log(`[file-tailer] Removed: ${filePath}`);
    }
  }
}
