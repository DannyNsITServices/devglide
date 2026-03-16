import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, nowIso, appendVersionedEntry, getVersionedEntries } from "../db.js";
import { jsonResult, errorResult } from "../../../../packages/mcp-utils/src/index.js";
import { normalizeEscapes } from "../mcp-helpers.js";

export function registerVersionedEntryTools(server: McpServer, projectId?: string | null): void {

  // ── kanban_append_work_log ────────────────────────────────────────────────

  server.tool(
    "kanban_append_work_log",
    "Append a work log entry to a task (params: id, content). Records what was done while working on the task. Entries are append-only with automatic versioning.",
    {
      id: z.string().describe("Issue ID"),
      content: z.string().describe("Work log content (markdown supported)"),
    },
    async ({ id, content }) => {
      const db = getDb(projectId);
      const issue = db.prepare('SELECT "id" FROM "Issue" WHERE "id" = ?').get(id);
      if (!issue) return errorResult("Item not found");
      const entry = appendVersionedEntry(db, id, "work_log", normalizeEscapes(content));
      db.prepare('UPDATE "Issue" SET "updatedAt" = ? WHERE "id" = ?').run(nowIso(), id);
      return jsonResult(entry);
    }
  );

  // ── kanban_get_work_log ───────────────────────────────────────────────────

  server.tool(
    "kanban_get_work_log",
    "Get the full work log history for a task, ordered by version",
    { id: z.string().describe("Issue ID") },
    async ({ id }) => {
      const db = getDb(projectId);
      const entries = getVersionedEntries(db, id, "work_log");
      return jsonResult({ issueId: id, entries });
    }
  );

  // ── kanban_append_review ──────────────────────────────────────────────────

  server.tool(
    "kanban_append_review",
    "Append review feedback to a task (params: id, content). Used when reviewing work and providing notes for the next iteration. Entries are append-only with automatic versioning.",
    {
      id: z.string().describe("Issue ID"),
      content: z.string().describe("Review feedback content (markdown supported)"),
    },
    async ({ id, content }) => {
      const db = getDb(projectId);
      const issue = db.prepare('SELECT "id" FROM "Issue" WHERE "id" = ?').get(id);
      if (!issue) return errorResult("Item not found");
      const entry = appendVersionedEntry(db, id, "review", normalizeEscapes(content));
      db.prepare('UPDATE "Issue" SET "updatedAt" = ? WHERE "id" = ?').run(nowIso(), id);
      return jsonResult(entry);
    }
  );

  // ── kanban_get_review_history ─────────────────────────────────────────────

  server.tool(
    "kanban_get_review_history",
    "Get the full review feedback history for a task, ordered by version",
    { id: z.string().describe("Issue ID") },
    async ({ id }) => {
      const db = getDb(projectId);
      const entries = getVersionedEntries(db, id, "review");
      return jsonResult({ issueId: id, entries });
    }
  );
}
