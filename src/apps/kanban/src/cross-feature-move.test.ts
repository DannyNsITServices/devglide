import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { appendVersionedEntry, getVersionedEntries, nowIso, generateId } from './db.js';
import { resolveColumnId } from './mcp-helpers.js';

/** Stand up an in-memory SQLite DB with the full kanban schema. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "color" TEXT NOT NULL DEFAULT '#6366f1',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );
    CREATE TABLE "Column" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      "color" TEXT NOT NULL DEFAULT '#64748b',
      "projectId" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "Issue" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "description" TEXT,
      "type" TEXT NOT NULL DEFAULT 'TASK',
      "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
      "order" INTEGER NOT NULL DEFAULT 0,
      "labels" TEXT NOT NULL DEFAULT '[]',
      "dueDate" DATETIME,
      "reviewFeedback" TEXT,
      "projectId" TEXT NOT NULL,
      "columnId" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE,
      FOREIGN KEY ("columnId") REFERENCES "Column" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "Attachment" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "filename" TEXT NOT NULL,
      "mimeType" TEXT NOT NULL,
      "size" INTEGER NOT NULL,
      "issueId" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY ("issueId") REFERENCES "Issue" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "VersionedEntry" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "issueId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "version" INTEGER NOT NULL,
      "content" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY ("issueId") REFERENCES "Issue" ("id") ON DELETE CASCADE
    );
  `);

  return db;
}

const COLUMN_NAMES = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Testing', 'Done'];

function seedFeature(db: Database.Database, featureId: string, name: string): void {
  const now = nowIso();
  db.prepare(`INSERT INTO "Project" (id, name, updatedAt) VALUES (?, ?, ?)`).run(featureId, name, now);
  for (let i = 0; i < COLUMN_NAMES.length; i++) {
    db.prepare(`INSERT INTO "Column" (id, name, "order", "projectId", updatedAt) VALUES (?, ?, ?, ?, ?)`)
      .run(`${featureId}-col-${i}`, COLUMN_NAMES[i], i, featureId, now);
  }
}

function createIssue(db: Database.Database, featureId: string, columnName: string, title: string): string {
  const id = generateId();
  const now = nowIso();
  const colId = resolveColumnId(db, featureId, columnName);
  db.prepare(`INSERT INTO "Issue" (id, title, "projectId", "columnId", updatedAt) VALUES (?, ?, ?, ?, ?)`)
    .run(id, title, featureId, colId!, now);
  return id;
}

/**
 * Simulate the cross-feature move logic from kanban_move_item.
 * This mirrors the actual implementation to test the DB-level behavior.
 */
function moveItemToFeature(
  db: Database.Database,
  issueId: string,
  targetFeatureId: string,
  columnName?: string,
): { ok: boolean; error?: string } {
  const issue = db.prepare(`SELECT i.*, c."name" AS columnName FROM "Issue" i LEFT JOIN "Column" c ON i."columnId" = c."id" WHERE i."id" = ?`)
    .get(issueId) as { projectId: string; columnName?: string } | undefined;
  if (!issue) return { ok: false, error: 'Issue not found' };

  // Validate target feature
  const targetFeature = db.prepare(`SELECT "id" FROM "Project" WHERE "id" = ?`).get(targetFeatureId);
  if (!targetFeature) return { ok: false, error: 'Target feature not found' };

  // Resolve column in target feature
  const targetColumnName = columnName ?? issue.columnName ?? 'Backlog';
  const targetColId = resolveColumnId(db, targetFeatureId, targetColumnName);
  if (!targetColId) return { ok: false, error: `Column "${targetColumnName}" not found in target feature` };

  // Verify column belongs to target feature
  const col = db.prepare(`SELECT "projectId", "name" FROM "Column" WHERE "id" = ?`).get(targetColId) as { projectId: string; name: string } | undefined;
  if (!col || col.projectId !== targetFeatureId) return { ok: false, error: 'Column does not belong to target feature' };

  // Calculate order
  const maxOrder = db.prepare(`SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`).get(targetColId) as { maxOrd: number | null } | undefined;
  const order = (maxOrder?.maxOrd ?? -1) + 1;

  const now = nowIso();
  db.prepare(`UPDATE "Issue" SET "projectId" = ?, "columnId" = ?, "order" = ?, "updatedAt" = ? WHERE "id" = ?`)
    .run(targetFeatureId, targetColId, order, now, issueId);

  return { ok: true };
}

