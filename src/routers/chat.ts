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

export { createChatMcpServer, chatServerSessions } from '../apps/chat/mcp.js';

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

// ── REST API ─────────────────────────────────────────────────────────────────

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
  if (!paneId) {
    badRequest(res, 'paneId is required for PTY delivery');
    return;
  }
  if (!globalPtys.has(paneId)) {
    badRequest(res, `Pane not found or not routable for PTY delivery: ${paneId}`);
    return;
  }
  const paneInfo = dashboardState.panes.find(p => p.id === paneId);
  const projectId = paneInfo?.projectId ?? getActiveProject()?.id ?? null;
  const resolvedSubmitKey = submitKey === 'lf' ? '\n' : '\r';
  const participant = registry.join(name, 'llm', paneId, model ?? null, resolvedSubmitKey, projectId);
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
