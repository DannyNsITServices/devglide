import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

// Workflow imports
import { WorkflowStore } from '../apps/workflow/services/workflow-store.js';
import { RunManager } from '../apps/workflow/services/run-manager.js';
import { getRegisteredTypes } from '../apps/workflow/engine/node-registry.js';
import { registerAllExecutors } from '../apps/workflow/engine/executors/index.js';
import { validateWorkflowGraph } from '../apps/workflow/services/workflow-validator.js';
import { getActiveProject } from '../project-context.js';
import type { WorkflowNode, WorkflowEdge, ExecutorServices } from '../apps/workflow/types.js';
import { ScenarioManager } from '../apps/test/src/services/scenario-manager.js';
import { ScenarioStore } from '../apps/test/src/services/scenario-store.js';

// ── Zod schemas for HTTP input validation ────────────────────────────────────

const createWorkflowSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  nodes: z.array(z.object({ id: z.string(), type: z.string(), label: z.string(), config: z.record(z.unknown()), position: z.object({ x: z.number(), y: z.number() }) }).passthrough()),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string() }).passthrough()),
  variables: z.array(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(['project', 'global']).optional(),
  enabled: z.boolean().optional(),
  global: z.boolean().optional(),
});

export { createWorkflowMcpServer } from '../apps/workflow/mcp.js';

export const router: Router = Router();

// ── State ───────────────────────────────────────────────────────────────────

const builderStore = WorkflowStore.getInstance();
const runManager = RunManager.getInstance();

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /workflows — returns saved graph workflows scoped to the active project
router.get('/workflows', async (req: Request, res: Response) => {
  try {
    const projectId = (req.query.projectId as string | undefined) ?? getActiveProject()?.id;
    const workflows = await builderStore.list(projectId).catch(() => []);
    res.json(workflows);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /workflows/:id — get full graph workflow by ID
router.get('/workflows/:id', async (req: Request, res: Response) => {
  try {
    const workflow = await builderStore.get(req.params.id);
    if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json(workflow);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /workflows — create new graph workflow
router.post('/workflows', async (req: Request, res: Response) => {
  try {
    const parsed = createWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }

    const { name, description, nodes, edges, variables, tags, scope, enabled, global: isGlobal } = parsed.data;

    const workflow = await builderStore.save({
      name,
      description,
      version: 1,
      nodes: nodes as WorkflowNode[],
      edges: edges as WorkflowEdge[],
      variables: (variables ?? []) as any,
      tags: tags ?? [],
      scope,
      enabled,
      global: isGlobal,
    });

    res.status(201).json(workflow);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

const updateWorkflowSchema = createWorkflowSchema.partial();

// PUT /workflows/:id — update graph workflow
router.put('/workflows/:id', async (req: Request, res: Response) => {
  try {
    const parsed = updateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }

    const existing = await builderStore.get(req.params.id);
    if (!existing) { res.status(404).json({ error: 'Workflow not found' }); return; }

    const { name, description, nodes, edges, variables, tags, scope, enabled } = parsed.data;
    const isGlobal: boolean | undefined = parsed.data.global;

    const workflow = await builderStore.save({
      id: req.params.id,
      name: name ?? existing.name,
      description: description ?? existing.description,
      version: (existing.version ?? 0) + 1,
      projectId: existing.projectId,
      nodes: nodes ?? existing.nodes,
      edges: edges ?? existing.edges,
      variables: variables ?? existing.variables,
      tags: tags ?? existing.tags,
      scope,
      enabled: enabled ?? existing.enabled,
      global: isGlobal ?? existing.global,
    });

    res.json(workflow);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /workflows/:id — delete graph workflow
router.delete('/workflows/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await builderStore.delete(req.params.id);
    if (deleted) { res.json({ ok: true }); return; }
    res.status(404).json({ error: 'Workflow not found' });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /match — match a user prompt against all enabled workflows
router.post('/match', async (req: Request, res: Response) => {
  try {
    const { prompt, projectId } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    const scopeId = (projectId as string | undefined) ?? getActiveProject()?.id;
    const result = await builderStore.match(prompt, scopeId);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /workflows/:id/toggle — toggle a workflow enabled/disabled
router.post('/workflows/:id/toggle', async (req: Request, res: Response) => {
  try {
    const workflow = await builderStore.get(req.params.id);
    if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }

    const newEnabled = workflow.enabled === false ? true : false;
    const updated = await builderStore.save({
      ...workflow,
      enabled: newEnabled,
    });

    res.json(updated);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /instructions — get compiled workflow instructions as markdown
router.get('/instructions', async (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const markdown = await builderStore.getCompiledInstructions(projectId);
    res.setHeader('Content-Type', 'text/markdown');
    res.send(markdown);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /workflows/:id/run — run a workflow
router.post('/workflows/:id/run', async (req: Request, res: Response) => {
  try {
    const workflow = await builderStore.get(req.params.id);
    if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
    const { triggerPayload } = req.body ?? {};
    const runId = runManager.startRun(workflow, triggerPayload);
    res.json({ runId });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /runs — list all runs
router.get('/runs', (_req: Request, res: Response) => {
  const runs = runManager.listRuns().map((r) => ({
    id: r.id,
    workflowId: r.workflowId,
    workflowName: r.workflowName,
    startedAt: r.startedAt,
    status: r.status,
  }));
  res.json(runs);
});

// GET /runs/:id/stream — SSE stream for a run
router.get('/runs/:id/stream', (req: Request, res: Response) => {
  const run = runManager.getRun(req.params.id);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'snapshot', run: { id: run.id, workflowId: run.workflowId, workflowName: run.workflowName, startedAt: run.startedAt, status: run.status, events: run.events } })}\n\n`);

  if (run.status !== 'running') { res.end(); return; }

  runManager.addClient(req.params.id, res);
  req.on('close', () => { runManager.removeClient(req.params.id, res); });
});

// POST /runs/:id/cancel — cancel a run
router.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const cancelled = runManager.cancelRun(req.params.id);
  if (!cancelled) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json({ ok: true });
});

// GET /node-types — registered node type names
router.get('/node-types', (_req: Request, res: Response) => {
  res.json(getRegisteredTypes());
});

// POST /validate — validate a workflow graph
router.post('/validate', (req: Request, res: Response) => {
  const { nodes, edges } = req.body as { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] };

  if (!nodes || !Array.isArray(nodes)) {
    res.status(400).json({ valid: false, errors: ['nodes must be an array'] });
    return;
  }
  if (!edges || !Array.isArray(edges)) {
    res.status(400).json({ valid: false, errors: ['edges must be an array'] });
    return;
  }

  res.json(validateWorkflowGraph(nodes, edges));
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function initWorkflow(): void {
  registerAllExecutors();

  // Wire concrete service implementations for executor dependency injection.
  // This centralizes cross-app wiring in one place instead of having executors
  // directly import singletons from other apps.
  const services: ExecutorServices = {
    test: {
      submitScenario: (data) => ScenarioManager.getInstance().submitScenario(data),
      getSavedScenario: (id) => ScenarioStore.getInstance().get(id),
      markRun: (id) => ScenarioStore.getInstance().markRun(id),
      saveScenario: (data) => ScenarioStore.getInstance().save(data),
      listSaved: () => ScenarioStore.getInstance().list(),
    },
    workflow: {
      getWorkflow: (id) => builderStore.get(id),
    },
  };
  runManager.setServices(services);
  runManager.startCleanup();
}

export function shutdownWorkflow(): void {
  runManager.shutdown();
}
