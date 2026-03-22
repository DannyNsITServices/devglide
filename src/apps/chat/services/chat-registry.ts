import type { Namespace } from 'socket.io';
import type { ChatParticipant, ChatMessage } from '../types.js';
import { globalPtys, dashboardState, getShellNsp } from '../../shell/src/runtime/shell-state.js';
import { appendMessage, clearMessages } from './chat-store.js';
import { getActiveProject, onProjectChange } from '../../../project-context.js';

// In-memory participant registry
const participants = new Map<string, ChatParticipant>();
let chatNsp: Namespace | null = null;
const paneDeliveryQueues = new Map<string, Promise<void>>();
const participantSessionEpochs = new Map<string, number>();

const PTY_SUBMIT_DELAY_MS = 500;
const PTY_RETRY_SUBMIT_DELAY_MS = 1000;

function bumpParticipantSessionEpoch(name: string): number {
  const next = (participantSessionEpochs.get(name) ?? 0) + 1;
  participantSessionEpochs.set(name, next);
  return next;
}

function currentParticipantSessionEpoch(name: string): number {
  return participantSessionEpochs.get(name) ?? 0;
}

function activeProjectId(): string | null {
  return getActiveProject()?.id ?? null;
}

export function setChatNsp(nsp: Namespace): void {
  chatNsp = nsp;
}

/** Emit to all dashboard clients viewing the given project (or active project). */
function emitToProject(event: string, data: unknown, projectId?: string | null): void {
  const pid = projectId ?? activeProjectId();
  if (!chatNsp) return;
  if (pid) {
    chatNsp.to(`project:${pid}`).emit(event, data);
  } else {
    // Fallback: no project context — broadcast to all (shouldn't happen in practice)
    chatNsp.emit(event, data);
  }
}

// Emit refreshed member list when the active project changes
onProjectChange(() => {
  emitToProject('chat:members', listParticipants());
});

export function getChatNsp(): Namespace | null {
  return chatNsp;
}

// ── Memorable name generator ────────────────────────────────────────────────
const NAMES = [
  'bob', 'nick', 'mike', 'alex', 'sam', 'max', 'leo', 'ray', 'jay', 'kai',
  'zoe', 'ada', 'eva', 'ivy', 'mia', 'ava', 'eli', 'ben', 'tom', 'dan',
  'finn', 'hugo', 'iris', 'luna', 'nora', 'owen', 'reed', 'ruby', 'seth', 'vera',
];

/** Pick a unique name from the pool (e.g. "bob", "ada"). */
function generateUniqueName(): string {
  const usedNames = new Set(participants.keys());
  // Shuffle and pick first available
  const shuffled = [...NAMES].sort(() => Math.random() - 0.5);
  for (const name of shuffled) {
    if (!usedNames.has(name)) return name;
  }
  // Fallback: sequential if all names taken
  let i = 1;
  while (usedNames.has(`agent-${i}`)) i++;
  return `agent-${i}`;
}

/** Update the shell pane tab title to show the chat name. */
function updatePaneTitle(paneId: string, chatName: string): void {
  const pane = dashboardState.panes.find(p => p.id === paneId);
  if (!pane) return;
  pane.chatName = chatName;
  pane.title = `${pane.num}: ${chatName}`;
  // Notify shell page to update the tab (separate from terminal:cwd so CWD changes don't overwrite)
  getShellNsp()?.emit('state:pane-chat-name', { id: paneId, chatName });
}

/** Find an existing participant that can be reclaimed by projectId + paneId + model. */
function findReclaimCandidate(paneId: string | null, model: string | null): ChatParticipant | null {
  if (!paneId) return null;
  const pid = activeProjectId();
  for (const p of participants.values()) {
    if (p.paneId === paneId && p.model === model && p.projectId === pid) return p;
  }
  return null;
}

