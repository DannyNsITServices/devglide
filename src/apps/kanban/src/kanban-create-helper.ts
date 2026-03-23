/**
 * Shared kanban item creation helper — used by both MCP tools and workflow executor.
 * Centralizes column resolution, Backlog/Todo restriction, and default values.
 */
import type Database from 'better-sqlite3';
import { generateId, nowIso, ftsInsert, type IssueRow } from './db.js';
import { normalizeEscapes } from './mcp-helpers.js';
import { KANBAN_PRIORITIES, KANBAN_ITEM_TYPES_EXTENDED } from '../../../packages/shared-types/src/index.js';

interface CreateItemInput {
  title: string;
  description?: string | null;
  featureId: string;
  columnId?: string;
  columnName?: string;
  priority?: string;
  type?: string;
  labels?: string[];
  dueDate?: string | null;
}

type CreateItemResult = {
  ok: true;
  item: IssueRow;
} | {
  ok: false;
  error: string;
};

/** Resolve a column ID by name within a feature. */
export function resolveColumnId(db: Database.Database, featureId: string, columnName: string): string | null {
  const col = db.prepare(
    `SELECT "id" FROM "Column" WHERE "projectId" = ? AND "name" = ?`
  ).get(featureId, columnName) as { id: string } | undefined;
  return col?.id ?? null;
}

/**
 * Create a kanban item with consistent defaults and validation.
 * - Defaults to Backlog column if no column specified.
 * - Auto-corrects invalid target columns to Todo.
 * - Validates priority and type against shared constants.
 * - Defaults priority to MEDIUM, type to TASK.
 */
export function createKanbanItem(db: Database.Database, input: CreateItemInput): CreateItemResult {
  // Resolve target column — default to Backlog
  let columnId = input.columnId;
  if (!columnId) {
    const effectiveColumnName = input.columnName ?? 'Backlog';
    const resolved = resolveColumnId(db, input.featureId, effectiveColumnName);
    if (!resolved) return { ok: false, error: `Column "${effectiveColumnName}" not found in feature.` };
    columnId = resolved;
  }

  // Validate target column is Backlog or Todo — auto-correct to Todo if invalid
  const targetCol = db.prepare(
    `SELECT "name" FROM "Column" WHERE "id" = ?`
  ).get(columnId) as { name: string } | undefined;
  if (!targetCol || !['Backlog', 'Todo'].includes(targetCol.name)) {
    const fallback = resolveColumnId(db, input.featureId, 'Todo');
    if (!fallback) return { ok: false, error: 'Could not resolve default Todo column' };
    columnId = fallback;
  }

  // Compute insertion order
  const maxOrder = db.prepare(
    `SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`
  ).get(columnId) as { maxOrd: number | null } | undefined;
  const order = (maxOrder?.maxOrd ?? -1) + 1;

  // Validate priority and type against shared constants
  const priority = input.priority && (KANBAN_PRIORITIES as readonly string[]).includes(input.priority)
    ? input.priority : 'MEDIUM';
  const itemType = input.type && (KANBAN_ITEM_TYPES_EXTENDED as readonly string[]).includes(input.type)
    ? input.type : 'TASK';

  const id = generateId();
  const now = nowIso();

  db.prepare(
    `INSERT INTO "Issue" ("id", "title", "description", "type", "priority", "order", "labels", "dueDate", "projectId", "columnId", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.title,
    input.description ? normalizeEscapes(input.description) : null,
    itemType,
    priority,
    order,
    JSON.stringify(input.labels ?? []),
    input.dueDate ?? null,
    input.featureId,
    columnId,
    now,
  );

  // Sync FTS index
  ftsInsert(db, id, input.title, input.description ? normalizeEscapes(input.description) : null, JSON.stringify(input.labels ?? []));

  const item = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as IssueRow;
  return { ok: true, item };
}
