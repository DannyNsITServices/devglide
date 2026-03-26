import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Namespace } from 'socket.io';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../packages/error-middleware.js';
import * as registry from '../apps/chat/services/chat-registry.js';
import * as store from '../apps/chat/services/chat-store.js';
import { getEffectiveRules, getDefaultRules, saveProjectRules, deleteProjectRules, hasProjectRules } from '../apps/chat/services/chat-rules.js';
import { getActiveProject, onProjectChange } from '../project-context.js';
import { listProjects } from '../packages/project-store.js';
import { globalPtys, dashboardState, nextPaneId, nextNumForProject, getShellNsp, MAX_PANES, panesForProject } from '../apps/shell/src/runtime/shell-state.js';
import { spawnGlobalPty } from '../apps/shell/src/runtime/pty-manager.js';
import { SHELL_CONFIGS } from '../apps/shell/src/runtime/shell-config.js';
import type { PaneInfo } from '../apps/shell/src/shell-types.js';
import {
  createChatMcpServer,
  chatServerSessions,
  bindChatSessionToMcpHttpSession,
  registerChatMcpHttpSession,
  unregisterChatMcpHttpSession,
} from '../apps/chat/src/mcp.js';

export {
  createChatMcpServer,
  chatServerSessions,
  bindChatSessionToMcpHttpSession,
  registerChatMcpHttpSession,
  unregisterChatMcpHttpSession,
};

export const router: Router = Router();

// ── Zod schemas ──────────────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  message: z.string().min(1, 'message is required'),
  to: z.string().optional(),
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
});

// ── Zod schemas (join/leave/send) ────────────────────────────────────────────

const joinSchema = z.object({
  name: z.string().min(1),
  paneId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  submitKey: z.enum(['cr', 'lf']).optional(),
});

const leaveSchema = z.object({
  name: z.string().min(1),
  projectId: z.string().nullable().optional(),
});

