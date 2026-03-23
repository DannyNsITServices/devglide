import type Database from "better-sqlite3";
import type { ColumnRow, IssueRow } from "./db.js";
import { KANBAN_DEFAULT_COLUMNS } from "../../../packages/shared-types/src/index.js";

/** Convert literal escape sequences (\n, \t) to real characters. */
export function normalizeEscapes(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_COLUMNS = KANBAN_DEFAULT_COLUMNS;

// ── Row mappers ──────────────────────────────────────────────────────────────
// Remap internal "projectId" column to external "featureId" for MCP consumers.

type MappedColumn = Omit<ColumnRow, 'projectId'> & { featureId: string };
type MappedIssue = Omit<IssueRow, 'projectId'> & { featureId: string };

export function mapColumnRow(row: ColumnRow): MappedColumn;
export function mapColumnRow(row: ColumnRow | undefined): MappedColumn | undefined;
export function mapColumnRow(row: ColumnRow | undefined): MappedColumn | undefined {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

export function mapIssueRow(row: IssueRow): MappedIssue;
export function mapIssueRow(row: IssueRow | undefined): MappedIssue | undefined;
export function mapIssueRow(row: IssueRow | undefined): MappedIssue | undefined {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function resolveColumnId(
  db: Database.Database,
  featureId: string,
  columnName: string
): string | null {
  const col = db
    .prepare('SELECT id FROM "Column" WHERE projectId = ? AND name = ?')
    .get(featureId, columnName) as { id: string } | undefined;
  return col?.id ?? null;
}

// ── FTS query sanitization ───────────────────────────────────────────────────

/**
 * Sanitize a plain-text search query for safe use with SQLite FTS5 MATCH.
 * Strips FTS5 operators and special characters that could cause parser errors,
 * then wraps each remaining token with `"..."` to force literal matching.
 * Returns null if the query produces no usable tokens.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  // Remove characters that are FTS5 syntax: " ( ) { } * ^
  const stripped = raw.replace(/["""(){}*^]/g, ' ');
  // Split into tokens, drop FTS5 keywords used as bare operators
  const ftsKeywords = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const tokens = stripped
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 0 && !ftsKeywords.has(t.toUpperCase()));
  if (tokens.length === 0) return null;
  // Quote each token for literal matching
  return tokens.map(t => `"${t}"`).join(' ');
}

const DESC_TRUNCATE_LEN = 200;
export function truncateDescription(desc: string | null | undefined): string | null {
  if (!desc) return desc ?? null;
  if (desc.length <= DESC_TRUNCATE_LEN) return desc;
  return desc.slice(0, DESC_TRUNCATE_LEN) + "…(truncated)";
}
