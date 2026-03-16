import Database from "better-sqlite3";
import { createId } from "@paralleldrive/cuid2";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import { readActiveProjectId } from "../../../packages/project-store.js";
import { DEVGLIDE_DIR, DATABASES_DIR } from "../../../packages/paths.js";

// Re-export for consumers that import from db.ts
export { DEVGLIDE_DIR, DATABASES_DIR };

// ── Row interfaces matching DDL ──────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface ColumnRow {
  id: string;
  name: string;
  order: number;
  color: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRow {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  order: number;
  labels: string;
  dueDate: string | null;
  reviewFeedback: string | null;
  projectId: string;
  columnId: string;
  createdAt: string;
  updatedAt: string;
}

export interface VersionedEntryRow {
  id: string;
  issueId: string;
  type: string;
  version: number;
  content: string;
  createdAt: string;
}

// ── Connection cache ─────────────────────────────────────────────────────────
const dbCache = new Map<string, Database.Database>();

// Re-export for consumers that import from db.ts
export { readActiveProjectId };

/** Generate a unique ID using cuid2 */
export function generateId(): string {
  return createId();
}

/** Return the current time as an ISO-8601 string (for updatedAt) */
export function nowIso(): string {
  return new Date().toISOString();
}

// ── Database path helpers ────────────────────────────────────────────────────

function getDbPath(projectId: string): string {
  return path.join(DATABASES_DIR, `${projectId}.db`);
}

/**
 * Search common locations for the legacy prisma/dev.db file so it can be
 * migrated into the per-project database directory on first use.
 */