const sendSchema = z.object({
  from: z.string().min(1),
  message: z.string().min(1),
  to: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

const PIPE_REF_RE = /#pipe-([a-z0-9-]+)/ig;

function findRunningPipeReference(message: string, projectId?: string | null): string | null {
  PIPE_REF_RE.lastIndex = 0;
  const seen = new Set<string>();
  for (const match of message.matchAll(PIPE_REF_RE)) {
    const pipeId = match[1];
    const normalized = pipeId.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const storeStatus = registry.getPipeStoreStatus(pipeId, projectId);
    if (storeStatus?.status === 'running') return pipeId;

    const pipeRun = registry.getPipeRun(pipeId, projectId);
    if (pipeRun?.status === 'running') return pipeId;
  }
  return null;
}

function getBlockedPipeReferenceError(message: string, projectId?: string | null): string | null {
  if (/^#pipe-/i.test(message.trimStart())) {
    return 'Pipe submissions must use the dedicated pipe endpoint, not chat send. '
      + 'Use POST /api/chat/pipes/:id/submit or the pipe_submit MCP tool.';
  }

  const runningPipeId = findRunningPipeReference(message, projectId);
  if (!runningPipeId) return null;

  return `Chat messages may not reference currently running pipes via #pipe-${runningPipeId}. `
    + 'Use pipe_submit for stage output, or discuss the pipe without the #pipe- anchor.';
}

// ── Pane resolution & diagnostics ────────────────────────────────────────────

interface RoutablePane {
  id: string;
  num: number;
  title: string;
  projectId: string | null;
  cwd: string;
  chatName?: string;
  claimed: boolean;     // true if a chat participant is linked to this pane
  claimedBy?: string;   // participant name if claimed
}

/** Get all routable panes globally (not filtered by project). Used for claim checks. */
function getRoutablePanesGlobal(): RoutablePane[] {
  // Collect claimed panes from ALL participants across all projects
  const claimedPanes = new Map<string, string>();
  for (const pane of dashboardState.panes) {
    const pid = pane.projectId ?? null;
    const participants = registry.listParticipants(pid);
    for (const p of participants) {
      if (p.paneId && !p.detached) claimedPanes.set(p.paneId, p.name);
    }
  }

  const result: RoutablePane[] = [];
  for (const pane of dashboardState.panes) {
    if (!globalPtys.has(pane.id)) continue;
    result.push({
      id: pane.id,
      num: pane.num,
      title: pane.title ?? `pane-${pane.num}`,
      projectId: pane.projectId ?? null,
      cwd: pane.cwd ?? '',
      chatName: pane.chatName,
      claimed: claimedPanes.has(pane.id),
      claimedBy: claimedPanes.get(pane.id),
    });
  }
  return result;
}

function getRoutablePanes(projectId?: string | null): RoutablePane[] {
  const pid = projectId ?? getActiveProject()?.id ?? null;
  const participants = registry.listParticipants(pid);
  const claimedPanes = new Map<string, string>();
  for (const p of participants) {
    if (p.paneId && !p.detached) claimedPanes.set(p.paneId, p.name);
  }

  const result: RoutablePane[] = [];
  for (const pane of dashboardState.panes) {
    if (!globalPtys.has(pane.id)) continue;
    if (pid && pane.projectId && pane.projectId !== pid) continue;
    result.push({
      id: pane.id,
      num: pane.num,
      title: pane.title ?? `pane-${pane.num}`,
      projectId: pane.projectId ?? null,
      cwd: pane.cwd ?? '',
      chatName: pane.chatName,
      claimed: claimedPanes.has(pane.id),
      claimedBy: claimedPanes.get(pane.id),
    });
  }
  return result;
}

interface PaneResolutionResult {
  resolved: boolean;
  paneId?: string;
  diagnostics: {
    suppliedPaneId: string | null;
    paneExistsInDashboard: boolean;
    paneExistsInGlobalPtys: boolean;
    paneProjectId: string | null;
    availableRoutablePanes: RoutablePane[];
    suggestedPaneId: string | null;
    suggestedAction: string;
  };
}

function resolvePane(suppliedPaneId: string | null | undefined, projectId: string | null): PaneResolutionResult {
  const routablePanes = getRoutablePanes(projectId);
  const unclaimedPanes = routablePanes.filter(p => !p.claimed);

  // Auto-resolution: find the best pane automatically
  if (suppliedPaneId === 'auto' || !suppliedPaneId) {
    if (unclaimedPanes.length === 1) {
      return {
        resolved: true,
        paneId: unclaimedPanes[0].id,
        diagnostics: {
          suppliedPaneId: suppliedPaneId ?? null,
          paneExistsInDashboard: true,
          paneExistsInGlobalPtys: true,
          paneProjectId: projectId,
          availableRoutablePanes: routablePanes,
          suggestedPaneId: unclaimedPanes[0].id,
          suggestedAction: `Auto-resolved to ${unclaimedPanes[0].id}`,
        },
      };
    }

    if (unclaimedPanes.length === 0) {
      return {
        resolved: false,
        diagnostics: {
          suppliedPaneId: suppliedPaneId ?? null,
          paneExistsInDashboard: false,
          paneExistsInGlobalPtys: false,
          paneProjectId: projectId,
          availableRoutablePanes: routablePanes,
          suggestedPaneId: null,
          suggestedAction: routablePanes.length > 0
            ? `All routable panes are claimed. Available panes: ${routablePanes.map(p => `${p.id} (claimed by ${p.claimedBy})`).join(', ')}`
            : 'No routable panes found. Create a shell pane first.',
        },
      };
    }

    // Multiple unclaimed panes — don't guess
    return {
      resolved: false,
      diagnostics: {
        suppliedPaneId: suppliedPaneId ?? null,
        paneExistsInDashboard: false,
        paneExistsInGlobalPtys: false,
        paneProjectId: projectId,
        availableRoutablePanes: routablePanes,
        suggestedPaneId: null,
        suggestedAction: `Multiple unclaimed panes available: ${unclaimedPanes.map(p => p.id).join(', ')}. Pass an explicit paneId.`,
      },
    };
  }

  // Explicit paneId — validate existence, project match, and claim status
  // Never silently fallback to another pane.
  const existsInDashboard = dashboardState.panes.some(p => p.id === suppliedPaneId);
  const existsInPtys = globalPtys.has(suppliedPaneId);
  const paneInfo = dashboardState.panes.find(p => p.id === suppliedPaneId);
  const paneProjectId = paneInfo?.projectId ?? null;

  if (existsInPtys) {
    // NOTE: We do NOT reject panes from different projects when explicitly supplied.
    // The pane carries its own project context — the caller joins that pane's project,
    // not the dashboard's active project. This is intentional: an LLM running in pane-1
    // (project-A) should be able to join chat even if the dashboard shows project-B.

    // Check claim status globally — look across ALL projects for an active participant on this pane.
    // This catches cross-project claims that the project-filtered routablePanes list would miss.
    const allPanes = getRoutablePanesGlobal();
    const claimedBy = allPanes.find(p => p.id === suppliedPaneId && p.claimed);
    if (claimedBy?.claimedBy) {
      // Allow reclaim by a detached participant (rejoin scenario)
      const claimerProject = claimedBy.projectId;
      const claimerParticipants = registry.listParticipants(claimerProject);
      const claimer = claimerParticipants.find(p => p.name === claimedBy.claimedBy);
      const isReclaim = claimer?.detached;
      if (!isReclaim) {
        return {
          resolved: false,
          diagnostics: {
            suppliedPaneId,
            paneExistsInDashboard: existsInDashboard,
            paneExistsInGlobalPtys: true,
            paneProjectId,
            availableRoutablePanes: routablePanes,
            suggestedPaneId: unclaimedPanes.length === 1 ? unclaimedPanes[0].id : null,
            suggestedAction: `Pane "${suppliedPaneId}" is already claimed by "${claimedBy.claimedBy}". ${unclaimedPanes.length > 0 ? `Available unclaimed panes: ${unclaimedPanes.map(p => p.id).join(', ')}` : 'No unclaimed panes available.'}`,
          },
        };
      }
    }

    return {
      resolved: true,
      paneId: suppliedPaneId,
      diagnostics: {
        suppliedPaneId,
        paneExistsInDashboard: existsInDashboard,
        paneExistsInGlobalPtys: true,
        paneProjectId,
        availableRoutablePanes: routablePanes,
        suggestedPaneId: suppliedPaneId,
        suggestedAction: 'Pane is valid and routable.',
      },
    };
  }

  // Explicit pane failed — provide diagnostics
  const suggested = unclaimedPanes.length === 1 ? unclaimedPanes[0].id : null;
  return {
    resolved: false,
    diagnostics: {
      suppliedPaneId,
      paneExistsInDashboard: existsInDashboard,
      paneExistsInGlobalPtys: false,
      paneProjectId: paneInfo?.projectId ?? null,
      availableRoutablePanes: routablePanes,
      suggestedPaneId: suggested,
      suggestedAction: existsInDashboard
        ? `Pane "${suppliedPaneId}" exists in dashboard but is not routable (PTY not active). ${suggested ? `Try: ${suggested}` : `Available panes: ${routablePanes.map(p => p.id).join(', ') || 'none'}`}`
        : `Pane "${suppliedPaneId}" does not exist. ${suggested ? `Try: ${suggested}` : `Available panes: ${routablePanes.map(p => p.id).join(', ') || 'none'}. Run "echo $DEVGLIDE_PANE_ID" in your shell to check.`}`,
    },
  };
}

// ── REST API ─────────────────────────────────────────────────────────────────

// GET /panes — list routable panes for chat join
// Accepts optional ?projectId= to scope to a specific project (defaults to active project)
router.get('/panes', (req: Request, res: Response) => {
  const projectId = req.query.projectId as string | undefined;
  res.json(getRoutablePanes(projectId ?? undefined));
});

// GET /status — connection diagnostics for a participant
// Accepts optional ?projectId= to scope to a specific project (defaults to active project)
// Accepts optional ?name= to get diagnostics for a specific participant
router.get('/status', (req: Request, res: Response) => {
  const name = req.query.name as string | undefined;
  const paneId = req.query.paneId as string | undefined;
  const projectId = (req.query.projectId as string | undefined) ?? getActiveProject()?.id ?? null;

  if (!name) {
    if (paneId) {
      const participant = registry.getParticipantByPaneId(paneId, projectId);
      if (!participant) {
        res.status(404).json({ error: `Participant for pane "${paneId}" not found`, joined: false });
        return;
      }

      const paneRoutable = participant.paneId ? globalPtys.has(participant.paneId) : false;
      const panes = getRoutablePanes(projectId);
      const unclaimed = panes.filter(p => !p.claimed);

      res.json({
        joined: true,
        name: participant.name,
        projectId: participant.projectId,
        paneId: participant.paneId,
        paneRoutable,
        detached: participant.detached,
        status: participant.status,
        autoResolveWouldPick: unclaimed.length === 1 ? unclaimed[0].id : unclaimed.length === 0 ? null : `ambiguous: ${unclaimed.map(p => p.id).join(', ')}`,
        activeMembers: registry.listParticipants(projectId).map(m => ({ name: m.name, status: m.status, paneId: m.paneId, detached: m.detached })),
      });
      return;
    }

    // Return general status: all members + pane info
    const members = registry.listParticipants(projectId);
    const panes = getRoutablePanes(projectId);
    const unclaimed = panes.filter(p => !p.claimed);
    res.json({
      projectId,
      activeMembers: members.map(m => ({ name: m.name, status: m.status, paneId: m.paneId, detached: m.detached })),
      routablePanes: panes,
      autoResolveWouldPick: unclaimed.length === 1 ? unclaimed[0].id : unclaimed.length === 0 ? null : `ambiguous: ${unclaimed.map(p => p.id).join(', ')}`,
    });
    return;
  }

  // Specific participant status
  const participant = registry.getParticipant(name, projectId);
  if (!participant) {
    res.status(404).json({ error: `Participant "${name}" not found`, joined: false });
    return;
  }

  const paneRoutable = participant.paneId ? globalPtys.has(participant.paneId) : false;
  const panes = getRoutablePanes(projectId);
  const unclaimed = panes.filter(p => !p.claimed);

  res.json({
    joined: true,
    name: participant.name,
    projectId: participant.projectId,
    paneId: participant.paneId,
    paneRoutable,
    detached: participant.detached,
    status: participant.status,
    autoResolveWouldPick: unclaimed.length === 1 ? unclaimed[0].id : unclaimed.length === 0 ? null : `ambiguous: ${unclaimed.map(p => p.id).join(', ')}`,
    activeMembers: registry.listParticipants(projectId).map(m => ({ name: m.name, status: m.status, paneId: m.paneId, detached: m.detached })),
  });
});

// GET /messages — read message history
router.get('/messages', (req: Request, res: Response) => {
  const query = messagesQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const messages = store.readMessages(query.data);
  res.json(messages);
});

// POST /messages — send as "user" (dashboard shorthand)
router.post('/messages', asyncHandler(async (req: Request, res: Response) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const error = getBlockedPipeReferenceError(parsed.data.message);
  if (error) {
    res.status(422).json({ error });
    return;
  }
  const msg = await registry.send('user', parsed.data.message, parsed.data.to);
  res.status(201).json(msg);
}));

// GET /members — list active participants
router.get('/members', (_req: Request, res: Response) => {
  res.json(registry.listParticipants());
});

// POST /join — register a participant (used by MCP bridge)
// Requires explicit paneId for LLM participants. Rejects "auto" for LLMs.
// On pane collision: disconnects the existing claimer, broadcasts error, returns 409.
router.post('/join', (req: Request, res: Response) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { name, paneId, model, submitKey } = parsed.data;
  if (name === 'user' || name === 'system') {
    badRequest(res, `"${name}" is reserved`);
    return;
  }

  // Reject "auto" for LLM participants — they must pass explicit paneId
  if (paneId === 'auto' && model) {
    res.status(400).json({
      error: 'chat_join requires an explicit paneId for LLM participants. Run "echo $DEVGLIDE_PANE_ID" in your shell and pass the result as paneId.',
    });
    return;
  }

  const projectId = getActiveProject()?.id ?? null;
  const resolution = resolvePane(paneId, projectId);

  // Handle pane collision — if the pane is claimed by another LLM, preserve
  // the existing session and reject the newcomer with 409.
  if (!resolution.resolved && resolution.diagnostics.suppliedPaneId) {
    const claimedPane = getRoutablePanesGlobal().find(
      p => p.id === resolution.diagnostics.suppliedPaneId && p.claimed,
    );
    if (claimedPane?.claimedBy) {
      const existingName = claimedPane.claimedBy;
      const collisionPaneId = claimedPane.id;
      const collisionProjectId = claimedPane.projectId ?? projectId;

      res.status(409).json({
        error: `Pane ${collisionPaneId} is already bound to "${existingName}". The existing session has been preserved.`,
        code: 'PANE_ALREADY_BOUND',
        collision: {
          paneId: collisionPaneId,
          currentParticipant: existingName,
        },
        recoverable: true,
        diagnostics: resolution.diagnostics,
      });
      return;
    }
  }

  if (!resolution.resolved || !resolution.paneId) {
    res.status(400).json({
      error: resolution.diagnostics.suggestedAction,
      diagnostics: resolution.diagnostics,
    });
    return;
  }

  const resolvedPaneId = resolution.paneId;
  const paneInfo = dashboardState.panes.find(p => p.id === resolvedPaneId);
  const paneProjectId = paneInfo?.projectId ?? projectId;
  const resolvedSubmitKey = submitKey === 'lf' ? '\n' : '\r';
  const participant = registry.join(name, 'llm', resolvedPaneId, model ?? null, resolvedSubmitKey, paneProjectId);
  const mcpSessionId = req.headers['mcp-session-id'];
  if (typeof mcpSessionId === 'string' && mcpSessionId) {
    bindChatSessionToMcpHttpSession(mcpSessionId, { name: participant.name, projectId: participant.projectId ?? null });
  }
  const rules = getEffectiveRules(participant.projectId);
  res.status(201).json({ ...participant, rules });
});

