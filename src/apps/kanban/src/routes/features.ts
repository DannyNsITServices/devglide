import { Router, Request, Response } from "express";
import { z } from "zod";
import { getDb, generateId, nowIso } from "../db.js";
import path from "path";
import fs from "fs";
import { getUploadsDir } from "./attachments.js";
import { DEFAULT_COLUMNS } from "../mcp-helpers.js";

const createFeatureSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional().nullable(),
  color: z.string().optional(),
});

const updateFeatureSchema = createFeatureSchema.partial();

export const featuresRouter: Router = Router();

function mapColumn(row: any) {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

function mapIssue(row: any) {
  if (!row) return row;
  const { projectId, ...rest } = row;
  return { ...rest, featureId: projectId };
}

// GET /api/features
featuresRouter.get("/", (req: Request, res: Response) => {
  try {
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
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/features
featuresRouter.post("/", (req: Request, res: Response) => {
  try {
    const parsed = createFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
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
      .all(featureId);

    res.status(201).json({ ...feature, columns: columns.map(mapColumn) });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/features/:id
featuresRouter.get("/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = getDb(req.projectId);

    const feature = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id) as Record<string, unknown> | undefined;

    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const columns = db
      .prepare(`SELECT * FROM "Column" WHERE "projectId" = ? ORDER BY "order" ASC`)
      .all(id) as Record<string, unknown>[];

    const issues = db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(*) FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'review') AS reviewCount,
                (SELECT COUNT(*) FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'work_log') AS workLogCount
         FROM "Issue" i WHERE i."projectId" = ? ORDER BY i."order" ASC`
      )
      .all(id) as Record<string, unknown>[];

    // Group issues by columnId
    const issuesByColumn = new Map<string, Record<string, unknown>[]>();
    for (const issue of issues) {
      const list = issuesByColumn.get(issue.columnId) ?? [];
      list.push(mapIssue(issue));
      issuesByColumn.set(issue.columnId, list);
    }

    const mappedColumns = columns.map((col) => ({
      ...mapColumn(col),
      issues: issuesByColumn.get(col.id) ?? [],
    }));

    res.json({ ...feature, columns: mappedColumns });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PATCH /api/features/:id
featuresRouter.patch("/:id", (req: Request, res: Response) => {
  try {
    const parsed = updateFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const { id } = req.params;
    const db = getDb(req.projectId);

    const existing = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const allowedFields: Record<string, string> = {
      name: '"name"',
      description: '"description"',
      color: '"color"',
    };

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

    const now = nowIso();
    setClauses.push(`"updatedAt" = ?`);
    params.push(now);

    params.push(id);

    db.prepare(`UPDATE "Project" SET ${setClauses.join(", ")} WHERE "id" = ?`).run(...params);

    const row = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
    res.json(row);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /api/features/:id
featuresRouter.delete("/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = getDb(req.projectId);

    const existing = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: "Feature not found" });
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
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});
