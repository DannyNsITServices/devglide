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
  hasChatMcpHttpSession,
  registerChatMcpHttpSession,
  unregisterChatMcpHttpSession,
} from '../apps/chat/src/mcp.js';

export {
  createChatMcpServer,
  chatServerSessions,
  bindChatSessionToMcpHttpSession,
  hasChatMcpHttpSession,
  registerChatMcpHttpSession,
  unregisterChatMcpHttpSession,
};

export const router: Router = Router();

// ── Zod schemas ──────────────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  message: z.string().min(1, 'message is required'),
  to: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
});

const pipeEventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
  pipeId: z.string().optional(),
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

function resolveProjectIdInput(
  res: Response,
  requestedProjectId: string | null | undefined,
  fallbackProjectId: string | null = getActiveProject()?.id ?? null,
): string | null | undefined {
  if (requestedProjectId === undefined) return fallbackProjectId;
  if (requestedProjectId === null) return null;
  if (listProjects().projects.some(project => project.id === requestedProjectId)) {
    return requestedProjectId;
  }
  badRequest(res, `Unknown projectId "${requestedProjectId}"`);
  return undefined;
}

function getRequestedProjectId(req: Request, res: Response, bodyProjectId?: string | null): string | null | undefined {
  const queryProjectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  return resolveProjectIdInput(res, bodyProjectId ?? queryProjectId);
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

/** Build a map of paneId → participant name for all non-detached participants. */
function buildClaimedPanesMap(participants: { paneId: string | null; name: string; detached: boolean }[]): Map<string, string> {
  const claimed = new Map<string, string>();
  for (const p of participants) {
    if (p.paneId && !p.detached) claimed.set(p.paneId, p.name);
  }
  return claimed;
}

/** Convert a dashboard pane to a RoutablePane with claim status. */
function toRoutablePane(pane: typeof dashboardState.panes[number], claimedPanes: Map<string, string>): RoutablePane {
  return {
    id: pane.id,
    num: pane.num,
    title: pane.title ?? `pane-${pane.num}`,
    projectId: pane.projectId ?? null,
    cwd: pane.cwd ?? '',
    chatName: pane.chatName,
    claimed: claimedPanes.has(pane.id),
    claimedBy: claimedPanes.get(pane.id),
  };
}

/** Get all routable panes globally (not filtered by project). Used for claim checks. */
function getRoutablePanesGlobal(): RoutablePane[] {
  // Collect claimed panes from ALL participants across all projects
  const allParticipants: { paneId: string | null; name: string; detached: boolean }[] = [];
  for (const pane of dashboardState.panes) {
    const pid = pane.projectId ?? null;
    allParticipants.push(...registry.listParticipants(pid));
  }
  const claimedPanes = buildClaimedPanesMap(allParticipants);

  return dashboardState.panes
    .filter(pane => globalPtys.has(pane.id))
    .map(pane => toRoutablePane(pane, claimedPanes));
}

function getRoutablePanes(projectId?: string | null): RoutablePane[] {
  const pid = projectId ?? getActiveProject()?.id ?? null;
  const claimedPanes = buildClaimedPanesMap(registry.listParticipants(pid));

  return dashboardState.panes
    .filter(pane => globalPtys.has(pane.id) && !(pid && pane.projectId && pane.projectId !== pid))
    .map(pane => toRoutablePane(pane, claimedPanes));
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

function resolvePane(
  suppliedPaneId: string | null | undefined,
  projectId: string | null,
  claimantNameBase?: string,
): PaneResolutionResult {
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
      const sameIdentity = !!claimantNameBase
        && (claimedBy.claimedBy === claimantNameBase || claimedBy.claimedBy.startsWith(`${claimantNameBase}-`));
      if (!isReclaim && !sameIdentity) {
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
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;
  res.json(getRoutablePanes(projectId));
});

// GET /status — connection diagnostics for a participant
// Accepts optional ?projectId= to scope to a specific project (defaults to active project)
// Accepts optional ?name= to get diagnostics for a specific participant
router.get('/status', (req: Request, res: Response) => {
  const name = req.query.name as string | undefined;
  const paneId = req.query.paneId as string | undefined;
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;

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
        joinedVia: participant.joinedVia ?? null,
        status: participant.status,
        autoResolveWouldPick: unclaimed.length === 1 ? unclaimed[0].id : unclaimed.length === 0 ? null : `ambiguous: ${unclaimed.map(p => p.id).join(', ')}`,
        activeMembers: registry.listParticipants(projectId).map(m => ({ name: m.name, status: m.status, paneId: m.paneId, detached: m.detached, joinedVia: m.joinedVia ?? null })),
      });
      return;
    }

    // Return general status: all members + pane info
    const members = registry.listParticipants(projectId);
    const panes = getRoutablePanes(projectId);
    const unclaimed = panes.filter(p => !p.claimed);
    res.json({
      projectId,
      activeMembers: members.map(m => ({ name: m.name, status: m.status, paneId: m.paneId, detached: m.detached, joinedVia: m.joinedVia ?? null })),
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
    joinedVia: participant.joinedVia ?? null,
    status: participant.status,
    autoResolveWouldPick: unclaimed.length === 1 ? unclaimed[0].id : unclaimed.length === 0 ? null : `ambiguous: ${unclaimed.map(p => p.id).join(', ')}`,
    activeMembers: registry.listParticipants(projectId).map(m => ({ name: m.name, status: m.status, paneId: m.paneId, detached: m.detached, joinedVia: m.joinedVia ?? null })),
  });
});

