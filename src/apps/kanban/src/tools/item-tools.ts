import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { getDb, nowIso, appendVersionedEntry, getVersionedEntries, ftsUpdate, ftsDelete, type IssueRow, type CountRow, type MaxOrderRow, type ColumnRow } from "../db.js";
import { jsonResult, errorResult } from "../../../../packages/mcp-utils/src/index.js";
import { normalizeEscapes, mapIssueRow, resolveColumnId, truncateDescription, sanitizeFtsQuery } from "../mcp-helpers.js";
import { getUploadsDir } from "../routes/attachments.js";
import { KANBAN_PRIORITIES, KANBAN_ITEM_TYPES } from "../../../../packages/shared-types/src/index.js";
import { createKanbanItem } from "../kanban-create-helper.js";

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
      const params: unknown[] = [];

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
      const total = countRow.cnt ?? countRow.count ?? 0;

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
      const result = createKanbanItem(db, {
        title,
        description,
        featureId,
        columnId,
        columnName,
        priority,
        type,
        labels,
        dueDate: dueDate ?? null,
      });

      if (!result.ok) return errorResult(result.error);
      return jsonResult(mapIssueRow(result.item));
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
      const params: unknown[] = [];

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

      // Sync FTS index if any indexed fields changed
      if (title !== undefined || description !== undefined || labels !== undefined) {
        const current = db.prepare(`SELECT "title", "description", "labels" FROM "Issue" WHERE "id" = ?`).get(id) as Pick<IssueRow, 'title' | 'description' | 'labels'>;
        ftsUpdate(db, id,
          title ?? current.title,
          description !== undefined ? (description ? normalizeEscapes(description) : description) : (current.description ?? null),
          labels !== undefined ? JSON.stringify(labels) : current.labels,
        );
      }

      db.prepare(`UPDATE "Issue" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...params);

      const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as IssueRow | undefined;
      return jsonResult(mapIssueRow(row));
    }
  );

  // ── kanban_move_item ──────────────────────────────────────────────────────

  server.tool(
    "kanban_move_item",
    "Move a task or bug to a different column (status) and/or a different feature. When moving to another feature, the item keeps its work log, review history, and attachments. Cannot move items to the Done column — only the user can mark items as done.",
    {
      id: z.string().describe("Issue ID"),
      featureId: z.string().optional().describe("Target feature ID. If provided, moves the item to this feature. The column is resolved by columnName in the target feature (defaults to the item's current column name)."),
      columnId: z.string().optional().describe("Target column ID. Required if columnName is not provided and featureId is not set."),
      columnName: z.string().optional().describe("Target column name — e.g. 'In Progress', 'In Review', 'Testing'. Ignored if columnId is provided."),
    },
    async ({ id, featureId: targetFeatureId, columnId, columnName }) => {
      const db = getDb(projectId);

      const issue = db.prepare(`SELECT i.*, c."name" AS columnName FROM "Issue" i LEFT JOIN "Column" c ON i."columnId" = c."id" WHERE i."id" = ?`).get(id) as (IssueRow & { columnName?: string }) | undefined;
      if (!issue) return errorResult("Issue not found.");

      const movingFeature = targetFeatureId && targetFeatureId !== issue.projectId;

      // Validate target feature exists
      if (movingFeature) {
        const targetFeature = db.prepare(`SELECT "id" FROM "Project" WHERE "id" = ?`).get(targetFeatureId) as { id: string } | undefined;
        if (!targetFeature) return errorResult(`Target feature "${targetFeatureId}" not found.`);
      }

      const effectiveFeatureId = movingFeature ? targetFeatureId! : issue.projectId;

      // Resolve target column
      let resolvedColumnId = columnId;
      if (!resolvedColumnId) {
        // Use explicit columnName, or fall back to current column name when moving between features
        const targetColumnName = columnName ?? (movingFeature ? issue.columnName ?? 'Backlog' : undefined);
        if (targetColumnName) {
          const resolved = resolveColumnId(db, effectiveFeatureId, targetColumnName);
          if (!resolved) return errorResult(`Column "${targetColumnName}" not found in target feature.`);
          resolvedColumnId = resolved;
        }
      }
      if (!resolvedColumnId && !movingFeature) return errorResult("Either columnId, columnName, or featureId is required.");
      if (!resolvedColumnId) return errorResult("Could not resolve target column in the destination feature.");

      // Verify the target column belongs to the target feature
      const targetCol = db.prepare(`SELECT "name", "projectId" FROM "Column" WHERE "id" = ?`).get(resolvedColumnId) as Pick<ColumnRow, 'name' | 'projectId'> | undefined;
      if (!targetCol) return errorResult("Target column not found.");
      if (targetCol.projectId !== effectiveFeatureId) return errorResult("Target column does not belong to the target feature.");
      if (targetCol.name === "Done") return errorResult("Not allowed: only the user can move issues to the Done column.");

      const maxOrder = db.prepare(`SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`).get(resolvedColumnId) as MaxOrderRow | undefined;
      const order = (maxOrder?.maxOrd ?? maxOrder?.maxOrder ?? -1) + 1;

      const now = nowIso();
      db.prepare(`UPDATE "Issue" SET "projectId" = ?, "columnId" = ?, "order" = ?, "updatedAt" = ? WHERE "id" = ?`).run(effectiveFeatureId, resolvedColumnId, order, now, id);

      const row = db
        .prepare(
          `SELECT i.*, c."name" AS columnName, c."order" AS columnOrder, c."color" AS columnColor,
                  p."name" AS featureName, p."description" AS featureDescription, p."color" AS featureColor
           FROM "Issue" i
           LEFT JOIN "Column" c ON i."columnId" = c."id"
           LEFT JOIN "Project" p ON i."projectId" = p."id"
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

      ftsDelete(db, id);
      db.prepare(`DELETE FROM "Issue" WHERE "id" = ?`).run(id);
      return jsonResult({ message: `Item ${id} deleted.` });
    }
  );

  // ── kanban_search_items ───────────────────────────────────────────────────

  server.tool(
    "kanban_search_items",
    "Full-text search across kanban items. Returns compact ranked results. Use this instead of kanban_list_items when you know what you're looking for.",
    {
      query: z.string().describe("Search query — matches against title, description, and labels. Plain-text keywords (e.g. 'bug fix', 'PTY delivery')."),
      featureId: z.string().optional().describe("Filter results to a specific feature"),
      columnName: z.string().optional().describe("Filter by column name (status) — e.g. 'Todo', 'In Progress', 'Done'"),
      priority: z.enum(KANBAN_PRIORITIES).optional().describe("Filter by priority"),
      type: z.enum(KANBAN_ITEM_TYPES).optional().describe("Filter by item type — TASK or BUG"),
      limit: z.coerce.number().int().min(1).max(50).optional().describe("Max results to return (default 20, max 50)"),
    },
    async ({ query, featureId, columnName, priority, type, limit }) => {
      const db = getDb(projectId);
      const take = limit ?? 20;

      const safeQuery = sanitizeFtsQuery(query);
      if (!safeQuery) return errorResult("Search query is empty or contains only special characters.");

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (featureId) { conditions.push(`i."projectId" = ?`); params.push(featureId); }
      if (columnName) { conditions.push(`c."name" = ?`); params.push(columnName); }
      if (priority) { conditions.push(`i."priority" = ?`); params.push(priority); }
      if (type) { conditions.push(`i."type" = ?`); params.push(type); }

      const extraWhere = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

      const rows = db.prepare(
        `SELECT i."id", i."title", i."priority", i."type", i."labels",
                c."name" AS columnName,
                p."name" AS featureName, i."projectId" AS featureId,
                rank
         FROM "IssueFts" fts
         JOIN "Issue" i ON fts."id" = i."id"
         LEFT JOIN "Column" c ON i."columnId" = c."id"
         LEFT JOIN "Project" p ON i."projectId" = p."id"
         WHERE "IssueFts" MATCH ?
         ${extraWhere}
         ORDER BY rank
         LIMIT ?`
      ).all(safeQuery, ...params, take) as (Pick<IssueRow, 'id' | 'title' | 'priority' | 'type' | 'labels'> & { columnName: string; featureName: string; featureId: string; rank: number })[];

      return jsonResult({
        data: rows.map(r => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          type: r.type,
          labels: r.labels,
          columnName: r.columnName,
          featureName: r.featureName,
          featureId: r.featureId,
        })),
        total: rows.length,
      });
    }
  );
}
