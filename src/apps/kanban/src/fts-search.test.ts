import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { appendVersionedEntry, getVersionedEntries, nowIso, generateId } from './db.js';

/** Stand up an in-memory SQLite DB with the kanban schema + FTS5. */
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
    CREATE TABLE "VersionedEntry" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "issueId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "version" INTEGER NOT NULL,
      "content" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY ("issueId") REFERENCES "Issue" ("id") ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS "IssueFts" USING fts5(
      "id" UNINDEXED,
      "title",
      "description",
      "labels"
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

function createIssue(
  db: Database.Database,
  featureId: string,
  columnName: string,
  title: string,
  opts?: { description?: string; labels?: string[]; priority?: string; type?: string },
): string {
  const id = generateId();
  const now = nowIso();
  const colIdx = COLUMN_NAMES.indexOf(columnName);
  const colId = `${featureId}-col-${colIdx}`;
  const labels = JSON.stringify(opts?.labels ?? []);

  db.prepare(`INSERT INTO "Issue" (id, title, description, "type", priority, "projectId", "columnId", labels, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, opts?.description ?? null, opts?.type ?? 'TASK', opts?.priority ?? 'MEDIUM', featureId, colId, labels, now);

  // Sync FTS
  db.prepare(`INSERT INTO "IssueFts" (id, title, description, labels) VALUES (?, ?, ?, ?)`)
    .run(id, title, opts?.description ?? '', labels);

  return id;
}

function search(
  db: Database.Database,
  query: string,
  filters?: { featureId?: string; columnName?: string; priority?: string; type?: string; limit?: number },
): { id: string; title: string; columnName: string; featureName: string; priority: string; type: string; rank: number }[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.featureId) { conditions.push(`i."projectId" = ?`); params.push(filters.featureId); }
  if (filters?.columnName) { conditions.push(`c."name" = ?`); params.push(filters.columnName); }
  if (filters?.priority) { conditions.push(`i."priority" = ?`); params.push(filters.priority); }
  if (filters?.type) { conditions.push(`i."type" = ?`); params.push(filters.type); }

  const extraWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 20;

  return db.prepare(
    `SELECT i."id", i."title", i."priority", i."type",
            c."name" AS columnName,
            p."name" AS featureName,
            rank
     FROM "IssueFts" fts
     JOIN "Issue" i ON fts."id" = i."id"
     LEFT JOIN "Column" c ON i."columnId" = c."id"
     LEFT JOIN "Project" p ON i."projectId" = p."id"
     WHERE "IssueFts" MATCH ?
     ${extraWhere}
     ORDER BY rank
     LIMIT ?`
  ).all(query, ...params, limit) as any[];
}

describe('FTS5 kanban search', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedFeature(db, 'feat-chat', 'Chat');
    seedFeature(db, 'feat-shell', 'Shell');
  });

  it('finds items by title keyword', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Fix PTY delivery race condition');
    createIssue(db, 'feat-chat', 'Done', 'Add chat documentation');

    const results = search(db, 'PTY');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Fix PTY delivery race condition');
  });

  it('finds items by description content', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Bug fix', { description: 'The websocket connection drops intermittently' });
    createIssue(db, 'feat-chat', 'Todo', 'Feature request', { description: 'Add dark mode toggle' });

    const results = search(db, 'websocket');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Bug fix');
  });

  it('finds items by label content', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Refactor registry', { labels: ['chat', 'refactoring'] });
    createIssue(db, 'feat-shell', 'Todo', 'Add new pane type', { labels: ['shell', 'feature'] });

    const results = search(db, 'refactoring');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Refactor registry');
  });

  it('returns multiple matches ranked by relevance', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Chat rules of engagement backend');
    createIssue(db, 'feat-chat', 'In Review', 'Chat rules of engagement frontend');
    createIssue(db, 'feat-shell', 'Todo', 'Shell pane management');

    const results = search(db, 'rules engagement');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.title.includes('rules'))).toBe(true);
  });

  it('filters by featureId', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Chat improvement');
    createIssue(db, 'feat-shell', 'Todo', 'Shell improvement');

    const results = search(db, 'improvement', { featureId: 'feat-chat' });
    expect(results).toHaveLength(1);
    expect(results[0].featureName).toBe('Chat');
  });

  it('filters by columnName', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Pending task');
    createIssue(db, 'feat-chat', 'Done', 'Completed task');

    const results = search(db, 'task', { columnName: 'Todo' });
    expect(results).toHaveLength(1);
    expect(results[0].columnName).toBe('Todo');
  });

  it('filters by priority', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Critical security fix', { priority: 'URGENT' });
    createIssue(db, 'feat-chat', 'Todo', 'Minor security tweak', { priority: 'LOW' });

    const results = search(db, 'security', { priority: 'URGENT' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('Critical');
  });

  it('filters by type', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Implement auth', { type: 'TASK' });
    createIssue(db, 'feat-chat', 'Todo', 'Auth bypass bug', { type: 'BUG' });

    const results = search(db, 'auth', { type: 'BUG' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('bypass');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      createIssue(db, 'feat-chat', 'Todo', `Search result item ${i}`);
    }

    const results = search(db, 'search result', { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('returns empty array for no matches', () => {
    createIssue(db, 'feat-chat', 'Todo', 'Something else');

    const results = search(db, 'nonexistent');
    expect(results).toHaveLength(0);
  });

  it('reflects updated content after FTS update', () => {
    const id = createIssue(db, 'feat-chat', 'Todo', 'Original title');

    // Simulate ftsUpdate: delete old row, insert new
    db.prepare(`DELETE FROM "IssueFts" WHERE "id" = ?`).run(id);
    db.prepare(`INSERT INTO "IssueFts" (id, title, description, labels) VALUES (?, ?, ?, ?)`).run(id, 'Updated title about websockets', '', '[]');
    db.prepare(`UPDATE "Issue" SET title = ? WHERE id = ?`).run('Updated title about websockets', id);

    expect(search(db, 'Original')).toHaveLength(0);
    expect(search(db, 'websockets')).toHaveLength(1);
  });

  it('does not return deleted items after FTS delete', () => {
    const id = createIssue(db, 'feat-chat', 'Todo', 'Doomed item');

    // Simulate ftsDelete
    db.prepare(`DELETE FROM "IssueFts" WHERE "id" = ?`).run(id);
    db.prepare(`DELETE FROM "Issue" WHERE id = ?`).run(id);

    expect(search(db, 'Doomed')).toHaveLength(0);
  });

  it('combines multiple filters', () => {
    createIssue(db, 'feat-chat', 'In Review', 'Chat rules fix', { priority: 'HIGH', type: 'BUG' });
    createIssue(db, 'feat-chat', 'Todo', 'Chat rules enhancement', { priority: 'MEDIUM', type: 'TASK' });
    createIssue(db, 'feat-shell', 'In Review', 'Shell rules fix', { priority: 'HIGH', type: 'BUG' });

    const results = search(db, 'rules', { featureId: 'feat-chat', columnName: 'In Review', priority: 'HIGH', type: 'BUG' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Chat rules fix');
  });
});
