/**
 * Tiny YAML-frontmatter helper for the Knowledge Base.
 *
 * Deliberately scoped: handles only the keys the KB writes (string scalars
 * and inline string lists). The KB store is the only writer, so the parser
 * only needs to round-trip what the writer emits, plus tolerate light
 * hand-editing in a text editor.
 *
 * Format:
 *   ---
 *   key: value
 *   tags: [a, b, c]
 *   ---
 *
 *   body…
 */

export interface ParsedFrontmatter {
  /** Parsed scalar fields. Multi-value fields end up as arrays. */
  data: Record<string, string | string[]>;
  /** Body content with the leading frontmatter block removed. */
  body: string;
}

const FRONTMATTER_DELIM = '---';

/** Parse a markdown document with optional YAML frontmatter. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // Normalize newlines so the regex below works on Windows-authored files.
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines.length === 0 || lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { data: {}, body: normalized };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    // Unterminated frontmatter — treat the whole document as body.
    return { data: {}, body: normalized };
  }

  const data: Record<string, string | string[]> = {};

  // Block-list state: when we see `key:` followed by indented `- value` lines.
  let pendingBlockKey: string | null = null;
  let pendingBlockValues: string[] = [];

  const flushBlock = () => {
    if (pendingBlockKey !== null) {
      data[pendingBlockKey] = pendingBlockValues;
      pendingBlockKey = null;
      pendingBlockValues = [];
    }
  };

  for (let i = 1; i < endIdx; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      flushBlock();
      continue;
    }

    // Continuation of a block list?
    const blockItemMatch = line.match(/^\s+-\s+(.*)$/);
    if (blockItemMatch && pendingBlockKey !== null) {
      pendingBlockValues.push(unquote(blockItemMatch[1]?.trim() ?? ''));
      continue;
    }
    flushBlock();

    const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1] as string;
    const rawValue = (kvMatch[2] ?? '').trim();

    if (rawValue === '') {
      // Could be the start of a block list — defer assignment.
      pendingBlockKey = key;
      pendingBlockValues = [];
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      data[key] = parseInlineList(rawValue);
    } else {
      data[key] = unquote(rawValue);
    }
  }
  flushBlock();

  // Body: everything after the closing `---`, with one optional leading blank
  // line stripped and one optional trailing blank line stripped (so a body
  // written as `"hello"` round-trips as `"hello"`, not `"hello\n"`).
  const bodyLines = lines.slice(endIdx + 1);
  if (bodyLines.length > 0 && bodyLines[0] === '') {
    bodyLines.shift();
  }
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }
  return { data, body: bodyLines.join('\n') };
}

/** Serialize a frontmatter+body pair back to a markdown string. */
export function serializeFrontmatter(data: Record<string, string | string[] | undefined>, body: string): string {
  const lines: string[] = [FRONTMATTER_DELIM];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: ${formatInlineList(value)}`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push(FRONTMATTER_DELIM);
  lines.push('');
  // Ensure exactly one trailing newline on the body for clean diffs.
  const trimmedBody = body.replace(/\s+$/, '');
  lines.push(trimmedBody);
  lines.push('');
  return lines.join('\n');
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Strip surrounding quotes (single or double) and unescape. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      if (first === '"') {
        return inner.replace(/\\(["\\])/g, '$1');
      }
      return inner;
    }
  }
  return value;
}

/** Parse a `[a, b, "c, with comma"]` style inline list. */
function parseInlineList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  const items: string[] = [];
  let buf = '';
  let inQuotes: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (inQuotes === '"' && ch === '\\') {
      escape = true;
      continue;
    }
    if (inQuotes) {
      if (ch === inQuotes) {
        inQuotes = null;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuotes = ch;
      continue;
    }
    if (ch === ',') {
      items.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '' || items.length > 0) {
    items.push(buf.trim());
  }
  return items.filter((s) => s.length > 0);
}

/** Decide whether a scalar string can be written bare or needs quoting. */
function formatScalar(value: string): string {
  if (value === '') return '""';
  // Quote when the string contains characters that would confuse the parser.
  if (
    /[:#\n\r]/.test(value) ||
    /^[\s\-?!&*|>%@`]/.test(value) ||
    /\s$/.test(value) ||
    value.startsWith('[') ||
    value.startsWith('{') ||
    value.startsWith('"') ||
    value.startsWith("'")
  ) {
    return JSON.stringify(value); // double-quote with proper escaping
  }
  return value;
}

/** Format an array as a `[a, b, c]` inline list. */
function formatInlineList(items: string[]): string {
  return `[${items.map((item) => formatListItem(item)).join(', ')}]`;
}

function formatListItem(item: string): string {
  if (/[,\[\]"'\\]/.test(item) || item.includes(' ')) {
    return JSON.stringify(item);
  }
  return item;
}