// POST /leave — unregister a participant (used by MCP bridge)
router.post('/leave', (req: Request, res: Response) => {
  const parsed = leaveSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { name, projectId } = parsed.data;
  const removed = registry.leave(name, projectId ?? undefined);
  if (!removed) {
    res.status(404).json({ error: 'Not found in participant list' });
    return;
  }
  const mcpSessionId = req.headers['mcp-session-id'];
  if (typeof mcpSessionId === 'string' && mcpSessionId) {
    bindChatSessionToMcpHttpSession(mcpSessionId, null);
  }
  res.json({ ok: true, left: name });
});

// POST /send — send a message as any participant (used by MCP bridge)
router.post('/send', asyncHandler(async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { from, message, to, projectId } = parsed.data;
  const error = getBlockedPipeReferenceError(message, projectId ?? undefined);
  if (error) {
    res.status(422).json({ error });
    return;
  }
  const msg = await registry.send(from, message, to, projectId ?? undefined);
  res.status(201).json(msg);
}));

// ── Rules of Engagement CRUD ──────────────────────────────────────────────────

const rulesSchema = z.object({
  rules: z.string().min(1, 'rules text is required'),
});

// GET /rules — get effective rules for active project
router.get('/rules', (_req: Request, res: Response) => {
  const project = getActiveProject();
  const rules = getEffectiveRules(project?.id);
  const isDefault = !project || !hasProjectRules(project.id);
  res.json({ rules, isDefault, defaultRules: getDefaultRules() });
});

