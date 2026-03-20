import { Router, Request, Response } from "express";
import { z } from "zod";
import { getDb, nowIso, appendVersionedEntry, getVersionedEntries } from "../db.js";
import path from "path";
import fs from "fs";
import { getUploadsDir } from "./attachments.js";
import type { IssueRow } from "../db.js";
import { createKanbanItem } from "../kanban-create-helper.js";
import { asyncHandler } from "../../../../packages/error-middleware.js";

declare module "express" {
  interface Request {
    projectId?: string;
  }
}

export const issuesRouter: Router = Router();

type JsonRow = { projectId?: string } & Record<string, unknown>;
type IssueLikeRow = { projectId?: string } & object;

const listIssuesQuerySchema = z.object({
  featureId: z.string().optional(),
  columnId: z.string().optional(),
  priority: z.string().optional(),
  type: z.string().optional(),
});

const issueIdParamSchema = z.object({
  id: z.string().min(1, "issue id is required"),
});

function mapIssue(row: IssueLikeRow | undefined): Record<string, unknown> | undefined {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

// GET /api/issues
issuesRouter.get("/", asyncHandler(async (req: Request, res: Response) => {
    const qp = listIssuesQuerySchema.safeParse(req.query);
    const { featureId, columnId, priority, type } = qp.success ? qp.data : {};
    const db = getDb(req.projectId);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (featureId) {
      conditions.push(`i."projectId" = ?`);
      params.push(featureId);
    }
    if (columnId) {
      conditions.push(`i."columnId" = ?`);
      params.push(columnId);
    }
    if (priority) {
      conditions.push(`i."priority" = ?`);
      params.push(priority);
    }
    if (type) {
      conditions.push(`i."type" = ?`);
      params.push(type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `SELECT i.*, c.name AS columnName, c."order" AS columnOrder, c.color AS columnColor
         FROM "Issue" i
         LEFT JOIN "Column" c ON i."columnId" = c."id"
         ${where}
         ORDER BY i."order" ASC`
      )
      .all(...params) as JsonRow[];

    res.json(rows.map(mapIssue));
}));

import { KANBAN_PRIORITIES, KANBAN_ITEM_TYPES_EXTENDED } from "../../../../packages/shared-types/src/index.js";

const createIssueSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  priority: z.enum(KANBAN_PRIORITIES).optional(),
  type: z.enum(KANBAN_ITEM_TYPES_EXTENDED).optional(),
  labels: z.union([z.string(), z.array(z.string())]).optional(),
  dueDate: z.string().optional().nullable(),
  featureId: z.string().min(1),
  columnId: z.string().min(1),
});

const updateIssueSchema = createIssueSchema.partial().extend({
  columnId: z.string().optional(),
  reviewFeedback: z.string().optional(),
});

const reorderSchema = z.object({
  issueId: z.string().min(1),
  newColumnId: z.string().min(1),
  newOrder: z.number(),
});

const contentSchema = z.object({
  content: z.string().min(1),
});

// POST /api/issues
issuesRouter.post("/", asyncHandler(async (req: Request, res: Response) => {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { title, description, priority, type, labels, dueDate, featureId, columnId } = parsed.data;

    const db = getDb(req.projectId);
    const normalizedLabels = Array.isArray(labels)
      ? labels
      : typeof labels === "string"
        ? (() => {
            try {
              const parsedLabels = JSON.parse(labels);
              return Array.isArray(parsedLabels) ? parsedLabels.map(String) : [labels];
            } catch {
              return [labels];
            }
          })()
        : undefined;

    const result = createKanbanItem(db, {
      title,
      description,
      featureId,
      columnId,
      priority,
      type,
      labels: normalizedLabels,
      dueDate: dueDate ?? null,
    });

    if (!result.ok) {
      badRequest(res, result.error);
      return;
    }

    res.status(201).json(mapIssue(result.item));
}));

// POST /api/issues/reorder  (defined before /:id to avoid route conflict)
issuesRouter.post("/reorder", asyncHandler(async (req: Request, res: Response) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { issueId, newColumnId, newOrder } = parsed.data;

    const db = getDb(req.projectId);
    const now = nowIso();

    const txn = db.transaction(() => {
      // Verify issue exists BEFORE shifting
      const existing = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(issueId);
      if (!existing) return null;

      // Shift existing issues in target column
      db.prepare(
        `UPDATE "Issue" SET "order" = "order" + 1, "updatedAt" = ? WHERE "columnId" = ? AND "order" >= ?`
      ).run(now, newColumnId, newOrder);

      // Update the moved issue
      db.prepare(
        `UPDATE "Issue" SET "columnId" = ?, "order" = ?, "updatedAt" = ? WHERE "id" = ?`
      ).run(newColumnId, newOrder, now, issueId);

      return existing;
    });

    const result = txn();
    if (!result) {
      notFound(res, "Issue not found");
      return;
    }

    const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(issueId) as JsonRow | undefined;

    res.json(mapIssue(row));
}));

