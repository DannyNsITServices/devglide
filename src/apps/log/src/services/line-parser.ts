// ── Parse raw log lines into structured entries ─────────────────────────────

export interface ParsedLine {
  type: "FILE_LOG" | "FILE_WARN" | "FILE_ERROR" | "FILE_DEBUG";
  message: string;
  ts: string;
}

const LEVEL_MAP: Record<string, ParsedLine["type"]> = {
  debug: "FILE_DEBUG",
  info: "FILE_LOG",
  log: "FILE_LOG",
  notice: "FILE_LOG",
  warn: "FILE_WARN",
  warning: "FILE_WARN",
  error: "FILE_ERROR",
  err: "FILE_ERROR",
  fatal: "FILE_ERROR",
  critical: "FILE_ERROR",
  crit: "FILE_ERROR",
};

/**
 * Regex for common log formats:
 *   [2024-01-15 10:30:45] ERROR: something happened
 *   2024-01-15T10:30:45.123Z WARN something happened
 *   [ERROR] something happened
 */
const COMMON_RE =
  /^\[?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?)\]?\s+(\w+):?\s+(.*)/;
const LEVEL_ONLY_RE = /^\[(\w+)\]:?\s+(.*)/;

function mapLevel(raw: string): ParsedLine["type"] {
  return LEVEL_MAP[raw.toLowerCase()] || "FILE_LOG";
}

export function parseLine(raw: string): ParsedLine {
  const trimmed = raw.trimEnd();
  if (!trimmed) {
    return { type: "FILE_LOG", message: "", ts: new Date().toISOString() };
  }

  // Strategy 1: JSON line
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      const level =
        obj.level || obj.severity || obj.log_level || obj.loglevel || "";
      const message =
        obj.msg || obj.message || obj.text || obj.body || trimmed;
      const ts =
        obj.time ||
        obj.timestamp ||
        obj.ts ||
        obj.datetime ||
        obj.date ||
        new Date().toISOString();
      return {
        type: mapLevel(String(level)),
        message: String(message),
        ts: String(ts),
      };
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Strategy 2: Common timestamp + level format
  const common = COMMON_RE.exec(trimmed);
  if (common) {
    return {
      type: mapLevel(common[2]),
      message: common[3],
      ts: common[1],
    };
  }

  // Strategy 2b: Level-only prefix [ERROR] message
  const levelOnly = LEVEL_ONLY_RE.exec(trimmed);
  if (levelOnly && LEVEL_MAP[levelOnly[1].toLowerCase()]) {
    return {
      type: mapLevel(levelOnly[1]),
      message: levelOnly[2],
      ts: new Date().toISOString(),
    };
  }

  // Strategy 3: Plain text fallback
  return {
    type: "FILE_LOG",
    message: trimmed,
    ts: new Date().toISOString(),
  };
}