// PUT /rules — save per-project rules override
router.put('/rules', (req: Request, res: Response) => {
  const project = getActiveProject();
  if (!project) {
    badRequest(res, 'No active project');
    return;
  }
  const parsed = rulesSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  saveProjectRules(project.id, parsed.data.rules);
  res.json({ ok: true, rules: parsed.data.rules });
});

// DELETE /rules — delete per-project override (revert to default)
router.delete('/rules', (_req: Request, res: Response) => {
  const project = getActiveProject();
  if (!project) {
    badRequest(res, 'No active project');
    return;
  }
  const deleted = deleteProjectRules(project.id);
  res.json({ ok: true, deleted, rules: getDefaultRules() });
});

// DELETE /messages — clear chat history for the active project
router.delete('/messages', (_req: Request, res: Response) => {
  registry.clearHistory();
  res.json({ ok: true });
});

// ── Pipe endpoints ───────────────────────────────────────────────────────────

// GET /pipes — list active pipes for the current project
router.get('/pipes', (_req: Request, res: Response) => {
  const projectId = getActiveProject()?.id ?? null;
  res.json(registry.getActivePipes(projectId));
});

// GET /pipes/:id — get a specific pipe run (scoped to active project)
router.get('/pipes/:id', (req: Request, res: Response) => {
  const projectId = getActiveProject()?.id ?? null;
  const run = registry.getPipeRun(req.params.id, projectId);
  if (!run) {
    res.status(404).json({ error: 'Pipe not found' });
    return;
  }
  res.json(run);
});