export function join(name: string, kind: 'user' | 'llm', paneId: string | null, model: string | null = null, submitKey: string = '\r'): ChatParticipant {
  const now = new Date().toISOString();

  // Claim-or-create: try to reclaim an existing participant by paneId + model
  const existing = findReclaimCandidate(paneId, model);
  if (existing) {
    // Reattach: keep the same alias, update session fields
    existing.detached = false;
    existing.submitKey = submitKey;
    existing.lastSeen = now;
    bumpParticipantSessionEpoch(existing.name);

    if (paneId) updatePaneTitle(paneId, existing.name);

    const msg = appendMessage({
      from: existing.name,
      to: null,
      body: `${existing.name} reconnected${paneId ? ` (${paneId})` : ''}`,
      type: 'join',
    });
    emitToProject('chat:join', existing);
    emitToProject('chat:message', msg);

    return existing;
  }

  // No reclaim candidate — create fresh alias
  const uniqueName = generateUniqueName();
  const participant: ChatParticipant = {
    name: uniqueName,
    kind,
    model,
    paneId,
    projectId: activeProjectId(),
    submitKey,
    joinedAt: now,
    lastSeen: now,
    detached: false,
  };
  participants.set(uniqueName, participant);
  bumpParticipantSessionEpoch(uniqueName);

  // Update the pane tab to show the chat name
  if (paneId) updatePaneTitle(paneId, uniqueName);

  const msg = appendMessage({
    from: uniqueName,
    to: null,
    body: `${uniqueName} joined${paneId ? ` (${paneId})` : ''}`,
    type: 'join',
  });
  emitToProject('chat:join', participant);
  emitToProject('chat:message', msg);

  return participant;
}

export function leave(name: string): boolean {
  const participant = participants.get(name);
  const pid = participant?.projectId ?? null;
  const removed = participants.delete(name);
  if (removed) {
    participantSessionEpochs.delete(name);
    const msg = appendMessage({
      from: name,
      to: null,
      body: `${name} left`,
      type: 'leave',
    });
    emitToProject('chat:leave', { name }, pid);
    emitToProject('chat:message', msg, pid);
  }
  return removed;
}

/** Mark a participant as detached (MCP session closed but pane still alive).
 *  The alias stays reserved so a subsequent join from the same pane + model reclaims it. */
export function detach(name: string): boolean {
  const participant = participants.get(name);
  if (!participant) return false;
  participant.detached = true;
  bumpParticipantSessionEpoch(name);
  emitToProject('chat:members', listParticipants());
  return true;
}

function pruneStaleParticipants(): void {
  for (const [name, participant] of participants) {
    if (participant.kind !== 'llm' || !participant.paneId) continue;
    if (globalPtys.has(participant.paneId)) continue;
    // Pane is gone — full removal regardless of detached state
    leave(name);
  }
}

export function send(from: string, body: string, to?: string): ChatMessage {
  pruneStaleParticipants();

  // Update lastSeen
  const sender = participants.get(from);
  if (sender) sender.lastSeen = new Date().toISOString();

  // Determine sender kind for routing rules
  const senderKind = sender?.kind ?? (from === 'user' ? 'user' : 'llm');

  // Resolve targets:
  // - User senders: explicit `to` takes priority, then body @mentions
  // - LLM senders: always extract @mentions from body (ignore `to` param)
  const targets = resolveTargets(from, body, to, senderKind);

  const msg = appendMessage({
    from,
    to: targets.length === 1 ? targets[0] : targets.length > 1 ? targets.join(',') : null,
    body,
    type: 'message',
  });

  // Emit to dashboard clients viewing this project only
  emitToProject('chat:message', msg);

  // PTY delivery — broadcast every message to all same-project participants except the sender.
  // `targets` remain semantic metadata for intent and UI display.
  const pid = activeProjectId();
  for (const [name, p] of participants) {
    if (name !== from && p.paneId && p.projectId === pid) {
      deliverToPty(name, msg);
    }
  }

  return msg;
}