// GET /messages — read message history
router.get('/messages', (req: Request, res: Response) => {
  const query = messagesQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const messages = store.readMessages(query.data, projectId);
  res.json(messages);
});

// GET /pipe-events — read persisted UI-only pipe events (kept out of chat history)
router.get('/pipe-events', (req: Request, res: Response) => {
  const query = pipeEventsQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const events = store.readPipeEvents(query.data, projectId);
  res.json(events);
});

// POST /messages — send as "user" (dashboard shorthand)
// Accepts body `projectId` to target a specific project without relying on the active-project singleton.
router.post('/messages', asyncHandler(async (req: Request, res: Response) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const projectId = getRequestedProjectId(req, res, parsed.data.projectId);
  if (projectId === undefined) return;
  const error = getBlockedPipeReferenceError(parsed.data.message, projectId);
  if (error) {
    res.status(422).json({ error });
    return;
  }
  const msg = await registry.send('user', parsed.data.message, parsed.data.to, projectId);
  res.status(201).json(msg);
}));

// GET /members — list active participants
router.get('/members', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  res.json(registry.listParticipants(projectId));
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
  const resolution = resolvePane(paneId, projectId, registry.deriveNameBase(name, model ?? null));

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
  const mcpSessionId = req.headers['mcp-session-id'];
  const effectiveJoinVia =
    typeof mcpSessionId === 'string' && mcpSessionId && hasChatMcpHttpSession(mcpSessionId)
      ? 'mcp'
      : 'rest';
  const participant = registry.join(name, 'llm', resolvedPaneId, model ?? null, resolvedSubmitKey, paneProjectId, effectiveJoinVia);
  if (effectiveJoinVia === 'mcp' && typeof mcpSessionId === 'string' && mcpSessionId) {
    const bound = bindChatSessionToMcpHttpSession(mcpSessionId, { name: participant.name, projectId: participant.projectId ?? null });
    if (bound) {
      participant.joinedVia = 'mcp';
      registry.persistParticipantsForProject(participant.projectId);
    }
  }
  const rules = getEffectiveRules(participant.projectId);
  const assignments = registry.listAssignments(participant.name, participant.projectId ?? null);
  const pendingAssignments = assignments.filter(a => a.slotStatus === 'pending' || a.slotStatus === 'leased').length;
  res.status(201).json({ ...participant, rules, pendingAssignments });
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
  const pid = resolveProjectIdInput(res, projectId);
  if (pid === undefined) return;
  const error = getBlockedPipeReferenceError(message, pid);
  if (error) {
    res.status(422).json({ error });
    return;
  }
  const msg = await registry.send(from, message, to, pid);
  res.status(201).json(msg);
}));

