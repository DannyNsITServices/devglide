import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound, unprocessableEntity } from '../packages/error-middleware.js';

// Workflow imports
import { WorkflowStore } from '../apps/workflow/services/workflow-store.js';
import { RunManager } from '../apps/workflow/services/run-manager.js';
import { getRegisteredTypes } from '../apps/workflow/engine/node-registry.js';
import { registerAllExecutors } from '../apps/workflow/engine/executors/index.js';
import { validateWorkflowGraph } from '../apps/workflow/services/workflow-validator.js';
import { getActiveProject } from '../project-context.js';
import type { WorkflowNode, WorkflowEdge, ExecutorServices, VariableDefinition } from '../apps/workflow/types.js';
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

const workflowIdParamSchema = z.object({
  id: z.string().min(1, 'workflow id is required'),
});

const runIdParamSchema = z.object({
  id: z.string().min(1, 'run id is required'),
});

const workflowListQuerySchema = z.object({
  projectId: z.string().optional(),
});

const instructionsQuerySchema = z.object({
  projectId: z.string().optional(),
});

export { createWorkflowMcpServer } from '../apps/workflow/src/mcp.js';

export const router: Router = Router();

// ── State ───────────────────────────────────────────────────────────────────

const builderStore = WorkflowStore.getInstance();
const runManager = RunManager.getInstance();

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /workflows — returns saved graph workflows scoped to the active project
router.get('/workflows', asyncHandler(async (req: Request, res: Response) => {
  const query = workflowListQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const projectId = query.data.projectId ?? getActiveProject()?.id;
  const workflows = await builderStore.list(projectId).catch(() => []);
  res.json(workflows);
}));

// GET /workflows/:id — get full graph workflow by ID
router.get('/workflows/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = workflowIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const workflow = await builderStore.get(params.data.id);
  if (!workflow) { notFound(res, 'Workflow not found'); return; }
  res.json(workflow);
}));

// POST /workflows — create new graph workflow
router.post('/workflows', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createWorkflowSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }

  const { name, description, nodes, edges, variables, tags, scope, enabled, global: isGlobal } = parsed.data;

  const graphValidation = validateWorkflowGraph(nodes as WorkflowNode[], edges as WorkflowEdge[]);
  if (!graphValidation.valid) {
    unprocessableEntity(res, 'Invalid workflow graph', { validationErrors: graphValidation.errors });
    return;
  }

  const workflow = await builderStore.save({
    name,
    description,
    version: 1,
    nodes: nodes as WorkflowNode[],
    edges: edges as WorkflowEdge[],
    variables: (variables ?? []) as VariableDefinition[],
    tags: tags ?? [],
    scope,
    enabled,
    global: isGlobal,
  });

  res.status(201).json(workflow);
}));

const updateWorkflowSchema = createWorkflowSchema.partial();

// PUT /workflows/:id — update graph workflow
router.put('/workflows/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = workflowIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const parsed = updateWorkflowSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }

  const existing = await builderStore.get(params.data.id);
  if (!existing) { notFound(res, 'Workflow not found'); return; }

  const { name, description, nodes, edges, variables, tags, scope, enabled } = parsed.data;
  const isGlobal: boolean | undefined = parsed.data.global;

  const finalNodes = (nodes ?? existing.nodes) as WorkflowNode[];
  const finalEdges = (edges ?? existing.edges) as WorkflowEdge[];
  const graphValidation = validateWorkflowGraph(finalNodes, finalEdges);
  if (!graphValidation.valid) {
    unprocessableEntity(res, 'Invalid workflow graph', { validationErrors: graphValidation.errors });
    return;
  }

  const workflow = await builderStore.save({
    id: params.data.id,
    name: name ?? existing.name,
    description: description ?? existing.description,
    version: (existing.version ?? 0) + 1,
    projectId: existing.projectId,
    nodes: finalNodes,
    edges: finalEdges,
    variables: variables ?? existing.variables,
    tags: tags ?? existing.tags,
    scope,
    enabled: enabled ?? existing.enabled,
    global: isGlobal ?? existing.global,
  });

  res.json(workflow);
}));

// DELETE /workflows/:id — delete graph workflow
router.delete('/workflows/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = workflowIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const deleted = await builderStore.delete(params.data.id);
  if (deleted) { res.json({ ok: true }); return; }
  notFound(res, 'Workflow not found');
}));

const matchSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  projectId: z.string().optional(),
});

// POST /match — match a user prompt against all enabled workflows
router.post('/match', asyncHandler(async (req: Request, res: Response) => {
  const parsed = matchSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { prompt, projectId } = parsed.data;
  const scopeId = projectId ?? getActiveProject()?.id;
  const result = await builderStore.match(prompt, scopeId);
  res.json(result);
}));

// POST /workflows/:id/toggle — toggle a workflow enabled/disabled
router.post('/workflows/:id/toggle', asyncHandler(async (req: Request, res: Response) => {
  const params = workflowIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const workflow = await builderStore.get(params.data.id);
  if (!workflow) { notFound(res, 'Workflow not found'); return; }

  const newEnabled = workflow.enabled === false ? true : false;
  const updated = await builderStore.save({
    ...workflow,
    enabled: newEnabled,
  });

  res.json(updated);
}));

// GET /instructions — get compiled workflow instructions as markdown
router.get('/instructions', asyncHandler(async (req: Request, res: Response) => {
  const query = instructionsQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const projectId = query.data.projectId;
  const markdown = await builderStore.getCompiledInstructions(projectId);
  res.setHeader('Content-Type', 'text/markdown');
  res.send(markdown);
}));

const runSchema = z.object({
  triggerPayload: z.unknown().optional(),
});

// POST /workflows/:id/run — run a workflow
router.post('/workflows/:id/run', asyncHandler(async (req: Request, res: Response) => {
  const params = workflowIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const workflow = await builderStore.get(params.data.id);
  if (!workflow) { notFound(res, 'Workflow not found'); return; }
  const parsed = runSchema.safeParse(req.body);
  const { triggerPayload } = parsed.success ? parsed.data : {};
  const runId = runManager.startRun(workflow, triggerPayload);
  res.json({ runId });
}));

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
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const run = runManager.getRun(params.data.id);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'snapshot', run: { id: run.id, workflowId: run.workflowId, workflowName: run.workflowName, startedAt: run.startedAt, status: run.status, events: run.events } })}\n\n`);

  if (run.status !== 'running') { res.end(); return; }

  runManager.addClient(params.data.id, res);
  req.on('close', () => { runManager.removeClient(params.data.id, res); });
});

// POST /runs/:id/cancel — cancel a run
router.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const cancelled = runManager.cancelRun(params.data.id);
  if (!cancelled) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json({ ok: true });
});

// GET /node-types — registered node type names
router.get('/node-types', (_req: Request, res: Response) => {
  res.json(getRegisteredTypes());
});

const validateSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string() }).passthrough()),
});

// POST /validate — validate a workflow graph
router.post('/validate', (req: Request, res: Response) => {
  const parsed = validateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ valid: false, errors: parsed.error.issues.map(i => i.message) });
    return;
  }

  res.json(validateWorkflowGraph(parsed.data.nodes as WorkflowNode[], parsed.data.edges as WorkflowEdge[]));
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