/** Extract delivery targets from explicit `to` param or @mentions in message body.
 *  Only considers participants in the active project.
 *  For LLM senders: always extract @mentions from body (LLMs target via @mentions only).
 *  For user senders: explicit `to` takes priority, then body @mentions. */
function resolveTargets(from: string, body: string, to?: string, senderKind?: 'user' | 'llm'): string[] {
  const pid = activeProjectId();

  // Explicit `to` takes priority — but only for user senders.
  // LLM senders always resolve from body @mentions.
  if (to && senderKind !== 'llm') {
    const target = participants.get(to);
    return target && target.projectId === pid ? [to] : [];
  }

  // Scan body for all @mentions that match known participants in this project
  const mentions: string[] = [];
  const regex = /@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1];
    const p = participants.get(name);
    if (p && p.projectId === pid && name !== from && !mentions.includes(name)) {
      mentions.push(name);
    }
  }
  return mentions;
}

function deliverToPty(targetName: string, msg: ChatMessage): void {
  const target = participants.get(targetName);
  if (!target?.paneId || target.detached) return;

  const paneId = target.paneId;
  const sessionEpoch = currentParticipantSessionEpoch(targetName);
  const previous = paneDeliveryQueues.get(paneId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const liveTarget = participants.get(targetName);
      if (!liveTarget?.paneId || liveTarget.detached || liveTarget.paneId !== paneId || currentParticipantSessionEpoch(targetName) !== sessionEpoch) return;

      const entry = globalPtys.get(paneId);
      if (!entry) {
        // Pane closed — unlink but keep participant
        liveTarget.paneId = null;
        return;
      }

      const formatted = `[DevGlide Chat] @${msg.from}: ${msg.body}`;
      entry.ptyProcess.write(formatted);

      // Keep the delayed submit coupled to this specific injected message.
      await new Promise((resolve) => setTimeout(resolve, PTY_SUBMIT_DELAY_MS));

      const refreshed = participants.get(targetName);
      if (!refreshed?.paneId || refreshed.detached || refreshed.paneId !== paneId || currentParticipantSessionEpoch(targetName) !== sessionEpoch) return;

      const refreshedEntry = globalPtys.get(paneId);
      if (!refreshedEntry) {
        refreshed.paneId = null;
        return;
      }

      refreshedEntry.ptyProcess.write(refreshed.submitKey);

      // Retry submit after additional delay — sometimes the first CR is swallowed
      // by TUI frameworks (e.g. crossterm paste-burst detection).
      await new Promise((resolve) => setTimeout(resolve, PTY_RETRY_SUBMIT_DELAY_MS));

      const retryTarget = participants.get(targetName);
      if (!retryTarget?.paneId || retryTarget.detached || retryTarget.paneId !== paneId || currentParticipantSessionEpoch(targetName) !== sessionEpoch) return;

      const retryEntry = globalPtys.get(paneId);
      if (!retryEntry) {
        retryTarget.paneId = null;
        return;
      }

      retryEntry.ptyProcess.write(retryTarget.submitKey);
    })
    .finally(() => {
      if (paneDeliveryQueues.get(paneId) === next) {
        paneDeliveryQueues.delete(paneId);
      }
    });

  paneDeliveryQueues.set(paneId, next);
}

export function listParticipants(): ChatParticipant[] {
  pruneStaleParticipants();

  const pid = activeProjectId();
  const result: ChatParticipant[] = [];
  for (const p of participants.values()) {
    // Only return participants that belong to the active project
    if (p.projectId === pid) {
      result.push(p);
    }
  }
  return result;
}

export function getParticipant(name: string): ChatParticipant | undefined {
  return participants.get(name);
}

/** Clear chat history for the active project and notify dashboard clients. */
export function clearHistory(): void {
  clearMessages();
  emitToProject('chat:cleared', {});
}

/** Handle pane closure — remove participant and notify chat UI */
export function onPaneClosed(paneId: string): void {
  for (const [name, p] of participants) {
    if (p.paneId === paneId) {
      leave(name);
    }
  }
}