// ── Rules of Engagement CRUD ──────────────────────────────────────────────────

const rulesSchema = z.object({
  rules: z.string().min(1, 'rules text is required'),
});

// GET /rules — get effective rules for the scoped project
router.get('/rules', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const rules = getEffectiveRules(projectId);
  const isDefault = !projectId || !hasProjectRules(projectId);
  res.json({ rules, isDefault, defaultRules: getDefaultRules() });
});

// PUT /rules — save per-project rules override
router.put('/rules', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  if (!projectId) {
    badRequest(res, 'No active project');
    return;
  }
  const parsed = rulesSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  saveProjectRules(projectId, parsed.data.rules);
  res.json({ ok: true, rules: parsed.data.rules });
});

// DELETE /rules — delete per-project override (revert to default)
router.delete('/rules', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  if (!projectId) {
    badRequest(res, 'No active project');
    return;
  }
  const deleted = deleteProjectRules(projectId);
  res.json({ ok: true, deleted, rules: getDefaultRules() });
});

// DELETE /messages — clear chat history for the scoped project
router.delete('/messages', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  registry.clearHistory(projectId);
  res.json({ ok: true });
});

// ── Pipe endpoints ───────────────────────────────────────────────────────────

// GET /pipes — list active pipes for the scoped project
router.get('/pipes', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  res.json(registry.getActivePipes(projectId));
});

// GET /pipes/all — list all pipes (running + terminal) with slot summaries
router.get('/pipes/all', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  res.json(registry.listAllPipes(projectId));
});

// GET /pipes/leases — runtime lease statuses with elapsed/remaining
router.get('/pipes/leases', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  res.json(registry.getRuntimeLeaseStatuses(projectId));
});

// GET /pipes/dead-letters — stuck and expired assignments
router.get('/pipes/dead-letters', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  res.json(registry.getDeadLetterEntries(projectId));
});

// GET /pipes/provenance — query provenance records across all pipes
router.get('/pipes/provenance', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const { pipeId, actor, event, since } = req.query as Record<string, string | undefined>;
  res.json(registry.queryPipeProvenance(projectId, { pipeId, actor, event, since }));
});

// GET /pipes/assignments — list assignments for a participant
router.get('/pipes/assignments', (req: Request, res: Response) => {
  const assignee = req.query.assignee as string | undefined;
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;
  if (!assignee) { res.status(400).json({ error: 'assignee query parameter is required' }); return; }
  res.json(registry.listAssignments(assignee, projectId));
});

// GET /pipes/:id/assignment — get assignment for calling participant
router.get('/pipes/:id/assignment', (req: Request, res: Response) => {
  const paneId = req.headers['x-pane-id'] as string | undefined;
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;
  if (!paneId) { res.status(401).json({ error: 'X-Pane-Id header is required' }); return; }
  const participant = registry.getParticipantByPaneId(paneId, projectId);
  if (!participant) { res.status(403).json({ error: 'No registered participant for the supplied pane' }); return; }
  const assignment = registry.getAssignment(req.params.id, participant.name, projectId);
  if (!assignment) { res.status(404).json({ error: 'No assignment found' }); return; }
  res.json(assignment);
});

// GET /pipes/:id — get a specific pipe run (scoped to active project)
router.get('/pipes/:id', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const run = registry.getPipeRun(req.params.id, projectId);
  if (!run) {
    res.status(404).json({ error: 'Pipe not found' });
    return;
  }
  res.json(run);
});