// POST /pipes/:id/submit — submit a stage artifact for a pipe
const pipeSubmitSchema = z.object({
  from: z.string().min(1),
  content: z.string().min(1),
  projectId: z.string().nullable().optional(),
});

router.post('/pipes/:id/submit', asyncHandler(async (req: Request, res: Response) => {
  const parsed = pipeSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }

  const { from, content, projectId } = parsed.data;
  const pipeId = req.params.id;
  const pid = projectId ?? getActiveProject()?.id ?? null;

  const result = await registry.submitPipeStage(pipeId, from, content, pid);
  if (!result.ok) {
    const status = result.code === 'PIPE_NOT_FOUND' ? 404
      : result.code === 'PIPE_CLOSED' ? 410
      : result.code === 'PIPE_NOT_ASSIGNED' ? 403
      : result.code === 'PIPE_LEASE_NOT_HELD' ? 403
      : result.code === 'PIPE_ALREADY_SUBMITTED' ? 409
      : 400;
    res.status(status).json({ error: result.error, code: result.code });
    return;
  }
  res.status(201).json(result);
}));

// GET /pipes/:id/status — get detailed pipe status from the store
// Accepts optional ?projectId= to scope to a specific project (defaults to active project)
router.get('/pipes/:id/status', (req: Request, res: Response) => {
  const projectId = (req.query.projectId as string | undefined) ?? getActiveProject()?.id ?? null;
  const status = registry.getPipeStoreStatus(req.params.id, projectId);
  if (!status) {
    res.status(404).json({ error: 'Pipe not found in store' });
    return;
  }
  res.json(status);
});

// POST /pipes/:id/cancel — cancel a running pipe (scoped to active project)
router.post('/pipes/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  const projectId = getActiveProject()?.id ?? null;
  const run = registry.getPipeRun(req.params.id, projectId);
  if (!run) {
    res.status(404).json({ error: 'Pipe not found or not running' });
    return;
  }
  const cancelled = await registry.cancelPipeRun(req.params.id, projectId);
  if (!cancelled) {
    res.status(404).json({ error: 'Pipe not found or not running' });
    return;
  }
  res.json({ ok: true, cancelled: req.params.id });
}));

