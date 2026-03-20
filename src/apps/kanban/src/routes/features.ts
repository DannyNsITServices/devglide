import { Router, Request, Response } from "express";
import { getDb, generateId, nowIso } from "../db.js";
import path from "path";
import fs from "fs";
import { getUploadsDir } from "./attachments.js";

export const featuresRouter: Router = Router();

const DEFAULT_COLUMNS = [
  { name: "Backlog", color: "#64748b", order: 0 },
  { name: "Todo", color: "#3b82f6", order: 1 },
  { name: "In Progress", color: "#f59e0b", order: 2 },
  { name: "In Review", color: "#8b5cf6", order: 3 },
  { name: "Testing", color: "#14b8a6", order: 4 },
  { name: "Done", color: "#22c55e", order: 5 },
];

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
      .all() as any[];

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
    const { name, description, color } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    if (name.length > 500) {
      res.status(400).json({ error: "name must be at most 500 characters" });
      return;
    }

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

    const feature = db.prepare(`SELECT * FROM "Project" WHERE "id" = ?`).get(id) as any;

    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const columns = db
      .prepare(`SELECT * FROM "Column" WHERE "projectId" = ? ORDER BY "order" ASC`)
      .all(id) as any[];

    const issues = db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(*) FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'review') AS reviewCount,
                (SELECT COUNT(*) FROM "VersionedEntry" ve WHERE ve."issueId" = i."id" AND ve."type" = 'work_log') AS workLogCount
         FROM "Issue" i WHERE i."projectId" = ? ORDER BY i."order" ASC`
      )
      .all(id) as any[];

    // Group issues by columnId
    const issuesByColumn = new Map<string, any[]>();
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
      .all(id) as any[];

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