describe('cross-feature item move', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedFeature(db, 'feature-a', 'Feature A');
    seedFeature(db, 'feature-b', 'Feature B');
  });

  it('moves an item from feature A to feature B', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Test task');

    const result = moveItemToFeature(db, issueId, 'feature-b');
    expect(result.ok).toBe(true);

    const moved = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(issueId) as { projectId: string; columnId: string };
    expect(moved.projectId).toBe('feature-b');

    // Column should be Todo in feature-b
    const col = db.prepare(`SELECT "name", "projectId" FROM "Column" WHERE "id" = ?`).get(moved.columnId) as { name: string; projectId: string };
    expect(col.name).toBe('Todo');
    expect(col.projectId).toBe('feature-b');
  });

  it('preserves column name when moving between features', () => {
    const issueId = createIssue(db, 'feature-a', 'In Review', 'Review task');

    moveItemToFeature(db, issueId, 'feature-b');

    const moved = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(issueId) as { projectId: string; columnId: string };
    const col = db.prepare(`SELECT "name" FROM "Column" WHERE "id" = ?`).get(moved.columnId) as { name: string };
    expect(col.name).toBe('In Review');
  });

  it('allows explicit column override when moving between features', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Override task');

    moveItemToFeature(db, issueId, 'feature-b', 'Backlog');

    const moved = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(issueId) as { projectId: string; columnId: string };
    const col = db.prepare(`SELECT "name" FROM "Column" WHERE "id" = ?`).get(moved.columnId) as { name: string };
    expect(col.name).toBe('Backlog');
  });

  it('preserves work log history after cross-feature move', () => {
    const issueId = createIssue(db, 'feature-a', 'In Progress', 'Logged task');

    appendVersionedEntry(db, issueId, 'work_log', 'First log entry');
    appendVersionedEntry(db, issueId, 'work_log', 'Second log entry');

    moveItemToFeature(db, issueId, 'feature-b');

    const logs = getVersionedEntries(db, issueId, 'work_log');
    expect(logs).toHaveLength(2);
    expect(logs[0].content).toBe('First log entry');
    expect(logs[0].version).toBe(1);
    expect(logs[1].content).toBe('Second log entry');
    expect(logs[1].version).toBe(2);
  });

  it('preserves review history after cross-feature move', () => {
    const issueId = createIssue(db, 'feature-a', 'In Review', 'Reviewed task');

    appendVersionedEntry(db, issueId, 'review', 'Needs changes');
    appendVersionedEntry(db, issueId, 'review', 'Approved');

    moveItemToFeature(db, issueId, 'feature-b');

    const reviews = getVersionedEntries(db, issueId, 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews[0].content).toBe('Needs changes');
    expect(reviews[1].content).toBe('Approved');
  });

  it('preserves attachments after cross-feature move', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Attached task');

    db.prepare(`INSERT INTO "Attachment" (id, filename, "mimeType", size, "issueId") VALUES (?, ?, ?, ?, ?)`)
      .run('att-1', 'screenshot.png', 'image/png', 1024, issueId);

    moveItemToFeature(db, issueId, 'feature-b');

    const attachments = db.prepare(`SELECT * FROM "Attachment" WHERE "issueId" = ?`).all(issueId);
    expect(attachments).toHaveLength(1);
    expect((attachments[0] as { filename: string }).filename).toBe('screenshot.png');
  });

  it('preserves item identity (same ID) after cross-feature move', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Identity task');

    moveItemToFeature(db, issueId, 'feature-b');

    const moved = db.prepare(`SELECT "id", "title" FROM "Issue" WHERE "id" = ?`).get(issueId) as { id: string; title: string };
    expect(moved.id).toBe(issueId);
    expect(moved.title).toBe('Identity task');
  });

  it('updates updatedAt timestamp on move', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Timestamp task');

    const before = db.prepare(`SELECT "updatedAt" FROM "Issue" WHERE "id" = ?`).get(issueId) as { updatedAt: string };

    moveItemToFeature(db, issueId, 'feature-b');

    const after = db.prepare(`SELECT "updatedAt" FROM "Issue" WHERE "id" = ?`).get(issueId) as { updatedAt: string };
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  it('fails when target feature does not exist', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Bad target');

    const result = moveItemToFeature(db, issueId, 'nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Target feature not found');
  });

  it('fails when issue does not exist', () => {
    const result = moveItemToFeature(db, 'nonexistent-issue', 'feature-b');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Issue not found');
  });

  it('item no longer appears in source feature queries', () => {
    const issueId = createIssue(db, 'feature-a', 'Todo', 'Moved away');

    moveItemToFeature(db, issueId, 'feature-b');

    const inA = db.prepare(`SELECT * FROM "Issue" WHERE "projectId" = ?`).all('feature-a');
    const inB = db.prepare(`SELECT * FROM "Issue" WHERE "projectId" = ?`).all('feature-b');
    expect(inA).toHaveLength(0);
    expect(inB).toHaveLength(1);
  });

  it('calculates correct order in target column', () => {
    // Create two items already in feature-b Todo
    createIssue(db, 'feature-b', 'Todo', 'Existing 1');
    createIssue(db, 'feature-b', 'Todo', 'Existing 2');

    const issueId = createIssue(db, 'feature-a', 'Todo', 'Incoming');
    moveItemToFeature(db, issueId, 'feature-b');

    const moved = db.prepare(`SELECT "order" FROM "Issue" WHERE "id" = ?`).get(issueId) as { order: number };
    // Should be appended after existing items (order 0, 0) → next is 1
    expect(moved.order).toBeGreaterThanOrEqual(1);
  });
});