// ── LLM invite endpoints ─────────────────────────────────────────────────────

type PermissionMode = 'supervised' | 'auto-accept' | 'unrestricted';

interface KnownLlm {
  cli: string;
  name: string;
  icon: string;
  /** Permission modes this CLI supports, in display order. 'supervised' is always implicit. */
  modes: PermissionMode[];
  /** Build the shell command to launch this CLI with a bootstrap prompt and permission mode. */
  launchCmd: (prompt: string, mode?: PermissionMode) => string;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Maps permission mode to CLI-specific flags. */
const CLI_MODE_FLAGS: Record<string, Partial<Record<PermissionMode, string[]>>> = {
  claude:  { 'auto-accept': ['--dangerously-skip-permissions'] },
  codex:   { 'auto-accept': ['-a', 'never'] },
  gemini:  {},
  cursor:  {},
};

const KNOWN_LLMS: KnownLlm[] = [
  {
    cli: 'claude', name: 'Claude', icon: '🟣',
    modes: ['supervised', 'auto-accept'],
    launchCmd: (p, mode) => {
      const flags = (mode && CLI_MODE_FLAGS.claude?.[mode]) || [];
      return `claude ${flags.join(' ')}${flags.length ? ' ' : ''}${shellEscape(p)}`;
    },
  },
  {
    cli: 'codex', name: 'Codex', icon: '🟢',
    modes: ['supervised', 'auto-accept'],
    launchCmd: (p, mode) => {
      const flags = (mode && CLI_MODE_FLAGS.codex?.[mode]) || [];
      return `codex ${flags.join(' ')}${flags.length ? ' ' : ''}${shellEscape(p)}`;
    },
  },
  {
    cli: 'gemini', name: 'Gemini', icon: '🔵',
    modes: ['supervised'],
    launchCmd: (p) => `gemini -i ${shellEscape(p)}`,
  },
  {
    cli: 'cursor', name: 'Cursor', icon: '⚪',
    modes: ['supervised'],
    launchCmd: (p) => `cursor-agent chat ${shellEscape(p)}`,
  },
];

/** Binary to probe for each CLI (may differ from the display cli name). */
const CLI_PROBE: Record<string, string> = {
  cursor: 'cursor-agent',
};

let llmCache: { data: AvailableLlm[]; ts: number } | null = null;
const LLM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface AvailableLlm {
  cli: string;
  name: string;
  icon: string;
  modes: PermissionMode[];
}

function buildChatJoinPrompt(cli: string, paneId: string): string {
  return `Join the DevGlide chat room by calling chat_join with name="${cli}" and paneId="${paneId}". `
    + 'After joining, follow the rules of engagement returned by chat_join.';
}

function detectAvailableLlms(rescan = false): AvailableLlm[] {
  if (!rescan && llmCache && Date.now() - llmCache.ts < LLM_CACHE_TTL_MS) {
    return llmCache.data;
  }
  const available: AvailableLlm[] = [];
  for (const llm of KNOWN_LLMS) {
    const bin = CLI_PROBE[llm.cli] ?? llm.cli;
    try {
      execSync(`${bin} --version`, { stdio: 'pipe', timeout: 5000 });
      available.push({ cli: llm.cli, name: llm.name, icon: llm.icon, modes: llm.modes });
    } catch {
      // not installed
    }
  }
  llmCache = { data: available, ts: Date.now() };
  return available;
}

// GET /invite/available — list LLM CLIs detected on PATH (cached; ?rescan=true to force)
router.get('/invite/available', (req: Request, res: Response) => {
  const rescan = req.query.rescan === 'true' || req.query.rescan === '1';
  res.json(detectAvailableLlms(rescan));
});

const PERMISSION_MODES = ['supervised', 'auto-accept', 'unrestricted'] as const;

// ── Shell readiness detection for invite ──────────────────────────────────────
// Instead of a hardcoded `sleep 0.5`, we detect when the shell is actually
// ready to accept input by watching PTY output for a prompt or using a probe.
// Prompt/ANSI helpers are shared with chat-registry via terminal-utils.

import { hasShellPrompt } from '../apps/chat/services/terminal-utils.js';

const SHELL_READY_TIMEOUT_MS = 5000;

type ReadyOutcome = 'prompt' | 'probe' | 'closed';

/**
 * Wait until a freshly-spawned PTY is ready to accept input.
 *
 * 1. Check full scrollback for a shell prompt (may already be there from spawn).
 * 2. Watch live PTY output for a prompt pattern.
 * 3. On timeout, inject an `echo <marker>` probe and scan scrollback for it.
 * 4. If the pane exits, abort.
 *
 * All branches funnel through a one-shot resolver with centralized cleanup.
 * For invite panes are always fresh, so scanning full scrollback is safe.
 * The probe path uses a separate offset to avoid matching stale output.
 */
function waitForShellReady(paneId: string): Promise<ReadyOutcome> {
  return new Promise<ReadyOutcome>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];

