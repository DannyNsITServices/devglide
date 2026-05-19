import path from "path";
import { DEVGLIDE_DIR } from "../../../packages/paths.js";

const LOG_ROOT = DEVGLIDE_DIR;
const ALLOWED_EXTENSIONS = new Set(['.log', '.jsonl']);

/**
 * Resolve a user-supplied log path into a safe absolute path within the
 * DevGlide data directory (~/.devglide/).
 *
 * - Leading slashes are stripped so the path is always treated as relative.
 * - The resolved path must stay within LOG_ROOT (no traversal).
 * - Only .log and .jsonl extensions are allowed.
 */
export function safeLogPath(targetPath: string): string {
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