// GET /api/issues/:id
issuesRouter.get("/:id", asyncHandler(async (req: Request, res: Response) => {
    const idParams = issueIdParamSchema.safeParse(req.params);
    if (!idParams.success) {
      badRequest(res, idParams.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { id } = idParams.data;
    const db = getDb(req.projectId);

    const row = db
      .prepare(
        `SELECT i.*,
                c.name AS columnName, c."order" AS columnOrder, c.color AS columnColor,
                p.name AS featureName, p.description AS featureDescription, p.color AS featureColor
         FROM "Issue" i
         LEFT JOIN "Column" c ON i."columnId" = c."id"
         LEFT JOIN "Project" p ON i."projectId" = p."id"
         WHERE i."id" = ?`
      )
      .get(id) as JsonRow | undefined;

    if (!row) {
      notFound(res, "Issue not found");
      return;
    }

    const attachments = db
      .prepare(`SELECT * FROM "Attachment" WHERE "issueId" = ?`)
      .all(id);

    const mapped = mapIssue(row);
    if (!mapped) {
      res.status(500).json({ error: "Failed to map issue" });
      return;
    }
    mapped.attachments = attachments;
    mapped.workLog = getVersionedEntries(db, id, "work_log");
    mapped.reviewHistory = getVersionedEntries(db, id, "review");

    res.json(mapped);
}));

// PATCH /api/issues/:id
issuesRouter.patch("/:id", asyncHandler(async (req: Request, res: Response) => {
    const params = issueIdParamSchema.safeParse(req.params);
    if (!params.success) {
      badRequest(res, params.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    const { id } = params.data;
    const db = getDb(req.projectId);

    // Check issue exists
    const existing = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) {
      notFound(res, "Issue not found");
      return;
    }

    const allowedFields: Record<string, string> = {
      title: '"title"',
      description: '"description"',
      priority: '"priority"',
      labels: '"labels"',
      dueDate: '"dueDate"',
      columnId: '"columnId"',
      order: '"order"',
      type: '"type"',
    };

    // Redirect reviewFeedback to versioned entry
    const { reviewFeedback, ...updateFields } = parsed.data;
    if (reviewFeedback && reviewFeedback.trim()) {
      appendVersionedEntry(db, id, "review", reviewFeedback.trim());
    }

    const setClauses: string[] = [];
    const updateParams: (string | number | null)[] = [];
    const data: Record<string, unknown> = updateFields;

    for (const [key, col] of Object.entries(allowedFields)) {
      if (data[key] !== undefined) {
        setClauses.push(`${col} = ?`);
        updateParams.push(data[key] as string | number | null);
      }
    }

    if (setClauses.length === 0) {
      badRequest(res, "No valid fields to update");
      return;
    }

    // Always set updatedAt
    const now = nowIso();
    setClauses.push(`"updatedAt" = ?`);
    updateParams.push(now);

    updateParams.push(id);

    db.prepare(`UPDATE "Issue" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...updateParams);

    const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as JsonRow | undefined;
    res.json(mapIssue(row));
}));

// GET /api/issues/:id/work-log
issuesRouter.get("/:id/work-log", asyncHandler(async (req: Request, res: Response) => {
    const params = issueIdParamSchema.safeParse(req.params);
    if (!params.success) {
      badRequest(res, params.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { id } = params.data;
    const db = getDb(req.projectId);
    const entries = getVersionedEntries(db, id, "work_log");
    res.json(entries);
}));

// POST /api/issues/:id/work-log
issuesRouter.post("/:id/work-log", asyncHandler(async (req: Request, res: Response) => {
    const params = issueIdParamSchema.safeParse(req.params);
    if (!params.success) {
      badRequest(res, params.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const parsed = contentSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { id } = params.data;
    const { content } = parsed.data;
    const db = getDb(req.projectId);
    const existing = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) { notFound(res, "Issue not found"); return; }
    const entry = appendVersionedEntry(db, id, "work_log", content.trim());
    db.prepare(`UPDATE "Issue" SET "updatedAt" = ? WHERE "id" = ?`).run(nowIso(), id);
    res.status(201).json(entry);
}));

// GET /api/issues/:id/review
issuesRouter.get("/:id/review", asyncHandler(async (req: Request, res: Response) => {
    const params = issueIdParamSchema.safeParse(req.params);
    if (!params.success) {
      badRequest(res, params.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { id } = params.data;
    const db = getDb(req.projectId);
    const entries = getVersionedEntries(db, id, "review");
    res.json(entries);
}));

// POST /api/issues/:id/review
issuesRouter.post("/:id/review", asyncHandler(async (req: Request, res: Response) => {
    const params = issueIdParamSchema.safeParse(req.params);
    if (!params.success) {
      badRequest(res, params.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const parsed = contentSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { id } = params.data;
    const { content } = parsed.data;
    const db = getDb(req.projectId);
    const existing = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) { notFound(res, "Issue not found"); return; }
    const entry = appendVersionedEntry(db, id, "review", content.trim());
    db.prepare(`UPDATE "Issue" SET "updatedAt" = ? WHERE "id" = ?`).run(nowIso(), id);
    res.status(201).json(entry);
}));

// DELETE /api/issues/:id
issuesRouter.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
    const params = issueIdParamSchema.safeParse(req.params);
    if (!params.success) {
      badRequest(res, params.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { id } = params.data;
    const db = getDb(req.projectId);

    // Check issue exists
    const existing = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id) as IssueRow | undefined;
    if (!existing) {
      notFound(res, "Issue not found");
      return;
    }

    // Fetch attachments so we can delete files from disk
    const attachments = db
      .prepare(`SELECT * FROM "Attachment" WHERE "issueId" = ?`)
      .all(id) as { id: string; filename: string }[];

    // Delete attachment files from disk
    for (const att of attachments) {
      const ext = path.extname(att.filename);
      const filePath = path.join(getUploadsDir(req.projectId ?? 'default'), `${att.id}${ext}`);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore errors (file may not exist)
      }
    }

    // Delete the issue (CASCADE handles attachment DB records)
    db.prepare(`DELETE FROM "Issue" WHERE "id" = ?`).run(id);

    res.json({ success: true });
}));