    function settle(outcome: ReadyOutcome): void {
      if (settled) return;
      settled = true;
      cleanups.forEach(fn => fn());
      resolve(outcome);
    }

    const entry = globalPtys.get(paneId);
    if (!entry) { resolve('closed'); return; }

    // Helper: get full scrollback or from a specific offset
    function scrollback(fromOffset?: number): string {
      const full = entry!.chunks.join('');
      return fromOffset != null ? full.slice(fromOffset) : full;
    }

    // 1. Check full buffered output (prompt may already be there from spawn)
    if (hasShellPrompt(scrollback())) {
      resolve('prompt');
      return;
    }

    // 2. Watch live output for a prompt (scan full scrollback to handle chunk splits)
    const promptDisposable = entry.ptyProcess.onData(() => {
      if (hasShellPrompt(scrollback())) {
        settle('prompt');
      }
    });
    cleanups.push(() => promptDisposable.dispose());

    // 3. Timeout → inject echo probe, watch for marker in scrollback from probe offset
    const timer = setTimeout(() => {
      if (settled) return;
      const marker = `__DEVGLIDE_READY_${Date.now()}__`;
      const probeOffset = entry.totalLen;

      // Attach probe watcher BEFORE injecting echo to avoid race
      const probeDisposable = entry.ptyProcess.onData(() => {
        if (scrollback(probeOffset).includes(marker)) {
          settle('probe');
        }
      });
      cleanups.push(() => probeDisposable.dispose());

      entry.ptyProcess.write(`echo ${marker}\r`);
    }, SHELL_READY_TIMEOUT_MS);
    cleanups.push(() => clearTimeout(timer));

    // 4. Pane exit → abort
    const exitDisposable = entry.ptyProcess.onExit(() => {
      settle('closed');
    });
    cleanups.push(() => exitDisposable.dispose());
  });
}

const inviteSchema = z.object({
  cli: z.string().min(1),
  mode: z.enum(PERMISSION_MODES).optional().default('supervised'),
  cols: z.coerce.number().int().min(1).max(500).optional(),
  rows: z.coerce.number().int().min(1).max(500).optional(),
});

// POST /invite — create a pane and launch an LLM CLI in it
router.post('/invite', asyncHandler(async (req: Request, res: Response) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return badRequest(res, parsed.error.issues[0]?.message ?? 'cli is required');
  }

  const { cli, mode, cols, rows } = parsed.data;
  const llm = KNOWN_LLMS.find(l => l.cli === cli);
  if (!llm) {
    return badRequest(res, `Unknown LLM CLI: ${cli}`);
  }

  // Validate the requested mode is supported by this CLI
  if (mode !== 'supervised' && !llm.modes.includes(mode)) {
    return badRequest(res, `${llm.name} does not support "${mode}" mode. Supported: ${llm.modes.join(', ')}`);
  }

  // Verify CLI is available
  const bin = CLI_PROBE[cli] ?? cli;
  try {
    execSync(`${bin} --version`, { stdio: 'pipe', timeout: 5000 });
  } catch {
    return badRequest(res, `${bin} is not installed or not on PATH`);
  }

  const projectId = getActiveProject()?.id ?? null;
  const project = getActiveProject();

  // Enforce per-project pane limit
  if (panesForProject(projectId) >= MAX_PANES) {
    return badRequest(res, `Maximum pane limit (${MAX_PANES}) per project reached`);
  }

  // Invite panes need a POSIX shell for single-quote escaping.
  // Resolve the best available bash: git-bash on Windows if present, then PATH bash.
  const gitBashPath = SHELL_CONFIGS['git-bash']?.command;
  const useGitBash = process.platform === 'win32' && gitBashPath && existsSync(gitBashPath);
  const inviteShellType = useGitBash ? 'git-bash' : 'bash';
  const config = SHELL_CONFIGS[inviteShellType];
  const startCwd = project?.path ?? process.env.HOME ?? process.env.USERPROFILE ?? '/';
  const paneId = nextPaneId();
  const bootstrap = buildChatJoinPrompt(cli, paneId);
  const inviteCmd = llm.launchCmd(bootstrap, mode);
  // Spawn an interactive login shell — command injection happens AFTER readiness detection
  const shellArgs = [...config.args, '-li'];

  const num = nextNumForProject(projectId);
  const modeLabel = mode !== 'supervised' ? ` [${mode === 'auto-accept' ? 'AUTO' : 'UNRESTRICTED'}]` : '';
  const title = `${num}: ${cli}${modeLabel}`;

  // Join all connected dashboard sockets to the new pane room BEFORE spawning
  // the PTY — same as the socket-based pane:create handler.  Without this,
  // terminal output is emitted to an empty room and the pane appears black.
  getShellNsp()?.socketsJoin(`pane:${paneId}`);

  spawnGlobalPty(
    paneId,
    config.command,
    shellArgs,
    { ...config.env, DEVGLIDE_PANE_ID: paneId },
    cols ?? 80,
    rows ?? 24,
    true,
    false,
    startCwd,
  );

  const paneInfo: PaneInfo = {
    id: paneId,
    shellType: inviteShellType,
    title,
    num,
    cwd: startCwd,
    projectId,
    llmCli: cli,
    permissionMode: mode,
  };
  dashboardState.panes.push(paneInfo);
  getShellNsp()?.emit('state:pane-added', paneInfo);

  // Wait for the shell to be ready, then inject the LLM launch command.
  // This replaces the old `sleep 0.5` with proper readiness detection.
  // Invite panes are always fresh, so scanning full scrollback is safe.
  waitForShellReady(paneId).then((outcome) => {
    if (outcome === 'closed') return; // pane died before shell was ready
    const entry = globalPtys.get(paneId);
    if (!entry) return;
    entry.ptyProcess.write(`${inviteCmd}\r`);
  });

  res.status(201).json({ ok: true, paneId, cli: llm.cli, name: llm.name, mode });
}));

