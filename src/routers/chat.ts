import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Namespace } from 'socket.io';
import { z } from 'zod';
import { asyncHandler } from '../packages/error-middleware.js';
import * as registry from '../apps/chat/services/chat-registry.js';
import * as store from '../apps/chat/services/chat-store.js';
import { getEffectiveRules, getDefaultRules, saveProjectRules, deleteProjectRules, hasProjectRules } from '../apps/chat/services/chat-rules.js';
import { getActiveProject, onProjectChange } from '../project-context.js';
import { globalPtys, dashboardState } from '../apps/shell/src/runtime/shell-state.js';

export { createChatMcpServer, chatServerSessions } from '../apps/chat/src/mcp.js';

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

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

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
router.get('/panes', (_req: Request, res: Response) => {
  res.json(getRoutablePanes());
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
  const msg = registry.send('user', parsed.data.message, parsed.data.to);
  res.status(201).json(msg);
}));

// GET /members — list active participants
router.get('/members', (_req: Request, res: Response) => {
  res.json(registry.listParticipants());
});

// POST /join — register a participant (used by MCP bridge)
// Supports paneId: "auto" for server-side pane resolution.
// On failure, returns structured diagnostics with available panes and suggested action.
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

  const projectId = getActiveProject()?.id ?? null;
  const resolution = resolvePane(paneId, projectId);

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
  res.json({ ok: true, left: name });
});

// POST /send — send a message as any participant (used by MCP bridge)
router.post('/send', (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { from, message, to, projectId } = parsed.data;
  const msg = registry.send(from, message, to, projectId ?? undefined);
  res.status(201).json(msg);
});

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
    socket.on('chat:send', ({ message, to }: { message: string; to?: string }) => {
      if (!message || typeof message !== 'string') return;
      registry.send('user', message, to);
    });

    // Handle clear from dashboard
    socket.on('chat:clear', () => {
      registry.clearHistory();
    });
  });
}
