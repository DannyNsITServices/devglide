import { Router, Request, Response } from "express";
import { z } from "zod";
import { getDb, generateId, nowIso } from "../db.js";
import path from "path";
import fs from "fs";
import { getUploadsDir } from "./attachments.js";
import { DEFAULT_COLUMNS } from "../mcp-helpers.js";
import { asyncHandler, badRequest, notFound } from "../../../../packages/error-middleware.js";

type JsonRow = Record<string, unknown>;
type FeatureIssueRow = JsonRow & { columnId: string };
type FeatureColumnRow = JsonRow & { id: string };

const createFeatureSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional().nullable(),
  color: z.string().optional(),
});

const updateFeatureSchema = createFeatureSchema.partial();

const idParamSchema = z.object({
  id: z.string().min(1),
});

export const featuresRouter: Router = Router();

function mapColumn(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

function mapIssue(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

// GET /api/features
featuresRouter.get("/", asyncHandler(async (req: Request, res: Response) => {
    const db = getDb(req.projectId);

    const rows = db
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM "Issue" i
           JOIN "Column" c ON c."id" = i."columnId"
           WHERE i."projectId" = p."id" AND c."name" != 'Done') AS issueCount
         FROM "Project" p
         ORDER BY p."name" COLLATE NOCASE ASC`
      )
      .all() as { id: string; name: string; description: string | null; color: string; createdAt: string; updatedAt: string; issueCount: number }[];

    const features = rows.map((row) => {
      const { issueCount, ...rest } = row;
      return { ...rest, _count: { issues: issueCount } };
    });

    res.json(features);
}));

// POST /api/features
featuresRouter.post("/", asyncHandler(async (req: Request, res: Response) => {
    const parsed = createFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    const { name, description, color } = parsed.data;

    const db = getDb(req.projectId);
    const now = nowIso();
    const featureId = generateId();

    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO "Project" ("id", "name", "description", "color", "updatedAt")
         VALUES (?, ?, ?, ?, ?)`
      ).run(featureId, name, description ?? null, color ?? "#6366f1", now);

      for (const col of DEFAULT_COLUMNS) {
        const colId = generateId();
        db.prepare(
          `INSERT INTO "Column" ("id", "name", "order", "color", "projectId", "updatedAt")
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(colId, col.name, col.order, col.color, featureId, now);
      }
    });

    txn();

    const feature = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(featureId) as Record<string, unknown>;
    const columns = db
      .prepare(`SELECT * FROM "Column" WHERE "projectId" = ? ORDER BY "order" ASC`)
      .all(featureId) as JsonRow[];

    res.status(201).json({ ...feature, columns: columns.map(mapColumn) });
}));

// GET /api/features/:id
featuresRouter.get("/:id", asyncHandler(async (req: Request, res: Response) => {
    const pp = idParamSchema.safeParse(req.params);
    if (!pp.success) { badRequest(res, 'Invalid ID'); return; }
    const { id } = pp.data;
    const db = getDb(req.projectId);

    const feature = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id) as Record<string, unknown> | undefined;

    if (!feature) {
      notFound(res, "Feature not found");
      return;
    }

    const columns = db
      .prepare(`SELECT * FROM "Column" WHERE "projectId" = ? ORDER BY "order" ASC`)
      .all(id) as FeatureColumnRow[];

    const issues = db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(*) FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'review') AS reviewCount,
                (SELECT COUNT(*) FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'work_log') AS workLogCount
         FROM "Issue" i WHERE i."projectId" = ? ORDER BY i."order" ASC`
      )
      .all(id) as FeatureIssueRow[];

    // Group issues by columnId
    const issuesByColumn = new Map<string, JsonRow[]>();
    for (const issue of issues) {
      const list = issuesByColumn.get(issue.columnId) ?? [];
      const mappedIssue = mapIssue(issue);
      if (mappedIssue) list.push(mappedIssue);
      issuesByColumn.set(issue.columnId, list);
    }

    const mappedColumns = columns.map((col) => ({
      ...mapColumn(col),
      issues: issuesByColumn.get(col.id) ?? [],
    }));

    res.json({ ...feature, columns: mappedColumns });
}));

// PATCH /api/features/:id
featuresRouter.patch("/:id", asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    const pp = idParamSchema.safeParse(req.params);
    if (!pp.success) { badRequest(res, 'Invalid ID'); return; }
    const { id } = pp.data;
    const db = getDb(req.projectId);

    const existing = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
    if (!existing) {
      notFound(res, "Feature not found");
      return;
    }

    const allowedFields: Record<string, string> = {
      name: '"name"',
      description: '"description"',
      color: '"color"',
    };

    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    const data: Record<string, unknown> = parsed.data;

    for (const [key, col] of Object.entries(allowedFields)) {
      if (data[key] !== undefined) {
        setClauses.push(`${col} = ?`);
        params.push(data[key] as string | number | null);
      }
    }

    if (setClauses.length === 0) {
      badRequest(res, "No valid fields to update");
      return;
    }

    const now = nowIso();
    setClauses.push(`"updatedAt" = ?`);
    params.push(now);

    params.push(id);

    db.prepare(`UPDATE "Project" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...params);

    const row = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
    res.json(row);
}));

// DELETE /api/features/:id
featuresRouter.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
    const pp = idParamSchema.safeParse(req.params);
    if (!pp.success) { badRequest(res, 'Invalid ID'); return; }
    const { id } = pp.data;
    const db = getDb(req.projectId);

    const existing = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
    if (!existing) {
      notFound(res, "Feature not found");
      return;
    }

    // Clean up attachment files from disk before deleting
    const attachments = db
      .prepare(
        `SELECT a."id", a."filename" FROM "Attachment" a
         JOIN "Issue" i ON a."issueId" = i."id"
         WHERE i."projectId" = ?`
      )
      .all(id) as { id: string; filename: string }[];

    for (const att of attachments) {
      const ext = path.extname(att.filename);
      const filePath = path.join(getUploadsDir(req.projectId ?? 'default'), `${att.id}${ext}`);
      try { fs.unlinkSync(filePath); } catch {}
    }

    db.prepare(`DELETE FROM "Project" WHERE "id" = ?`).run(id);

    res.json({ success: true });
}));
