import { Router, Request, Response } from "express";
import { getDb, generateId } from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { PROJECTS_DIR } from "../../../../packages/paths.js";

function getUploadsDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, 'uploads');
}

/**
 * Sanitize a filename to prevent Content-Disposition header injection.
 * Strips everything except alphanumeric, dots, hyphens, underscores, and spaces.
 * Falls back to "download" if the result is empty after sanitization.
 */
function sanitizeFilename(filename: string): string {
  // Strip path separators to prevent directory traversal
  const basename = filename.replace(/^.*[/\\]/, "");
  // Keep only safe characters: alphanumeric, dot, hyphen, underscore, space
  const sanitized = basename.replace(/[^a-zA-Z0-9.\-_ ]/g, "");
  // Prevent empty filenames or dot-only filenames
  const trimmed = sanitized.replace(/^\.+/, "").trim();
  return trimmed || "download";
}

export const attachmentsRouter: Router = Router();

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// POST /api/attachments
attachmentsRouter.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const issueId = req.body.issueId;

    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!issueId) {
      res.status(400).json({ error: "issueId is required" });
      return;
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      res.status(400).json({
        error: `Invalid file type: ${file.mimetype}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
      });
      return;
    }

    const db = getDb(req.projectId);

    // Verify issue exists
    const issue = db.prepare(`SELECT "id" FROM "Issue" WHERE "id" = ?`).get(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const id = generateId();
    const safeFilename = sanitizeFilename(file.originalname);
    const ext = path.extname(safeFilename);

    const uploadsDir = getUploadsDir(req.projectId ?? 'default');
    await fsp.mkdir(uploadsDir, { recursive: true });

    const filePath = path.join(uploadsDir, `${id}${ext}`);
    await fsp.writeFile(filePath, file.buffer);

    // Create DB record (store sanitized filename)
    db.prepare(
      `INSERT INTO "Attachment" ("id", "filename", "mimeType", "size", "issueId")
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, safeFilename, file.mimetype, file.size, issueId);

    const row = db.prepare(`SELECT * FROM "Attachment" WHERE "id" = ?`).get(id);
    res.status(201).json(row);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/attachments/:id
attachmentsRouter.get("/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = getDb(req.projectId);

    const row = db.prepare(`SELECT * FROM "Attachment" WHERE "id" = ?`).get(id) as any;
    if (!row) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const ext = path.extname(row.filename);
    const filePath = path.join(getUploadsDir(req.projectId ?? 'default'), `${id}${ext}`);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Attachment file not found on disk" });
      return;
    }

    // Sanitize filename on output as defense-in-depth (guards against
    // pre-existing records stored before upload-time sanitization was added)
    const safeDownloadName = sanitizeFilename(row.filename);
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeDownloadName}"`
    );
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /api/attachments/:id
attachmentsRouter.delete("/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = getDb(req.projectId);

    const row = db.prepare(`SELECT * FROM "Attachment" WHERE "id" = ?`).get(id) as any;
    if (!row) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    // Delete file from disk (ignore errors)
    const ext = path.extname(row.filename);
    const filePath = path.join(getUploadsDir(req.projectId ?? 'default'), `${id}${ext}`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore errors — file may already be deleted
    }

    // Delete DB record
    db.prepare(`DELETE FROM "Attachment" WHERE "id" = ?`).run(id);

    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});