// ── Socket.io initializer ────────────────────────────────────────────────────

/** Join the Socket.io room for the given project. */
function joinProjectRoom(socket: import('socket.io').Socket, projectId: string): void {
  socket.join(`project:${projectId}`);
}

/** Leave all project: rooms. */
function leaveAllProjectRooms(socket: import('socket.io').Socket): void {
  for (const room of socket.rooms) {
    if (room.startsWith('project:')) socket.leave(room);
  }
}

export function initChat(nsp: Namespace): void {
  registry.setChatNsp(nsp);

  // Restore participants from disk after server restart — per-project with scoped notifications
  const allProjects = listProjects().projects;
  const projectResults: Array<{ projectId: string; restored: string[]; failed: string[]; interruptedPipes: string[] }> = [];
  for (const proj of allProjects) {
    const { restored, failed } = registry.restoreParticipants(proj.id);
    const interruptedPipes = registry.restorePipes(proj.id);
    if (restored.length > 0 || failed.length > 0 || interruptedPipes.length > 0) {
      projectResults.push({ projectId: proj.id, restored, failed, interruptedPipes });
    }
  }
  if (projectResults.length > 0) {
    // Emit per-project notifications after nsp is set so dashboard clients see them
    setTimeout(() => {
      for (const { projectId, restored, failed, interruptedPipes } of projectResults) {
        let body = 'Server restarted.';
        if (restored.length > 0) body += ` Restored (awaiting reclaim): ${restored.join(', ')}.`;
        if (failed.length > 0) body += ` Failed to restore: ${failed.join(', ')}.`;
        if (interruptedPipes.length > 0) body += ` Interrupted pipes: ${interruptedPipes.map(id => `#${id}`).join(', ')}.`;
        const msg = store.appendMessage({
          from: 'system',
          to: null,
          body,
          type: 'system',
        }, projectId);
        // Emit scoped to this project's room
        nsp.to(`project:${projectId}`).emit('chat:message', msg);
        nsp.to(`project:${projectId}`).emit('chat:members', registry.listParticipants(projectId));
      }
    }, 100);
  }

  // When the active project changes, move all connected sockets to the new room
  onProjectChange((p) => {
    for (const [, socket] of nsp.sockets) {
      leaveAllProjectRooms(socket);
      if (p) joinProjectRoom(socket, p.id);
    }
    // No replay here — the frontend's onProjectChange handler calls loadInitialData()
  });

  nsp.on('connection', (socket) => {
    // Join the room for the active project
    const project = getActiveProject();
    if (project) joinProjectRoom(socket, project.id);

    // Send current members on connect
    socket.emit('chat:members', registry.listParticipants());

    // Send recent messages for context (already project-scoped via store)
    const recent = store.readMessages({ limit: 50 });
    for (const msg of recent) {
      socket.emit('chat:message', msg);
    }

    // Handle send from dashboard
    socket.on('chat:send', async ({ message, to }: { message: string; to?: string }) => {
      if (!message || typeof message !== 'string') return;
      const error = getBlockedPipeReferenceError(message);
      if (error) {
        socket.emit('chat:error', { error });
        return;
      }
      await registry.send('user', message, to);
    });

    // Handle clear from dashboard
    socket.on('chat:clear', () => {
      registry.clearHistory();
    });
  });
}
