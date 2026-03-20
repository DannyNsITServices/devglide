import { Router, Request, Response } from "express";
import { z } from "zod";
import { getDb, generateId, nowIso, appendVersionedEntry, getVersionedEntries } from "../db.js";
import path from "path";
import fs from "fs";
import { getUploadsDir } from "./attachments.js";

declare module "express" {
  interface Request {
    projectId?: string;
  }
}

export const issuesRouter: Router = Router();

function mapIssue(row: any) {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

// GET /api/issues
issuesRouter.get("/", (req: Request, res: Response) => {
  try {
    const { featureId, columnId, priority, type } = req.query;
    const db = getDb(req.projectId);

    const conditions: string[] = [];
    const params: any[] = [];

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
      .all(...params);

    res.json(rows.map(mapIssue));
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

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
issuesRouter.post("/", (req: Request, res: Response) => {
  try {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const { title, description, priority, type, labels, dueDate, featureId, columnId } = parsed.data;

    const db = getDb(req.projectId);
    const now = nowIso();
    const id = generateId();

    // Calculate order: max order in target column + 1
    const maxOrder = db
      .prepare(`SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`)
      .get(columnId) as { maxOrd: number | null } | undefined;
    const order = (maxOrder?.maxOrd ?? -1) + 1;

    db.prepare(
      `INSERT INTO "Issue" ("id", "title", "description", "type", "priority", "order", "labels", "dueDate", "projectId", "columnId", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      title,
      description ?? null,
      type ?? "TASK",
      priority ?? "MEDIUM",
      order,
      labels ?? "[]",
      dueDate ?? null,
      featureId,
      columnId,
      now
    );

    const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id);
    res.status(201).json(mapIssue(row));
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/issues/reorder  (defined before /:id to avoid route conflict)
issuesRouter.post("/reorder", (req: Request, res: Response) => {
  try {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
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
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(issueId);

    res.json(mapIssue(row));
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/issues/:id
issuesRouter.get("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
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
      .get(id);

    if (!row) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const attachments = db
      .prepare(`SELECT * FROM "Attachment" WHERE "issueId" = ?`)
      .all(id);

    const mapped = mapIssue(row);
    mapped.attachments = attachments;
    mapped.workLog = getVersionedEntries(db, id, "work_log");
    mapped.reviewHistory = getVersionedEntries(db, id, "review");

    res.json(mapped);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PATCH /api/issues/:id
issuesRouter.patch("/:id", (req: Request, res: Response) => {
  try {
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const id = req.params.id as string;
    const db = getDb(req.projectId);

    // Check issue exists
    const existing = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
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
    if (req.body.reviewFeedback && typeof req.body.reviewFeedback === "string" && req.body.reviewFeedback.trim()) {
      appendVersionedEntry(db, id, "review", req.body.reviewFeedback.trim());
    }

    const setClauses: string[] = [];
    const params: any[] = [];

    for (const [key, col] of Object.entries(allowedFields)) {
      if (req.body[key] !== undefined) {
        setClauses.push(`${col} = ?`);
        params.push(req.body[key]);
      }
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    // Always set updatedAt
    const now = nowIso();
    setClauses.push(`"updatedAt" = ?`);
    params.push(now);

    params.push(id);

    db.prepare(`UPDATE "Issue" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...params);

    const row = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id);
    res.json(mapIssue(row));
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/issues/:id/work-log
issuesRouter.get("/:id/work-log", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const db = getDb(req.projectId);
    const entries = getVersionedEntries(db, id, "work_log");
    res.json(entries);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/issues/:id/work-log
issuesRouter.post("/:id/work-log", (req: Request, res: Response) => {
  try {
    const parsed = contentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const id = req.params.id as string;
    const { content } = parsed.data;
    const db = getDb(req.projectId);
    const existing = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) { res.status(404).json({ error: "Issue not found" }); return; }
    const entry = appendVersionedEntry(db, id, "work_log", content.trim());
    db.prepare(`UPDATE "Issue" SET "updatedAt" = ? WHERE "id" = ?`).run(nowIso(), id);
    res.status(201).json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/issues/:id/review
issuesRouter.get("/:id/review", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const db = getDb(req.projectId);
    const entries = getVersionedEntries(db, id, "review");
    res.json(entries);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/issues/:id/review
issuesRouter.post("/:id/review", (req: Request, res: Response) => {
  try {
    const parsed = contentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const id = req.params.id as string;
    const { content } = parsed.data;
    const db = getDb(req.projectId);
    const existing = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) { res.status(404).json({ error: "Issue not found" }); return; }
    const entry = appendVersionedEntry(db, id, "review", content.trim());
    db.prepare(`UPDATE "Issue" SET "updatedAt" = ? WHERE "id" = ?`).run(nowIso(), id);
    res.status(201).json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /api/issues/:id
issuesRouter.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const db = getDb(req.projectId);

    // Check issue exists
    const existing = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
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
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});
