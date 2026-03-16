import type Database from "better-sqlite3";
import type { ColumnRow, IssueRow } from "./db.js";

/** Convert literal escape sequences (\n, \t) to real characters. */
export function normalizeEscapes(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_COLUMNS = [
  { name: "Backlog", color: "#64748b", order: 0 },
  { name: "Todo", color: "#3b82f6", order: 1 },
  { name: "In Progress", color: "#f59e0b", order: 2 },
  { name: "In Review", color: "#8b5cf6", order: 3 },
  { name: "Testing", color: "#14b8a6", order: 4 },
  { name: "Done", color: "#22c55e", order: 5 },
];

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

const DESC_TRUNCATE_LEN = 200;
export function truncateDescription(desc: string | null | undefined): string | null {
  if (!desc) return desc ?? null;
  if (desc.length <= DESC_TRUNCATE_LEN) return desc;
  return desc.slice(0, DESC_TRUNCATE_LEN) + "…(truncated)";
}
