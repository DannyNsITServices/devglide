import path from "path";
import { Router } from "express";
import type { Request, Response, Router as RouterType } from "express";
import { ScenarioManager } from "../services/scenario-manager.js";
import { ScenarioStore } from "../services/scenario-store.js";

export const triggerRouter: RouterType = Router();
const scenarioManager = ScenarioManager.getInstance();

// ── SSE client management ──────────────────────────────────────────────────
// Map of target key -> Set of SSE response objects
const sseClients = new Map<string, Set<Response>>();

const HEARTBEAT_INTERVAL_MS = 30_000;

// Heartbeat timer — send a comment to all connected SSE clients every 30s
const heartbeatTimer = setInterval(() => {
  for (const clientSet of sseClients.values()) {
    for (const res of clientSet) {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // client already gone — will be cleaned up on close
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref(); // don't keep the process alive just for heartbeats

/**
 * Broadcast a scenario to all SSE clients listening on the given target.
 */
function broadcastScenario(target: string, scenario: unknown): void {
  const key = scenarioManager.resolveTargetKey(target);
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${JSON.stringify(scenario)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // ignore — will be cleaned up on close
    }
  }
}

/**
 * GET /api/trigger/status — Return pending scenario count.
 * Accepts optional ?projectPath= query param to filter by project.
 * Returns 0 if no project is specified.
 */
triggerRouter.get("/status", (req: Request, res: Response) => {
  const projectPath = (req.query.projectPath as string) || null;
  res.json({ pendingScenarios: scenarioManager.getPendingCountForProject(projectPath) });
});

/**
 * GET /api/trigger/commands — Return the command catalog.
 */
triggerRouter.get("/commands", (_req: Request, res: Response) => {
  res.json(scenarioManager.getCommandsCatalog());
});

interface ScenarioBody {
  name?: string;
  description?: string;
  steps?: Array<{
    command: string;
    selector?: string;
    text?: string;
    value?: string;
    timeout?: number;
    ms?: number;
    clear?: boolean;
    contains?: boolean;
    path?: string;
  }>;
  target?: string;
}

/**
 * POST /api/trigger/scenarios — Submit a scenario for browser execution.
 * If SSE clients are listening for this target, the scenario is broadcast
 * directly rather than being queued (SSE client will dequeue it).
 */
triggerRouter.post("/scenarios", (req: Request, res: Response) => {
  const body = req.body as ScenarioBody;

  if (!body.steps || body.steps.length === 0) {
    res.status(400).end();
    return;
  }

  const saved = scenarioManager.submitScenario(body);
  // Broadcast to any SSE clients listening for this target
  if (saved.target) {
    broadcastScenario(saved.target, saved);
  }
  res.status(201).json(saved);
});

/**
 * GET /api/trigger/scenarios/stream?target=... — SSE stream for scenario delivery.
 * Sends any pending scenario immediately on connect, then pushes new scenarios
 * as they are submitted. Heartbeat comment every 30 seconds.
 */
triggerRouter.get("/scenarios/stream", (req: Request, res: Response) => {
  const target = (req.query.target as string) || "";

  // Register the target so targetKey resolution works for app-name shortcuts
  scenarioManager.registerTarget(target);

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Deliver any already-queued scenario immediately
  const pending = scenarioManager.dequeueScenario(target);
  if (pending) {
    res.write(`data: ${JSON.stringify(pending)}\n\n`);
  }

  // Register this client for future broadcasts
  const key = scenarioManager.resolveTargetKey(target);
  if (!sseClients.has(key)) {
    sseClients.set(key, new Set());
  }
  sseClients.get(key)!.add(res);

  // Clean up on disconnect
  req.on("close", () => {
    const clientSet = sseClients.get(key);
    if (clientSet) {
      clientSet.delete(res);
      if (clientSet.size === 0) {
        sseClients.delete(key);
      }
    }
  });
});

/**
 * GET /api/trigger/scenarios/poll?target=... — Check for a queued scenario.
 * Returns 200 with scenario if one is available, 204 otherwise.
 * Kept for backwards compatibility — SSE stream is the preferred mechanism.
 */
triggerRouter.get("/scenarios/poll", (req: Request, res: Response) => {
  const target = (req.query.target as string) || "";

  const queued = scenarioManager.dequeueScenario(target);
  if (queued) {
    res.status(200).json(queued);
  } else {
    res.status(204).end();
  }
});

/**
 * GET /api/trigger/scenarios/results — List all recent results.
 * Must be registered before the :id param routes to avoid ambiguity.
 */
triggerRouter.get("/scenarios/results", (req: Request, res: Response) => {
  const projectPath = req.query.projectPath as string | undefined;
  res.json(scenarioManager.listResults(projectPath || null));
});

/**
 * POST /api/trigger/scenarios/:id/result — Receive result from browser after scenario completes.
 */
triggerRouter.post("/scenarios/:id/result", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { status, failedStep, error, duration } = req.body as {
    status?: string;
    failedStep?: number;
    error?: string;
    duration?: number;
  };

  if (status !== "passed" && status !== "failed") {
    res.status(400).end();
    return;
  }

  const result = scenarioManager.setResult(id, { status, failedStep, error, duration });
  res.status(201).json(result);
});

/**
 * GET /api/trigger/scenarios/:id/result — Retrieve result for a scenario.
 */
triggerRouter.get("/scenarios/:id/result", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const result = scenarioManager.getResult(id);
  if (!result) {
    res.status(404).end();
    return;
  }
  res.json(result);
});

const scenarioStore = ScenarioStore.getInstance();

/**
 * GET /api/trigger/scenarios/saved — List saved scenarios scoped to a target.
 * Requires ?target= (exact match) or ?projectPath= (matches exact path or basename).
 * Returns empty array if neither is provided.
 */
triggerRouter.get("/scenarios/saved", async (req: Request, res: Response) => {
  const target = req.query.target as string | undefined;
  const projectPath = req.query.projectPath as string | undefined;

  if (target) {
    res.json(await scenarioStore.list(target));
  } else if (projectPath) {
    const basename = path.basename(projectPath);
    const byPath = await scenarioStore.list(projectPath);
    const byName = basename !== projectPath ? await scenarioStore.list(basename) : [];
    // Dedupe in case both match the same scenarios
    const seen = new Set(byPath.map((s) => s.id));
    res.json([...byPath, ...byName.filter((s) => !seen.has(s.id))]);
  } else {
    res.json([]);
  }
});

/**
 * POST /api/trigger/scenarios/save — Save a new scenario.
 */
triggerRouter.post("/scenarios/save", async (req: Request, res: Response) => {
  const body = req.body as ScenarioBody;

  if (!body.name || !body.target || !body.steps || body.steps.length === 0) {
    res.status(400).end();
    return;
  }

  const saved = await scenarioStore.save({
    name: body.name,
    description: body.description,
    target: body.target,
    steps: body.steps,
    projectId: undefined, // standalone mode has no project context
  });
  res.status(201).json(saved);
});

/**
 * DELETE /api/trigger/scenarios/saved/:id — Delete a saved scenario by id.
 */
triggerRouter.delete("/scenarios/saved/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const deleted = await scenarioStore.delete(id);
  if (!deleted) {
    res.status(404).end();
    return;
  }
  res.status(204).end();
});

/**
 * POST /api/trigger/scenarios/saved/:id/run — Re-run a saved scenario.
 */
triggerRouter.post("/scenarios/saved/:id/run", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const scenario = await scenarioStore.get(id);
  if (!scenario) {
    res.status(404).end();
    return;
  }

  await scenarioStore.markRun(id);

  const queued = scenarioManager.submitScenario({
    name: scenario.name,
    steps: scenario.steps,
    target: scenario.target || '', // standalone mode — no project fallback
  });
  // Broadcast to any SSE clients listening for this target
  if (queued.target) {
    broadcastScenario(queued.target, queued);
  }
  res.status(201).json(queued);
});
