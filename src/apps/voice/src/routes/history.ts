import { Router, type Router as RouterType } from "express";
import { historyStore } from "../services/history-store.js";

export const historyRouter: RouterType = Router();

// List history (newest first)
historyRouter.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const result = historyStore.list(limit, offset);
  res.json(result);
});

// Search history
historyRouter.get("/search", (req, res) => {
  const query = (req.query.q as string) ?? "";
  if (!query.trim()) {
    res.status(400).json({ error: "Query parameter 'q' is required" });
    return;
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
  const entries = historyStore.search(query, limit);
  res.json({ entries, total: entries.length });
});

// Analytics
historyRouter.get("/analytics", (_req, res) => {
  res.json(historyStore.getAnalytics());
});

// Get single entry
historyRouter.get("/:id", (req, res) => {
  const entry = historyStore.get(req.params.id);
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
