import fs from "fs/promises";
import path from "path";

/**
 * Appends JSONL log entries to files on disk.
 * Uses per-file write queues to ensure sequential writes without corruption.
 */
export class LogWriter {
  private queues = new Map<string, Promise<void>>();

  async append(targetPath: string, entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    await this.enqueue(targetPath, async () => {
      const dir = path.dirname(targetPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(targetPath, line, "utf-8");
    });
  }

  async clear(targetPath: string): Promise<void> {
    await this.enqueue(targetPath, async () => {
      const dir = path.dirname(targetPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(targetPath, "", "utf-8");
    });
  }

  private enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      // Delete queue entry once it drains to prevent unbounded growth
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    });
    this.queues.set(key, next);
    return next;
  }
}
