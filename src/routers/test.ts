import path from 'path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ScenarioManager } from '../apps/test/src/services/scenario-manager.js';
import { ScenarioStore } from '../apps/test/src/services/scenario-store.js';
import { ScenarioBroadcaster } from '../apps/test/src/services/scenario-broadcaster.js';
import { getActiveProject } from '../project-context.js';

// ── Zod schemas for HTTP input validation ────────────────────────────────────

const scenarioStepSchema = z.object({
  command: z.string(),
  selector: z.string().optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  timeout: z.number().optional(),
  ms: z.number().optional(),
  clear: z.boolean().optional(),
  contains: z.boolean().optional(),
  path: z.string().optional(),
});

const submitScenarioSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(scenarioStepSchema).min(1, 'At least one step is required'),
  target: z.string().optional(),
});

const saveScenarioSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  steps: z.array(scenarioStepSchema).min(1, 'At least one step is required'),
  target: z.string().optional(),
});

const scenarioResultSchema = z.object({
  status: z.enum(['passed', 'failed']),
  failedStep: z.number().optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
});

export { createTestMcpServer } from '../apps/test/src/mcp.js';

export const router: Router = Router();

const scenarioManager = ScenarioManager.getInstance();
const scenarioStore = ScenarioStore.getInstance();
const broadcaster = ScenarioBroadcaster.getInstance();

// ── Trigger routes (mounted under /trigger) ──────────────────────────────────

const triggerRouter = Router();

/**
 * GET /api/test/trigger/status — Return pending scenario count.
 */
triggerRouter.get('/status', (req: Request, res: Response) => {
  const projectPath = (req.query.projectPath as string) || getActiveProject()?.path || null;
  res.json({ pendingScenarios: scenarioManager.getPendingCountForProject(projectPath) });
});

/**
 * GET /api/test/trigger/commands — Return the command catalog.
 */
triggerRouter.get('/commands', (_req: Request, res: Response) => {
  res.json(scenarioManager.getCommandsCatalog());
});

/**
 * POST /api/test/trigger/scenarios — Submit a scenario for browser execution.
 */
triggerRouter.post('/scenarios', (req: Request, res: Response) => {
  const parsed = submitScenarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const data = parsed.data;
  if (!data.target) data.target = getActiveProject()?.path;
  const saved = scenarioManager.submitScenario(data);
  if (saved.target) {
    broadcaster.broadcast(scenarioManager.resolveTargetKey(saved.target), saved);
  }
  res.status(201).json(saved);
});

/**
 * GET /api/test/trigger/scenarios/results — List all recent results.
 * Static paths must be registered before :id param routes to avoid ambiguity.
 */
triggerRouter.get('/scenarios/results', (req: Request, res: Response) => {
  const projectPath = (req.query.projectPath as string) || getActiveProject()?.path || null;
  res.json(scenarioManager.listResults(projectPath));
});

/**
 * GET /api/test/trigger/scenarios/stream?target=... — SSE stream for scenario delivery.
 */
triggerRouter.get('/scenarios/stream', (req: Request, res: Response) => {
  const target = (req.query.target as string) || getActiveProject()?.path || '';

  scenarioManager.registerTarget(target);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const pending = scenarioManager.dequeueScenario(target);
  if (pending) {
    res.write(`data: ${JSON.stringify(pending)}\n\n`);
  }

  const key = scenarioManager.resolveTargetKey(target);
  const removeClient = broadcaster.addClient(key, res);
  req.on('close', removeClient);
});

/**
 * GET /api/test/trigger/scenarios/poll?target=... — Check for a queued scenario.
 */
triggerRouter.get('/scenarios/poll', (req: Request, res: Response) => {
  const target = (req.query.target as string) || getActiveProject()?.path || '';

  const queued = scenarioManager.dequeueScenario(target);
  if (queued) {
    res.status(200).json(queued);
  } else {
    res.status(204).end();
  }
});

/**
 * POST /api/test/trigger/scenarios/:id/result — Receive result from browser.
 */
triggerRouter.post('/scenarios/:id/result', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const parsed = scenarioResultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const result = scenarioManager.setResult(id, parsed.data);
  res.status(201).json(result);
});

/**
 * GET /api/test/trigger/scenarios/:id/result — Retrieve result for a scenario.
 */
triggerRouter.get('/scenarios/:id/result', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const result = scenarioManager.getResult(id);
  if (!result) {
    res.status(404).end();
    return;
  }
  res.json(result);
});

/**
 * GET /api/test/trigger/scenarios/saved — List saved scenarios scoped to a target.
 * Accepts ?target= (exact match) or ?projectPath= (matches exact path or basename).
 * Returns empty array if neither is provided.
 */
triggerRouter.get('/scenarios/saved', async (req: Request, res: Response) => {
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
    const activeProjectPath = getActiveProject()?.path;
    if (activeProjectPath) {
      const basename = path.basename(activeProjectPath);
      const byPath = await scenarioStore.list(activeProjectPath);
      const byName = basename !== activeProjectPath ? await scenarioStore.list(basename) : [];
      const seen = new Set(byPath.map((s) => s.id));
      res.json([...byPath, ...byName.filter((s) => !seen.has(s.id))]);
    } else {
      res.json([]);
    }
  }
});

/**
 * POST /api/test/trigger/scenarios/save — Save a new scenario.
 */
triggerRouter.post('/scenarios/save', async (req: Request, res: Response) => {
  const parsed = saveScenarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const saved = await scenarioStore.save({
    name: parsed.data.name,
    description: parsed.data.description,
    target: parsed.data.target || getActiveProject()?.name || '',
    steps: parsed.data.steps,
    projectId: getActiveProject()?.id,
  });
  res.status(201).json(saved);
});

/**
 * DELETE /api/test/trigger/scenarios/saved/:id — Delete a saved scenario by id.
 */
triggerRouter.delete('/scenarios/saved/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const deleted = await scenarioStore.delete(id);
  if (!deleted) {
    res.status(404).end();
    return;
  }
  res.status(204).end();
});

/**
 * POST /api/test/trigger/scenarios/saved/:id/run — Re-run a saved scenario.
 */
triggerRouter.post('/scenarios/saved/:id/run', async (req: Request, res: Response) => {
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
    target: scenario.target || getActiveProject()?.path || '',
  });
  if (queued.target) {
    broadcaster.broadcast(scenarioManager.resolveTargetKey(queued.target), queued);
  }
  res.status(201).json(queued);
});

router.use('/trigger', triggerRouter);

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function initTest(): Promise<void> {
  scenarioManager.startCleanup();
  await scenarioStore.init();
}

export function shutdownTest(): void {
  scenarioManager.stopCleanup();
  broadcaster.shutdown();
}
