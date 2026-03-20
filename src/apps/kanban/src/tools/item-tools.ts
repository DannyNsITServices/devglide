import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { getDb, generateId, nowIso, appendVersionedEntry, getVersionedEntries, type IssueRow, type CountRow, type MaxOrderRow, type ColumnRow } from "../db.js";
import { jsonResult, errorResult } from "../../../../packages/mcp-utils/src/index.js";
import { normalizeEscapes, mapIssueRow, resolveColumnId, truncateDescription } from "../mcp-helpers.js";
import { getUploadsDir } from "../routes/attachments.js";
import { KANBAN_PRIORITIES, KANBAN_ITEM_TYPES } from "../../../../packages/shared-types/src/index.js";

export function registerItemTools(server: McpServer, projectId?: string | null): void {

  // ── kanban_list_items ─────────────────────────────────────────────────────

  server.tool(
    "kanban_list_items",
    "List tasks and bugs with pagination. Descriptions are truncated to 200 chars — use kanban_get_item for full details. Supports filtering by feature, column, priority, type (TASK/BUG), column name (status), or review feedback.",
    {
      featureId: z.string().optional().describe("Filter by feature ID"),
      columnId: z.string().optional().describe("Filter by column ID"),
      columnName: z.string().optional().describe("Filter by column name (status) — case-sensitive: 'Backlog', 'Todo', 'In Progress', 'In Review', 'Testing', 'Done'. Ignored if columnId is provided."),
      priority: z.enum(KANBAN_PRIORITIES).optional().describe("Filter by priority"),
      type: z.enum(KANBAN_ITEM_TYPES).optional().describe("Filter by item type — TASK or BUG"),
      hasReviewFeedback: z.preprocess(
        (val) => (typeof val === "string" ? val === "true" : val),
        z.boolean().optional()
      ).describe("If true, return only issues that have review feedback populated"),
      limit: z.coerce.number().int().min(1).max(50).optional().describe("Max items to return (default 25, max 50)"),
      offset: z.coerce.number().int().min(0).optional().describe("Number of items to skip (default 0)"),
      fields: z.preprocess(
        (val) => {
          if (typeof val === "string") {
            try { return JSON.parse(val); } catch { return [val]; }
          }
          return val;
        },
        z.array(z.string()).optional()
      ).describe("Return only these fields per issue (e.g. ['id', 'title', 'priority', 'columnName']). 'columnName' is a virtual field resolved from the column relation. If omitted, all fields are returned."),
    },
    async ({ featureId, columnId, columnName, priority, type, hasReviewFeedback, limit, offset, fields }) => {
      const db = getDb(projectId);
      const take = limit ?? 25;
      const skip = offset ?? 0;

      const conditions: string[] = [];
      const params: any[] = [];

      if (featureId) { conditions.push(`i."projectId" = ?`); params.push(featureId); }
      if (columnId) { conditions.push(`i."columnId" = ?`); params.push(columnId); }
      else if (columnName) { conditions.push(`c."name" = ?`); params.push(columnName); }
      if (priority) { conditions.push(`i."priority" = ?`); params.push(priority); }
      if (type) { conditions.push(`i."type" = ?`); params.push(type); }
      if (hasReviewFeedback) {
        conditions.push(`EXISTS (SELECT 1 FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'review')`);
        conditions.push(`c."name" != 'Done'`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM "Issue" i LEFT JOIN "Column" c ON i."columnId" = c."id" ${where}`)
        .get(...params) as CountRow;
      const total = countRow.cnt;

      const rows = db
        .prepare(
          `SELECT i.*,
                  c."name" AS columnName, c."order" AS columnOrder, c."color" AS columnColor,
                  p."name" AS featureName, p."description" AS featureDescription, p."color" AS featureColor
           FROM "Issue" i
           LEFT JOIN "Column" c ON i."columnId" = c."id"
           LEFT JOIN "Project" p ON i."projectId" = p."id"
           ${where}
           ORDER BY i."order" ASC
           LIMIT ? OFFSET ?`
        )
        .all(...params, take, skip) as IssueRow[];

      let data: unknown[];

      if (fields && fields.length > 0) {
        data = rows.map((row) => {
          const mapped = mapIssueRow(row) as Record<string, unknown>;
          const picked: Record<string, unknown> = {};
          for (const f of fields) {
            if (f in mapped) {
              picked[f] = f === "description" ? truncateDescription(mapped[f] as string) : mapped[f];
            } else if (f === "columnName") {
              picked.columnName = row.columnName ?? null;
            } else if (f === "featureName") {
              picked.featureName = row.featureName ?? null;
            }
          }
          return picked;
        });
      } else {
        data = rows.map((row) => {
          const mapped = mapIssueRow(row);
          mapped.description = truncateDescription(mapped.description);
          return mapped;
        });
      }

      return jsonResult({
        data,
        pagination: { total, limit: take, offset: skip, hasMore: skip + take < total },
      });
    }
  );

  // ── kanban_create_item ────────────────────────────────────────────────────

  server.tool(
    "kanban_create_item",
    "Create a new task or bug on a feature's kanban board. Defaults to the Backlog column if no column is specified.",
    {
      title: z.string().describe("Issue title"),
      description: z.string().optional().describe("Issue description"),
      featureId: z.string().describe("Feature ID"),
      columnId: z.string().optional().describe("Column ID to place the issue in. Optional — defaults to Backlog column if neither columnId nor columnName is provided."),
      columnName: z.string().optional().describe("Column name to place the issue in — e.g. 'Backlog', 'Todo'. Defaults to 'Backlog' if omitted. Ignored if columnId is provided."),
      priority: z.enum(KANBAN_PRIORITIES).optional().describe("Priority level"),
      type: z.enum(KANBAN_ITEM_TYPES).optional().describe("Item type — defaults to TASK"),
      labels: z.preprocess(
        (val) => {
          if (typeof val === "string") { try { return JSON.parse(val); } catch { return [val]; } }
          return val;
        },
        z.array(z.string()).optional()
      ).describe("List of label strings"),
      dueDate: z.string().optional().describe("Due date ISO string e.g. 2025-12-31"),
    },
    async ({ title, description, featureId, columnId, columnName, priority, type, labels, dueDate }) => {
      const db = getDb(projectId);

      const effectiveColumnName = columnName ?? "Backlog";
      let resolvedColumnId = columnId;
      if (!resolvedColumnId) {
        const resolved = resolveColumnId(db, featureId, effectiveColumnName);
        if (!resolved) return errorResult(`Column "${effectiveColumnName}" not found in feature.`);
        resolvedColumnId = resolved;
      }

      // Validate target column is Backlog or Todo — auto-correct to Todo if invalid
      const targetCol = db.prepare(`SELECT "name" FROM "Column" WHERE "id" = ?`).get(resolvedColumnId) as Pick<ColumnRow, 'name'> | undefined;
      if (!targetCol || !["Backlog", "Todo"].includes(targetCol.name)) {
        const fallback = resolveColumnId(db, featureId, "Todo");
        if (!fallback) return errorResult("Could not resolve default Todo column.");
        resolvedColumnId = fallback;
      }

      const maxOrder = db.prepare(`SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`).get(resolvedColumnId) as MaxOrderRow | undefined;
      const order = (maxOrder?.maxOrd ?? -1) + 1;

      const now = nowIso();
      const id = generateId();

      db.prepare(
        `INSERT INTO "Issue" ("id", "title", "description", "type", "priority", "order", "labels", "dueDate", "projectId", "columnId", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, title, description ? normalizeEscapes(description) : null, type ?? "TASK", priority ?? "MEDIUM", order, JSON.stringify(labels ?? []), dueDate ?? null, featureId, resolvedColumnId, now);

      const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as IssueRow | undefined;
      return jsonResult(mapIssueRow(row));
    }
  );

  // ── kanban_update_item ────────────────────────────────────────────────────

  server.tool(
    "kanban_update_item",
    "Update an existing task or bug",
    {
      id: z.string().describe("Issue ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      priority: z.enum(KANBAN_PRIORITIES).optional().describe("New priority"),
      type: z.enum(KANBAN_ITEM_TYPES).optional().describe("Change item type"),
      labels: z.preprocess(
        (val) => {
          if (typeof val === "string") { try { return JSON.parse(val); } catch { return [val]; } }
          return val;
        },
        z.array(z.string()).optional()
      ).describe("New labels"),
      dueDate: z.string().nullable().optional().describe("Due date or null to clear"),
      reviewFeedback: z.string().nullable().optional().describe("Review feedback (deprecated — use kanban_append_review instead). If provided, appends as a versioned review entry."),
    },
    async ({ id, title, description, priority, type, labels, dueDate, reviewFeedback }) => {
      const db = getDb(projectId);

      const existing = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(id);
      if (!existing) return errorResult("Item not found");

      if (reviewFeedback && reviewFeedback.trim()) {
        appendVersionedEntry(db, id, "review", reviewFeedback.trim());
      }

      const setClauses: string[] = [];
      const params: any[] = [];

      if (title !== undefined) { setClauses.push(`"title" = ?`); params.push(title); }
      if (description !== undefined) { setClauses.push(`"description" = ?`); params.push(description ? normalizeEscapes(description) : description); }
      if (priority !== undefined) { setClauses.push(`"priority" = ?`); params.push(priority); }
      if (type !== undefined) { setClauses.push(`"type" = ?`); params.push(type); }
      if (labels !== undefined) { setClauses.push(`"labels" = ?`); params.push(JSON.stringify(labels)); }
      if (dueDate !== undefined) { setClauses.push(`"dueDate" = ?`); params.push(dueDate ?? null); }

      const now = nowIso();
      setClauses.push(`"updatedAt" = ?`);
      params.push(now);
      params.push(id);

      db.prepare(`UPDATE "Issue" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...params);

      const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as IssueRow | undefined;
      return jsonResult(mapIssueRow(row));
    }
  );

  // ── kanban_move_item ──────────────────────────────────────────────────────

  server.tool(
    "kanban_move_item",
    "Move a task or bug to a different column (status). Cannot move items to the Done column — only the user can mark items as done.",
    {
      id: z.string().describe("Issue ID"),
      columnId: z.string().optional().describe("Target column ID. Required if columnName is not provided."),
      columnName: z.string().optional().describe("Target column name — e.g. 'In Progress', 'In Review', 'Testing'. Ignored if columnId is provided."),
    },
    async ({ id, columnId, columnName }) => {
      const db = getDb(projectId);

      const issue = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as IssueRow | undefined;
      if (!issue) return errorResult("Issue not found.");

      let resolvedColumnId = columnId;
      if (!resolvedColumnId && columnName) {
        const resolved = resolveColumnId(db, issue.projectId, columnName);
        if (!resolved) return errorResult(`Column "${columnName}" not found in feature.`);
        resolvedColumnId = resolved;
      }
      if (!resolvedColumnId) return errorResult("Either columnId or columnName is required.");

      const targetCol = db.prepare(`SELECT "name" FROM "Column" WHERE "id" = ?`).get(resolvedColumnId) as Pick<ColumnRow, 'name'> | undefined;
      if (targetCol?.name === "Done") return errorResult("Not allowed: only the user can move issues to the Done column.");

      const maxOrder = db.prepare(`SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`).get(resolvedColumnId) as MaxOrderRow | undefined;
      const order = (maxOrder?.maxOrd ?? -1) + 1;

      const now = nowIso();
      db.prepare(`UPDATE "Issue" SET "columnId" = ?, "order" = ?, "updatedAt" = ? WHERE "id" = ?`).run(resolvedColumnId, order, now, id);

      const row = db
        .prepare(
          `SELECT i.*, c."name" AS columnName, c."order" AS columnOrder, c."color" AS columnColor
           FROM "Issue" i LEFT JOIN "Column" c ON i."columnId" = c."id"
           WHERE i."id" = ?`
        )
        .get(id) as IssueRow | undefined;

      return jsonResult(mapIssueRow(row));
    }
  );

  // ── kanban_get_item ───────────────────────────────────────────────────────

  server.tool(
    "kanban_get_item",
    "Get full details of a single task or bug",
    { id: z.string().describe("Issue ID") },
    async ({ id }) => {
      const db = getDb(projectId);

      const row = db
        .prepare(
          `SELECT i.*,
                  c."name" AS columnName, c."order" AS columnOrder, c."color" AS columnColor,
                  p."name" AS featureName, p."description" AS featureDescription, p."color" AS featureColor
           FROM "Issue" i
           LEFT JOIN "Column" c ON i."columnId" = c."id"
           LEFT JOIN "Project" p ON i."projectId" = p."id"
           WHERE i."id" = ?`
        )
        .get(id) as IssueRow | undefined;

      if (!row) return errorResult("Item not found");

      return jsonResult({
        ...mapIssueRow(row),
        workLog: getVersionedEntries(db, id, "work_log"),
        reviewHistory: getVersionedEntries(db, id, "review"),
      });
    }
  );

  // ── kanban_delete_item ────────────────────────────────────────────────────

  server.tool(
    "kanban_delete_item",
    "Delete a task or bug",
    { id: z.string().describe("Issue ID") },
    async ({ id }) => {
      const db = getDb(projectId);
      const existing = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(id);
      if (!existing) return errorResult("Item not found");

      // Clean up attachment files from disk before deleting
      const attachments = db
        .prepare(`SELECT "id", "filename" FROM "Attachment" WHERE "issueId" = ?`)
        .all(id) as { id: string; filename: string }[];
      const uploadsDir = getUploadsDir(projectId ?? 'default');
      for (const att of attachments) {
        const ext = path.extname(att.filename);
        try { fs.unlinkSync(path.join(uploadsDir, `${att.id}${ext}`)); } catch { /* ignore */ }
      }

      db.prepare(`DELETE FROM "Issue" WHERE "id" = ?`).run(id);
      return jsonResult({ message: `Item ${id} deleted.` });
    }
  );
}