// GET /pipes/:id/output — read the caller-scoped pipe output
// Caller identity is resolved server-side from the X-Pane-Id header via the participant registry.
router.get('/pipes/:id/output', (req: Request, res: Response) => {
  const paneId = req.headers['x-pane-id'] as string | undefined;
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;

  if (!paneId) {
    res.status(401).json({ error: 'X-Pane-Id header is required' });
    return;
  }

  const participant = registry.getParticipantByPaneId(paneId, projectId);
  if (!participant) {
    res.status(403).json({ error: 'No registered participant for the supplied pane' });
    return;
  }

  const result = registry.readPipeOutput(req.params.id, participant.name, projectId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

// POST /pipes/:id/submit — submit a stage artifact for a pipe
const pipeSubmitSchema = z.object({
  from: z.string().min(1),
  content: z.string().min(1),
  assignmentId: z.string().optional(),
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
  const pid = resolveProjectIdInput(res, projectId);
  if (pid === undefined) return;

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
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;
  const status = registry.getPipeStoreStatus(req.params.id, projectId);
  if (!status) {
    res.status(404).json({ error: 'Pipe not found in store' });
    return;
  }
  res.json(status);
});

// POST /pipes/:id/cancel — cancel a running pipe (scoped to active project)
router.post('/pipes/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
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

// GET /pipes/:id/timing — timing summary with per-stage breakdown
router.get('/pipes/:id/timing', (req: Request, res: Response) => {
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;
  const timing = registry.getPipeTimingSummary(req.params.id, projectId);
  if (!timing) { res.status(404).json({ error: 'Pipe not found' }); return; }
  res.json(timing);
});

// GET /pipes/:id/provenance — provenance audit trail for a pipe
router.get('/pipes/:id/provenance', (req: Request, res: Response) => {
  const projectId = resolveProjectIdInput(res, req.query.projectId as string | undefined);
  if (projectId === undefined) return;
  res.json(registry.getPipeProvenance(req.params.id, projectId));
});
// ── Brainstorm endpoints ─────────────────────────────────────────────────────

// GET /brainstorms — list active brainstorms
router.get('/brainstorms', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  res.json(registry.getActiveBrainstorms(projectId));
});

// GET /brainstorms/:id — get brainstorm status
router.get('/brainstorms/:id', (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const record = registry.getBrainstormRecord(req.params.id, projectId);
  if (!record) {
    res.status(404).json({ error: 'Brainstorm not found' });
    return;
  }
  res.json(record);
});

// POST /brainstorms/:id/accept-idea
router.post('/brainstorms/:id/accept-idea', asyncHandler(async (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const ok = await registry.brainstormAcceptIdea(req.params.id, projectId);
  if (!ok) {
    res.status(409).json({ error: 'Brainstorm not in ideas_review phase' });
    return;
  }
  res.json({ ok: true });
}));

// POST /brainstorms/:id/retry-ideas
const brainstormNoteSchema = z.object({ note: z.string().nullable().optional() });

router.post('/brainstorms/:id/retry-ideas', asyncHandler(async (req: Request, res: Response) => {
  const parsed = brainstormNoteSchema.safeParse(req.body);
  const note = parsed.success ? (parsed.data.note ?? null) : null;
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const ok = await registry.brainstormRetryIdeas(req.params.id, note, projectId);
  if (!ok) {
    res.status(409).json({ error: 'Brainstorm not in ideas_review phase' });
    return;
  }
  res.json({ ok: true });
}));

// POST /brainstorms/:id/adjust-details
router.post('/brainstorms/:id/adjust-details', asyncHandler(async (req: Request, res: Response) => {
  const parsed = brainstormNoteSchema.safeParse(req.body);
  const note = parsed.success ? (parsed.data.note ?? null) : null;
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const ok = await registry.brainstormAdjustDetails(req.params.id, note, projectId);
  if (!ok) {
    res.status(409).json({ error: 'Brainstorm not in details_review phase' });
    return;
  }
  res.json({ ok: true });
}));

// POST /brainstorms/:id/finalize
router.post('/brainstorms/:id/finalize', asyncHandler(async (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const ok = await registry.brainstormFinalize(req.params.id, projectId);
  if (!ok) {
    res.status(409).json({ error: 'Brainstorm not in details_review phase' });
    return;
  }
  res.json({ ok: true });
}));

// POST /brainstorms/:id/back-to-ideas
router.post('/brainstorms/:id/back-to-ideas', asyncHandler(async (req: Request, res: Response) => {
  const projectId = getRequestedProjectId(req, res);
  if (projectId === undefined) return;
  const ok = await registry.brainstormBackToIdeas(req.params.id, projectId);
  if (!ok) {
    res.status(409).json({ error: 'Brainstorm not in details_review phase' });
    return;
  }
  res.json({ ok: true });
}));

// ── LLM invite endpoints ─────────────────────────────────────────────────────

type PermissionMode = 'supervised' | 'auto-accept' | 'unrestricted';

interface KnownLlm {
  cli: string;
  name: string;
  icon: string;
  /** Permission modes this CLI supports, in display order. 'supervised' is always implicit unless `dangerByDefault` is set. */
  modes: PermissionMode[];
  /**
   * If true, this CLI runs without sandboxing/approval prompts by default. The launch UI must
   * always show a confirmation, the supervised mode is rejected at the API layer, and the
   * frontend should render a danger-styled warning.
   */
  dangerByDefault?: boolean;
  /** Build the shell command to launch this CLI with a bootstrap prompt and permission mode. */
  launchCmd: (prompt: string, mode?: PermissionMode, executable?: string) => string;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Maps permission mode to CLI-specific flags. */
const CLI_MODE_FLAGS: Record<string, Partial<Record<PermissionMode, string[]>>> = {
  claude:  { 'auto-accept': ['--dangerously-skip-permissions'] },
  codex:   { 'auto-accept': ['--dangerously-bypass-approvals-and-sandbox'] },
  gemini:  {},
  cursor:  {},
  // Pi runs without sandboxing or approval prompts by default — no flags needed.
  pi:      {},
};

const KNOWN_LLMS: KnownLlm[] = [
  {
    cli: 'claude', name: 'Claude', icon: '🟣',
    modes: ['supervised', 'auto-accept'],
    launchCmd: (p, mode, executable = 'claude') => {
      const flags = (mode && CLI_MODE_FLAGS.claude?.[mode]) || [];
      return `${shellEscape(executable)} ${flags.join(' ')}${flags.length ? ' ' : ''}${shellEscape(p)}`;
    },
  },
  {
    cli: 'codex', name: 'Codex', icon: '🟢',
    modes: ['supervised', 'auto-accept'],
    launchCmd: (p, mode, executable = 'codex') => {
      const flags = (mode && CLI_MODE_FLAGS.codex?.[mode]) || [];
      return `${shellEscape(executable)} ${flags.join(' ')}${flags.length ? ' ' : ''}${shellEscape(p)}`;
    },
  },
  {
    cli: 'gemini', name: 'Gemini', icon: '🔵',
    modes: ['supervised'],
    launchCmd: (p, _mode, executable = 'gemini') => `${shellEscape(executable)} -i ${shellEscape(p)}`,
  },
  {
    cli: 'cursor', name: 'Cursor', icon: '⚪',
    modes: ['supervised'],
    launchCmd: (p, _mode, executable = 'cursor-agent') => `${shellEscape(executable)} chat ${shellEscape(p)}`,
  },
  {
    cli: 'pi', name: 'Pi', icon: '🟡',
    // Pi has no sandboxing or approval prompts by default; only the auto button is exposed
    // and the frontend renders a danger-styled confirmation. See `dangerByDefault`.
    modes: ['auto-accept'],
    dangerByDefault: true,
    launchCmd: (p, _mode, executable = 'pi') => `${shellEscape(executable)} --model lmstudio/google/gemma-4-26b-a4b ${shellEscape(p)}`,
  },
];

/** Probe candidates for each CLI, in order. */
const CLI_PROBE_CANDIDATES: Record<string, string[]> = {
  cursor: ['cursor-agent', 'cursor-agent.cmd', 'agent.cmd', 'cursor-agent.sh', 'agent.sh'],
};

let llmCache: { data: AvailableLlm[]; ts: number } | null = null;
const LLM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface AvailableLlm {
  cli: string;
  name: string;
  icon: string;
  modes: PermissionMode[];
  dangerByDefault?: boolean;
}

function getCliProbeCandidates(cli: string): string[] {
  return CLI_PROBE_CANDIDATES[cli] ?? [cli];
}

function resolveCliCommand(cli: string): string | null {
  for (const candidate of getCliProbeCandidates(cli)) {
    try {
      execSync(`${candidate} --version`, { stdio: 'pipe', timeout: 5000 });
      return candidate;
    } catch {
      // not installed; try the next candidate
    }
  }
  return null;
}


const CHAT_HTTP_BASE = `http://localhost:${process.env.PORT ?? 7000}/api/chat`;

function buildChatJoinPrompt(cli: string, paneId: string, joinedName: string, projectId: string | null): string {
  const projectQuery = projectId ? `?projectId=${projectId}` : '';
  const projectField = projectId ? `, projectId:"${projectId}"` : '';
  return `You are already registered in the DevGlide chat room via a REST fallback as "${joinedName}" on pane "${paneId}". `
    + 'Use the exact MCP server/tool name `devglide-chat` / `mcp__devglide-chat__chat_join` if it is available, '
    + `and call it with name="${cli}" and paneId="${paneId}" to unify this MCP session and read the rules of engagement. `
    + 'If `mcp__devglide-chat__chat_join` is not available yet, stay on the existing REST-backed chat session for this pane and do not try to re-register. '
    + `If the chat MCP tools still are not available, use the REST API at "${CHAT_HTTP_BASE}" instead: `
    + `GET "${CHAT_HTTP_BASE}/rules${projectQuery}" to read the rules, `
    + `GET "${CHAT_HTTP_BASE}/messages${projectQuery}" to read history, `
    + `POST "${CHAT_HTTP_BASE}/send" with {from:"${joinedName}", message, to?${projectField}} to send chat messages as yourself, `
    + `POST "${CHAT_HTTP_BASE}/leave" with {name:"${joinedName}"${projectField}} to leave, `
    + `GET "${CHAT_HTTP_BASE}/pipes/:id/output${projectQuery}" with header X-Pane-Id: "${paneId}" to read pipe input, `
    + `and POST "${CHAT_HTTP_BASE}/pipes/:id/submit" with {from:"${joinedName}", content${projectField}} for pipe stage output. `
    + `When the chat MCP tools appear, use \`chat_send(..., paneId="${paneId}")\`, \`chat_leave(paneId="${paneId}")\`, `
    + `or \`pipe_submit(..., paneId="${paneId}")\` to adopt that session. `
    + 'After you have the rules of engagement, follow them exactly.';
}

function detectAvailableLlms(rescan = false): AvailableLlm[] {
  if (!rescan && llmCache && Date.now() - llmCache.ts < LLM_CACHE_TTL_MS) {
    return llmCache.data;
  }
  const available: AvailableLlm[] = [];
  for (const llm of KNOWN_LLMS) {
    if (resolveCliCommand(llm.cli)) {
      const entry: AvailableLlm = { cli: llm.cli, name: llm.name, icon: llm.icon, modes: llm.modes };
      if (llm.dangerByDefault) entry.dangerByDefault = true;
      available.push(entry);
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

      // Bounded fallback: if the marker never echoes back (wedged pane), give
      // up instead of waiting forever and leaking listeners.
      const probeTimer = setTimeout(() => settle('closed'), SHELL_READY_TIMEOUT_MS);
      cleanups.push(() => clearTimeout(probeTimer));

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

  // Validate the requested mode is supported by this CLI.
  // `supervised` is implicit for normal CLIs, but `dangerByDefault` LLMs (e.g. Pi) have no
  // supervised mode at all — the API must reject it so callers cannot bypass the auto-only UI.
  if (llm.dangerByDefault) {
    if (!llm.modes.includes(mode)) {
      return badRequest(res, `${llm.name} does not support "${mode}" mode. Supported: ${llm.modes.join(', ')}`);
    }
  } else if (mode !== 'supervised' && !llm.modes.includes(mode)) {
    return badRequest(res, `${llm.name} does not support "${mode}" mode. Supported: ${llm.modes.join(', ')}`);
  }

  // Verify CLI is available
  const resolvedBin = resolveCliCommand(cli);
  if (!resolvedBin) {
    const candidates = getCliProbeCandidates(cli).join(', ');
    return badRequest(res, `${llm.name} is not installed or not on PATH (tried: ${candidates})`);
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

  // Pre-register the invited pane in chat so the room can address it even if
  // the client starts with `chat_join` missing from the deferred tool list.
  const fallbackParticipant = registry.join(cli, 'llm', paneId, cli, '\r', projectId, 'rest');
  const bootstrap = buildChatJoinPrompt(cli, paneId, fallbackParticipant.name, fallbackParticipant.projectId ?? null);
  const inviteCmd = llm.launchCmd(bootstrap, mode, resolvedBin);

  // Wait for the shell to be ready, then inject the LLM launch command.
  // This replaces the old `sleep 0.5` with proper readiness detection.
  // Invite panes are always fresh, so scanning full scrollback is safe.
  waitForShellReady(paneId).then((outcome) => {
    if (outcome === 'closed') return; // pane died or never became ready
    const entry = globalPtys.get(paneId);
    if (!entry) return;
    entry.ptyProcess.write(`${inviteCmd}\r`);
  }).catch((err) => {
    console.error('[chat] waitForShellReady/inject failed:', err);
  });

  res.status(201).json({
    ok: true,
    paneId,
    cli: llm.cli,
    name: llm.name,
    mode,
    chatParticipant: fallbackParticipant.name,
  });
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
  const projectResults: Array<{ projectId: string; restored: string[]; failed: string[] }> = [];
  for (const proj of allProjects) {
    const { restored, failed } = registry.restoreParticipants(proj.id);
    if (restored.length > 0 || failed.length > 0) {
      projectResults.push({ projectId: proj.id, restored, failed });
    }
  }
  // Recover active pipes from persisted event logs — per-project
  let totalRecoveredPipes = 0;
  for (const proj of allProjects) {
    totalRecoveredPipes += registry.recoverPipes(proj.id);
  }

  // Run stale pipe cleanup on startup (removes terminal pipes older than 24h)
  for (const proj of allProjects) {
    registry.cleanupStalePipes(proj.id);
  }

  if (projectResults.length > 0 || totalRecoveredPipes > 0) {
    // Emit per-project notifications after nsp is set so dashboard clients see them
    setTimeout(() => {
      for (const { projectId, restored, failed } of projectResults) {
        let body = 'Server restarted.';
        if (restored.length > 0) body += ` Restored (awaiting reclaim): ${restored.join(', ')}.`;
        if (failed.length > 0) body += ` Failed to restore: ${failed.join(', ')}.`;
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
    const nextProjectId = p?.id ?? null;
    for (const [, socket] of nsp.sockets) {
      leaveAllProjectRooms(socket);
      socket.data.chatProjectId = nextProjectId;
      if (nextProjectId) joinProjectRoom(socket, nextProjectId);
    }
    // No replay here — the frontend's onProjectChange handler calls loadInitialData()
  });

  nsp.on('connection', (socket) => {
    // Join the room for the active project
    const project = getActiveProject();
    const projectId = project?.id ?? null;
    socket.data.chatProjectId = projectId;
    if (projectId) joinProjectRoom(socket, projectId);

    // Send current members on connect
    socket.emit('chat:members', registry.listParticipants(projectId));

    // Send recent messages for context from the same project this socket joined.
    const recent = store.readMessages({ limit: 50 }, projectId);
    for (const msg of recent) {
      socket.emit('chat:message', msg);
    }

    // Handle send from dashboard
    socket.on('chat:send', async ({ message, to }: { message: string; to?: string }) => {
      if (!message || typeof message !== 'string') return;
      const socketProjectId = typeof socket.data.chatProjectId === 'string' ? socket.data.chatProjectId : null;
      const error = getBlockedPipeReferenceError(message, socketProjectId);
      if (error) {
        socket.emit('chat:error', { error });
        return;
      }
      try {
        await registry.send('user', message, to, socketProjectId);
      } catch (err) {
        // socket.io does not catch listener rejections — an uncaught reject
        // here would surface as an unhandledRejection and can crash the server.
        socket.emit('chat:error', { error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Handle clear from dashboard
    socket.on('chat:clear', () => {
      const socketProjectId = typeof socket.data.chatProjectId === 'string' ? socket.data.chatProjectId : null;
      registry.clearHistory(socketProjectId);
    });
  });
}
