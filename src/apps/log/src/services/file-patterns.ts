// ── File discovery patterns for log file tailing ────────────────────────────

/** Glob patterns to include when scanning for log files */
export const INCLUDE_PATTERNS = [
  "*.log",
  "logs/*.log",
  "log/*.log",
  "tmp/*.log",
  "storage/logs/*.log",
  "var/log/*.log",
];

/** Directories to ignore during file discovery */
export const IGNORE_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".turbo",
  "vendor",
  "venv",
  "__pycache__",
];

/** Chokidar-compatible ignored patterns */
export const IGNORED_GLOBS = [
  ...IGNORE_DIRS.map((d) => `**/${d}/**`),
  "**/*.filetail.log", // our own output files
];

/** Maximum directory depth for file scanning */
export const MAX_DEPTH = 3;

/** Maximum number of files to watch simultaneously */
export const MAX_WATCHED_FILES = 20;

/** Skip files larger than this (bytes) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
