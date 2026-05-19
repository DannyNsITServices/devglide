import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { historyStore } from "../services/history-store.js";

export const historyRouter: RouterType = Router();

const historyListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const historySearchQuerySchema = z.object({
  q: z.string().min(1, "Query parameter 'q' is required"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

const historyIdParamSchema = z.object({
  id: z.string().min(1, "history entry id is required"),
});

// List history (newest first)
historyRouter.get("/", (req, res) => {
  const query = historyListQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const result = historyStore.list(query.data.limit, query.data.offset);
  res.json(result);
});

// Search history
historyRouter.get("/search", (req, res) => {
  const parsed = historySearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const entries = historyStore.search(parsed.data.q, parsed.data.limit);
  res.json({ entries, total: entries.length });
});

// Analytics
historyRouter.get("/analytics", (_req, res) => {
  res.json(historyStore.getAnalytics());
});

// Get single entry
historyRouter.get("/:id", (req, res) => {
  const params = historyIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const entry = historyStore.get(params.data.id);
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  res.json(entry);
});

// Clear all history
historyRouter.delete("/", (_req, res) => {
  historyStore.clear();
  res.json({ ok: true });
});