function findLegacyDb(): string | null {
  const candidates = [
    process.env.KANBAN_ROOT,
    process.cwd(),
    path.join(process.cwd(), "apps/kanban"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    const db = path.join(dir, "prisma", "dev.db");
    if (existsSync(db)) return db;
  }
  return null;
}

// ── DDL ──────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "Column" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Issue" (
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
    FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("columnId") REFERENCES "Column" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "issueId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("issueId") REFERENCES "Issue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "VersionedEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issueId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("issueId") REFERENCES "Issue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_issue_columnId" ON "Issue" ("columnId");
CREATE INDEX IF NOT EXISTS "idx_issue_projectId" ON "Issue" ("projectId");
CREATE INDEX IF NOT EXISTS "idx_column_projectId" ON "Column" ("projectId");
CREATE INDEX IF NOT EXISTS "idx_attachment_issueId" ON "Attachment" ("issueId");
CREATE INDEX IF NOT EXISTS "idx_versioned_issueId_type" ON "VersionedEntry" ("issueId", "type");
`;

// ── Versioned entry helper ────────────────────────────────────────────────────

/** Append a versioned entry (work_log or review) to an issue. Auto-increments version. */
export function appendVersionedEntry(
  db: Database.Database,
  issueId: string,
  type: string,
  content: string
): VersionedEntryRow | undefined {
  const maxVersion = db
    .prepare(
      `SELECT MAX("version") AS maxVer FROM "VersionedEntry" WHERE "issueId" = ? AND "type" = ?`
    )
    .get(issueId, type) as { maxVer: number | null } | undefined;
  const version = (maxVersion?.maxVer ?? 0) + 1;
  const id = generateId();
  db.prepare(
    `INSERT INTO "VersionedEntry" ("id", "issueId", "type", "version", "content") VALUES (?, ?, ?, ?, ?)`
  ).run(id, issueId, type, version, content);
  return db.prepare(`SELECT * FROM "VersionedEntry" WHERE "id" = ?`).get(id) as VersionedEntryRow | undefined;
}

/** Get all versioned entries for an issue by type, ordered by version ASC. */
export function getVersionedEntries(
  db: Database.Database,
  issueId: string,
  type: string
): VersionedEntryRow[] {
  return db
    .prepare(
      `SELECT * FROM "VersionedEntry" WHERE "issueId" = ? AND "type" = ? ORDER BY "version" ASC`
    )
    .all(issueId, type) as VersionedEntryRow[];
}

// ── ensureDb ─────────────────────────────────────────────────────────────────

/** Migrate existing reviewFeedback column data into VersionedEntry table. */
function migrateReviewFeedback(db: Database.Database): void {
  const hasEntries = db
    .prepare(`SELECT COUNT(*) AS cnt FROM "VersionedEntry" WHERE "type" = 'review'`)
    .get() as { cnt: number } | undefined;
  if ((hasEntries?.cnt ?? 0) > 0) return;

  const rows = db
    .prepare(`SELECT "id", "reviewFeedback" FROM "Issue" WHERE "reviewFeedback" IS NOT NULL AND "reviewFeedback" != ''`)
    .all() as Pick<IssueRow, 'id' | 'reviewFeedback'>[];

  for (const row of rows) {
    const id = generateId();
    db.prepare(
      `INSERT INTO "VersionedEntry" ("id", "issueId", "type", "version", "content") VALUES (?, ?, 'review', 1, ?)`
    ).run(id, row.id, row.reviewFeedback);
  }

  if (rows.length > 0) {
    console.log(`[kanban] Migrated ${rows.length} reviewFeedback entries to VersionedEntry table`);
  }
}

/** Track which one-time migrations have been applied. */
function hasMigration(db: Database.Database, name: string): boolean {
  db.exec(`CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TEXT NOT NULL)`);
  const row = db.prepare(`SELECT 1 FROM "_migrations" WHERE "name" = ?`).get(name);
  return !!row;
}

function markMigration(db: Database.Database, name: string): void {
  db.prepare(`INSERT OR IGNORE INTO "_migrations" ("name", "appliedAt") VALUES (?, ?)`).run(name, new Date().toISOString());
}

/** Fix literal \n and \t escape sequences stored as text instead of real characters. */
function migrateEscapeSequences(db: Database.Database): void {
  if (hasMigration(db, 'escape_sequences')) return;

  // Fix Issue descriptions
  db.prepare(`
    UPDATE "Issue"
    SET "description" = REPLACE(REPLACE("description", char(92) || 'n', char(10)), char(92) || 't', char(9))
    WHERE "description" LIKE '%' || char(92) || 'n%'
       OR "description" LIKE '%' || char(92) || 't%'
  `).run();

  // Fix VersionedEntry content
  db.prepare(`
    UPDATE "VersionedEntry"
    SET "content" = REPLACE(REPLACE("content", char(92) || 'n', char(10)), char(92) || 't', char(9))
    WHERE "content" LIKE '%' || char(92) || 'n%'
       OR "content" LIKE '%' || char(92) || 't%'
  `).run();

  markMigration(db, 'escape_sequences');
}

/**
 * Ensure the database file for the given project exists and has the correct
 * schema. On the very first call (no .db files in DATABASES_DIR) it will
 * attempt to copy a legacy prisma/dev.db if one exists.
 */
function ensureDb(projectId: string): void {
  const file = getDbPath(projectId);
  const isNew = !existsSync(file);

  if (isNew) {
    mkdirSync(DATABASES_DIR, { recursive: true });

    // Migrate legacy dev.db only once — for the very first project database
    // created. After that, all new projects get fresh empty databases.
    const existingDbs = readdirSync(DATABASES_DIR).filter((f) => f.endsWith(".db"));
    if (existingDbs.length === 0) {
      const legacyDb = findLegacyDb();
      if (legacyDb) {
        copyFileSync(legacyDb, file);
        console.log(`[kanban] Migrated legacy database to ${file}`);
      }
    }

    if (!existsSync(file)) {
      console.log(`[kanban] Creating database for project ${projectId}...`);
    }
  }

  // Always run DDL to ensure new tables exist (CREATE TABLE IF NOT EXISTS is safe)
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  migrateReviewFeedback(db);
  migrateEscapeSequences(db);
  db.close();
}

// ── getDb ────────────────────────────────────────────────────────────────────

/**
 * Get a better-sqlite3 Database instance for the given project context.
 * Falls back to the active project from ~/.devglide/projects.json,
 * then to a "default" database.
 *
 * Instances are cached so repeated calls return the same connection.
 */
export function getDb(projectId?: string | null): Database.Database {
  const id = projectId || readActiveProjectId() || "default";

  const cached = dbCache.get(id);
  if (cached) return cached;

  ensureDb(id);

  const db = new Database(getDbPath(id));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  dbCache.set(id, db);
  return db;
}
