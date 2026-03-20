import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { getDb, generateId, nowIso, type ColumnRow, type IssueRow } from "../db.js";
import { jsonResult, errorResult } from "../../../../packages/mcp-utils/src/index.js";
import { DEFAULT_COLUMNS, mapColumnRow, mapIssueRow } from "../mcp-helpers.js";
import { getUploadsDir } from "../routes/attachments.js";

export function registerFeatureTools(server: McpServer, projectId?: string | null): void {

  // ── kanban_list_features ──────────────────────────────────────────────────

  server.tool(
    "kanban_list_features",
    "List all features in the current project. Features represent product initiatives or modules, each with its own kanban board of tasks and bugs.",
    {
      limit: z.coerce.number().int().min(1).max(100).optional().describe("Max items to return (default 25, max 100)"),
      offset: z.coerce.number().int().min(0).optional().describe("Number of items to skip (default 0)"),
    },
    async ({ limit, offset }) => {
      const db = getDb(projectId);
      const take = limit ?? 25;
      const skip = offset ?? 0;

      const totalRow = db.prepare(`SELECT COUNT(*) AS cnt FROM "Project"`).get() as any;
      const total = totalRow.cnt;

      const features = db
        .prepare(
          `SELECT p.*,
                  (SELECT COUNT(*) FROM "Issue" i WHERE i."projectId" = p."id") AS issueCount
           FROM "Project" p
           ORDER BY p."name" COLLATE NOCASE ASC
           LIMIT ? OFFSET ?`
        )
        .all(take, skip);

      return jsonResult({
        data: features,
        pagination: { total, limit: take, offset: skip, hasMore: skip + take < total },
      });
    }
  );

  // ── kanban_create_feature ─────────────────────────────────────────────────

  server.tool(
    "kanban_create_feature",
    "Create a new feature with default kanban columns. A feature represents a product initiative or module.",
    {
      name: z.string().describe("Feature name"),
      description: z.string().optional().describe("Feature description"),
      color: z.string().optional().describe('Hex color e.g. #6366f1'),
    },
    async ({ name, description, color }) => {
      const db = getDb(projectId);
      const now = nowIso();
      const featureId = generateId();

      const txn = db.transaction(() => {
        db.prepare(
          `INSERT INTO "Project" ("id", "name", "description", "color", "updatedAt")
           VALUES (?, ?, ?, ?, ?)`
        ).run(featureId, name, description ?? null, color ?? "#6366f1", now);

        for (const col of DEFAULT_COLUMNS) {
          db.prepare(
            `INSERT INTO "Column" ("id", "name", "order", "color", "projectId", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(generateId(), col.name, col.order, col.color, featureId, now);
        }
      });

      txn();

      const feature = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(featureId) as Record<string, unknown>;
      const columns = db
        .prepare(`SELECT * FROM "Column" WHERE "projectId" = ? ORDER BY "order" ASC`)
        .all(featureId)
        .map((r) => mapColumnRow(r as ColumnRow));

      return jsonResult({ ...feature, columns });
    }
  );

  // ── kanban_get_feature ────────────────────────────────────────────────────

  server.tool(
    "kanban_get_feature",
    "Get full feature details including columns, tasks, and bugs",
    { id: z.string().describe("Feature ID") },
    async ({ id }) => {
      const db = getDb(projectId);

      const feature = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id) as Record<string, unknown> | undefined;
      if (!feature) return errorResult("Feature not found");

      const columns = db
        .prepare(`SELECT * FROM "Column" WHERE "projectId" = ? ORDER BY "order" ASC`)
        .all(id) as ColumnRow[];

      const columnsWithIssues = columns.map((col) => {
        const issues = db
          .prepare(`SELECT * FROM "Issue" WHERE "columnId" = ? ORDER BY "order" ASC`)
          .all(col.id)
          .map((r) => mapIssueRow(r as IssueRow));
        return { ...mapColumnRow(col), issues };
      });

      return jsonResult({ ...feature, columns: columnsWithIssues });
    }
  );

  // ── kanban_delete_feature ─────────────────────────────────────────────────

  server.tool(
    "kanban_delete_feature",
    "Delete a feature and all its tasks and bugs",
    { id: z.string().describe("Feature ID") },
    async ({ id }) => {
      const db = getDb(projectId);
      const existing = db.prepare(`SELECT "id" FROM "Project" WHERE "id" = ?`).get(id);
      if (!existing) return errorResult("Feature not found");

      // Clean up attachment files from disk before deleting
      const attachments = db
        .prepare(
          `SELECT a."id", a."filename" FROM "Attachment" a
           JOIN "Issue" i ON a."issueId" = i."id"
           WHERE i."projectId" = ?`
        )
        .all(id) as { id: string; filename: string }[];
      const uploadsDir = getUploadsDir(projectId ?? 'default');
      for (const att of attachments) {
        const ext = path.extname(att.filename);
        try { fs.unlinkSync(path.join(uploadsDir, `${att.id}${ext}`)); } catch { /* ignore */ }
      }

      db.prepare(`DELETE FROM "Project" WHERE "id" = ?`).run(id);
      return jsonResult({ message: `Feature ${id} deleted.` });
    }
  );

  // ── kanban_update_feature ─────────────────────────────────────────────────

  server.tool(
    "kanban_update_feature",
    "Update an existing feature's name, description, or color",
    {
      id: z.string().describe("Feature ID"),
      name: z.string().optional().describe("New feature name"),
      description: z.string().optional().describe("New feature description"),
      color: z.string().optional().describe('New hex color e.g. #6366f1'),
    },
    async ({ id, name, description, color }) => {
      const db = getDb(projectId);

      const existing = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
      if (!existing) return errorResult("Feature not found");

      const setClauses: string[] = [];
      const params: any[] = [];

      if (name !== undefined) { setClauses.push(`"name" = ?`); params.push(name); }
      if (description !== undefined) { setClauses.push(`"description" = ?`); params.push(description); }
      if (color !== undefined) { setClauses.push(`"color" = ?`); params.push(color); }

      if (setClauses.length === 0) return errorResult("No valid fields to update");

      const now = nowIso();
      setClauses.push(`"updatedAt" = ?`);
      params.push(now);
      params.push(id);

      db.prepare(`UPDATE "Project" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...params);

      const row = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
      return jsonResult(row);
    }
  );
}
