import type { Namespace } from 'socket.io';
import type { ChatParticipant, ChatMessage, PipeMessageMeta } from '../types.js';
import { globalPtys, dashboardState, getShellNsp } from '../../shell/src/runtime/shell-state.js';
import { appendMessage, readMessages, clearMessages, saveParticipants, loadParticipants } from './chat-store.js';
import type { PersistedParticipant } from './chat-store.js';
import { getActiveProject, onProjectChange } from '../../../project-context.js';
import { isPipeCommand, parsePipeCommand, isPipeParseError } from './pipe-parser.js';
import * as pipeReducer from './pipe-reducer.js';
import * as pipeStore from './pipe-store.js';
import { stripAnsi } from './terminal-utils.js';

// In-memory participant registry
const participants = new Map<string, ChatParticipant>();
let chatNsp: Namespace | null = null;
const paneDeliveryQueues = new Map<string, Promise<void>>();
const participantSessionEpochs = new Map<string, number>();
const participantStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const panePromptWatchers = new Map<string, { dispose: () => void }>();

const PTY_SUBMIT_DELAY_MS = 1000;
const PARTICIPANT_IDLE_TIMEOUT_MS = 30_000;
const PROMPT_QUIESCENCE_MS = 2000;
const PANE_DISCONNECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes before auto-removal

const paneDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function bumpParticipantSessionEpoch(name: string, projectId?: string | null): number {
  const key = participantKey(name, projectId);
  const next = (participantSessionEpochs.get(key) ?? 0) + 1;
  participantSessionEpochs.set(key, next);
  return next;
}

function currentParticipantSessionEpoch(name: string, projectId?: string | null): number {
  return participantSessionEpochs.get(participantKey(name, projectId)) ?? 0;
}

function participantKey(name: string, projectId?: string | null): string {
  return `${projectId ?? '__none__'}:${name}`;
}

function getParticipantExact(name: string, projectId?: string | null): ChatParticipant | undefined {
  return participants.get(participantKey(name, projectId));
}

function activeProjectId(): string | null {
  return getActiveProject()?.id ?? null;
}

function resolveProjectId(projectId?: string | null): string | null {
  return projectId ?? activeProjectId();
}

function emitMembers(projectId?: string | null): void {
  emitToProject('chat:members', listParticipants(projectId), projectId);
}

function clearParticipantStatusTimer(name: string, projectId?: string | null): void {
  const key = participantKey(name, projectId);
  const timer = participantStatusTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    participantStatusTimers.delete(key);
  }
}

function setParticipantStatus(
  name: string,
  projectId: string | null,
  status: ChatParticipant['status'],
  resetIdleTimer = true,
): void {
  const participant = getParticipantExact(name, projectId);
  if (!participant || participant.kind !== 'llm') return;
  const changed = participant.status !== status;
  participant.status = status;
  if (resetIdleTimer) {
    clearParticipantStatusTimer(name, projectId);
    if (status !== 'idle') {
      const key = participantKey(name, projectId);
      participantStatusTimers.set(key, setTimeout(() => {
        participantStatusTimers.delete(key);
        const current = getParticipantExact(name, projectId);
        if (!current || current.kind !== 'llm') return;
        current.status = 'idle';
        emitMembers(projectId);
      }, PARTICIPANT_IDLE_TIMEOUT_MS));
    }
  }
  if (changed) emitMembers(projectId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markAssignedParticipantStatus(body: string, targetName: string): ChatParticipant['status'] | null {
  const lowered = body.toLowerCase();
  const targetMention = `@${targetName.toLowerCase()}`;
  const reviewTerms = '(verify|verification|review|check|inspect|validate|confirm|test)';
  const reviewRe = new RegExp(`(${escapeRegExp(targetMention)}\\b[^\\n]{0,120}\\b${reviewTerms}\\b|\\b${reviewTerms}\\b[^\\n]{0,120}${escapeRegExp(targetMention)}\\b)`, 'i');
  if (reviewRe.test(lowered)) return 'working';

  const workTerms = '(fix|handle|implement|patch|update|investigate|look\\s+into|take|pick\\s+up|work\\s+on|resolve|debug)';
  const workRe = new RegExp(`(${escapeRegExp(targetMention)}\\b[^\\n]{0,120}\\b${workTerms}\\b|\\b${workTerms}\\b[^\\n]{0,120}${escapeRegExp(targetMention)}\\b)`, 'i');
  return workRe.test(lowered) ? 'working' : null;
}


// ── PTY activity & prompt detection ───────────────────────────────────────
// Watches linked pane output for:
// 1. Nontrivial output → set 'working' (with inactivity timer → 'idle')
// 2. Known prompt patterns (y/n, tool approval) → hold 'working' (cancel idle timer)
// 3. New nontrivial output after prompt → clear prompt flag, resume normal idle cycle
//
// Prompt detection uses a delta buffer (output since last quiescence check)
// rather than the full scrollback tail, preventing stale prompts from
// re-triggering after the user has already responded.

/** Returns true if text contains printable (non-whitespace) characters after ANSI stripping. */
function hasNontrivialContent(rawData: string): boolean {
  const stripped = stripAnsi(rawData);
  return /\S/.test(stripped);
}

function hasNontrivialText(text: string): boolean {
  return /\S/.test(text);
}

function isChatInjectedOutput(text: string): boolean {
  return /^\[DevGlide Chat\] @\S+:/m.test(text.trim());
}

const AWAITING_USER_PATTERNS: RegExp[] = [
  // Claude Code tool permission prompts
  /Allow\s+(?:Read|Edit|Write|Bash|MultiEdit|NotebookEdit|Glob|Grep|WebFetch|WebSearch|Agent|Skill|mcp_+[\w-]+)/i,
  // "wants to use/run" phrasing (Claude Code, similar tools)
  /wants to (?:use|read|edit|write|run|execute|create|delete)\b/i,
  // Generic yes/no confirmation at end of line
  /\(y\/n\)\s*$/m,
  /\[y\/n\]\s*$/im,
  /\[yes\/no\]\s*$/im,
  // Press to continue
  /press (?:enter|any key|y) to (?:continue|proceed|confirm)/i,
  // Generic approval / permission prompts
  /\b(?:approval|permission)\b.{0,80}\b(?:required|needed|requested)\b/i,
  /\b(?:approve|allow|confirm)\b.{0,80}\b(?:tool|command|action|request)\b/i,
];

function matchesPromptPattern(text: string): boolean {
  return AWAITING_USER_PATTERNS.some(re => re.test(text));
}

const PTY_WORKING_IDLE_TIMEOUT_MS = 8000;

function startPanePromptWatcher(name: string, projectId: string | null, paneId: string): void {
  const key = participantKey(name, projectId);
  stopPanePromptWatcher(key);

  const entry = globalPtys.get(paneId);
  if (!entry?.ptyProcess?.onData) return;

  let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let promptVisible = false;
  // Delta buffer: collects output since the last quiescence check,
  // so prompt detection only scans recent output, not stale history.
  let deltaBuffer = '';

  const disposable = entry.ptyProcess.onData((data: string) => {
    deltaBuffer += data;
    const participant = getParticipantExact(name, projectId);

    // PTY-driven working: nontrivial output → set working
    if (hasNontrivialContent(data)) {
      if (participant && participant.kind === 'llm' && !participant.detached) {
        setParticipantStatus(name, projectId, 'working', false);
        // Reset inactivity timer → idle (unless a prompt is holding working)
        if (idleTimer) clearTimeout(idleTimer);
        if (!promptVisible) {
          idleTimer = setTimeout(() => {
            idleTimer = null;
            const p = getParticipantExact(name, projectId);
            if (p && p.kind === 'llm' && p.status === 'working') {
              setParticipantStatus(name, projectId, 'idle');
            }
          }, PTY_WORKING_IDLE_TIMEOUT_MS);
        }
      }
    }

    // Debounce: check for prompt pattern after output settles
    if (quiescenceTimer) clearTimeout(quiescenceTimer);
    quiescenceTimer = setTimeout(() => {
      quiescenceTimer = null;
      const participant = getParticipantExact(name, projectId);
      if (!participant || participant.kind !== 'llm' || participant.detached) return;

      // Scan only the delta buffer (output since last check), not full scrollback
      const stripped = stripAnsi(deltaBuffer);
      deltaBuffer = '';

      if (matchesPromptPattern(stripped)) {
        // Prompt detected → hold working, cancel idle timer
        promptVisible = true;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        setParticipantStatus(name, projectId, 'working', false);
        return;
      }

      if (promptVisible) {
        // New output after prompt — if nontrivial and not chat-injected, prompt was answered
        if (!hasNontrivialText(stripped) || isChatInjectedOutput(stripped)) return;

        promptVisible = false;
        setParticipantStatus(name, projectId, 'working', false);
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          const p = getParticipantExact(name, projectId);
          if (p && p.kind === 'llm' && p.status === 'working') {
            setParticipantStatus(name, projectId, 'idle');
          }
        }, PTY_WORKING_IDLE_TIMEOUT_MS);
        return;
      }

      // No prompt, no special state — let the idle timer run its course
    }, PROMPT_QUIESCENCE_MS);
  });

  panePromptWatchers.set(key, {
    dispose: () => {
      disposable.dispose();
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  });
}

function stopPanePromptWatcher(key: string): void {
  const watcher = panePromptWatchers.get(key);
  if (watcher) {
    watcher.dispose();
    panePromptWatchers.delete(key);
  }
}

// ── Participant persistence ──────────────────────────────────────────────────

/** Persist current LLM participants to disk for a given project. */
function persistParticipantsForProject(projectId: string | null): void {
  if (!projectId) return;
  const llmParticipants: PersistedParticipant[] = [];
  for (const p of participants.values()) {
    if (p.kind !== 'llm' || p.projectId !== projectId) continue;
    llmParticipants.push({
      name: p.name,
      model: p.model,
      paneId: p.paneId,
      projectId: p.projectId,
      submitKey: p.submitKey,
      joinedAt: p.joinedAt,
      lastSeen: p.lastSeen,
      permissionMode: p.permissionMode,
    });
  }
  saveParticipants(llmParticipants, projectId);
}

/** Restore participants from disk after server restart.
 *  Only reattaches participants whose pane still exists and matches exactly.
 *  Returns arrays of restored and failed participants. */
export function restoreParticipants(projectId: string | null): { restored: string[]; failed: string[] } {
  if (!projectId) return { restored: [], failed: [] };
  const persisted = loadParticipants(projectId);
  if (persisted.length === 0) return { restored: [], failed: [] };

  const restored: string[] = [];
  const failed: string[] = [];

  for (const p of persisted) {
    // Only reattach if pane + project match exactly
    if (!p.paneId || !globalPtys.has(p.paneId)) {
      failed.push(p.name);
      continue;
    }

    // Check the pane still belongs to this project
    const paneInfo = dashboardState.panes.find(d => d.id === p.paneId);
    if (paneInfo?.projectId && p.projectId && paneInfo.projectId !== p.projectId) {
      failed.push(p.name);
      continue;
    }

    // Reattach — create participant in detached state, ready for reclaim
    const key = participantKey(p.name, p.projectId);
    if (participants.has(key)) continue; // already exists (shouldn't happen after restart)

    const participant: ChatParticipant = {
      name: p.name,
      kind: 'llm',
      model: p.model,
      paneId: p.paneId,
      paneNum: getPaneDisplayNumber(p.paneId),
      projectId: p.projectId,
      submitKey: p.submitKey,
      joinedAt: p.joinedAt,
      lastSeen: new Date().toISOString(),
      detached: true, // detached until the MCP session reclaims
      status: 'idle',
      permissionMode: p.permissionMode ?? paneInfo?.permissionMode ?? 'supervised',
    };
    participants.set(key, participant);
    bumpParticipantSessionEpoch(p.name, p.projectId);
    restored.push(p.name);
  }

  // Do NOT persist here — failed entries should stay in the file so they
  // remain available for manual rejoin. They will be removed when the
  // participant explicitly leaves or the disconnect timeout fires.

  return { restored, failed };
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
onProjectChange((project) => {
  emitMembers(project?.id);
});

export function getChatNsp(): Namespace | null {
  return chatNsp;
}

// ── Identity-based name assignment ──────────────────────────────────────────
// Names are derived from hint (the `name` param from chat_join) + the numeric
// suffix from the pane ID (e.g. "claude-5" for pane-5, "codex-4" for pane-4).
// The `hint` is preferred over `model` so that agents with a stable identity
// label (like "codex") keep that label regardless of which backend model they
// report.

/** Extract the numeric suffix from the pane ID (e.g. "pane-5" → 5). */
function getPaneDisplayNumber(paneId: string | null): number | null {
  if (!paneId) return null;
  const match = paneId.match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Normalize the identity base from hint/model (e.g. "claude", "codex"). */
function deriveNameBase(hint: string, model: string | null): string {
  return (hint || model || 'agent').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/** Derive a name from hint/model + pane display number (e.g. "claude-1"). */
function deriveUniqueName(hint: string, model: string | null, paneId: string | null, projectId: string | null): string {
  // Prefer hint (the name param from chat_join) over model — this ensures
  // agents like "codex" keep a stable identity even if model varies.
  const base = deriveNameBase(hint, model);
  const paneNum = getPaneDisplayNumber(paneId);

  // Use model-paneNumber format (e.g. "claude-1")
  const name = paneNum ? `${base}-${paneNum}` : base;

  // If somehow still taken within this project, append a sequential suffix
  const usedNames = new Set(
    [...participants.values()]
      .filter((p) => p.projectId === projectId)
      .map((p) => p.name)
  );
  if (!usedNames.has(name)) return name;

  let i = 1;
  while (usedNames.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}

/** Update the shell pane tab title to show the chat name. */
function permissionModeLabel(mode?: string | null): string {
  if (!mode || mode === 'supervised') return '';
  return mode === 'auto-accept' ? ' [AUTO]' : ' [UNRESTRICTED]';
}

function updatePaneTitle(paneId: string, chatName: string): void {
  const pane = dashboardState.panes.find(p => p.id === paneId);
  if (!pane) return;
  pane.chatName = chatName;
  const modeLabel = permissionModeLabel(pane.permissionMode);
  pane.title = `${pane.num}: ${chatName}${modeLabel}`;
  // Notify shell page to update the tab (separate from terminal:cwd so CWD changes don't overwrite)
  getShellNsp()?.emit('state:pane-chat-name', { id: paneId, chatName: `${chatName}${modeLabel}` });
}

/** Find an existing participant that can be reclaimed by projectId + paneId + identity.
 *  The pane is the stable anchor, and the name base (e.g. "claude", "codex") must match
 *  the existing participant's name prefix so a different agent on the same pane won't
 *  steal the wrong alias. */
function findReclaimCandidate(paneId: string | null, nameBase: string, projectId: string | null): ChatParticipant | null {
  if (!paneId) return null;
  for (const p of participants.values()) {
    if (p.paneId === paneId && p.projectId === projectId && (p.name === nameBase || p.name.startsWith(`${nameBase}-`))) return p;
  }
  return null;
}

export function join(
  name: string,
  kind: 'user' | 'llm',
  paneId: string | null,
  model: string | null = null,
  submitKey: string = '\r',
  projectId?: string | null,
): ChatParticipant {
  const now = new Date().toISOString();
  const resolvedProjectId = resolveProjectId(projectId);

  // Claim-or-create: try to reclaim an existing participant by paneId + identity
  const nameBase = deriveNameBase(name, model);
  const existing = findReclaimCandidate(paneId, nameBase, resolvedProjectId);
  if (existing) {
    // Reattach: keep the same alias, update session fields
    existing.detached = false;
    existing.paneId = paneId;
    existing.paneNum = getPaneDisplayNumber(paneId);
    existing.model = model; // refresh — model may vary between sessions
    existing.submitKey = submitKey;
    existing.lastSeen = now;
    existing.status = 'idle';
    const reclaimPane = paneId ? dashboardState.panes.find(p => p.id === paneId) : null;
    existing.permissionMode = reclaimPane?.permissionMode ?? existing.permissionMode ?? 'supervised';
    clearParticipantStatusTimer(existing.name, resolvedProjectId);
    bumpParticipantSessionEpoch(existing.name, resolvedProjectId);
    // Cancel any pending auto-removal timer
    const disconnectKey = participantKey(existing.name, resolvedProjectId);
    const disconnectTimer = paneDisconnectTimers.get(disconnectKey);
    if (disconnectTimer) { clearTimeout(disconnectTimer); paneDisconnectTimers.delete(disconnectKey); }

    if (paneId) updatePaneTitle(paneId, existing.name);

    const msg = appendMessage({
      from: existing.name,
      to: null,
      body: `${existing.name} reconnected${paneId ? ` (${paneId})` : ''}`,
      type: 'join',
    }, existing.projectId);
    emitToProject('chat:join', existing, existing.projectId);
    emitToProject('chat:message', msg, existing.projectId);
    emitMembers(existing.projectId);

    if (paneId) startPanePromptWatcher(existing.name, existing.projectId, paneId);
    persistParticipantsForProject(existing.projectId);

    return existing;
  }

  // No reclaim candidate — derive name from model/identity
  const uniqueName = deriveUniqueName(name, model, paneId, resolvedProjectId);
  const paneInfo = paneId ? dashboardState.panes.find(p => p.id === paneId) : null;
  const participant: ChatParticipant = {
    name: uniqueName,
    kind,
    model,
    paneId,
    paneNum: getPaneDisplayNumber(paneId),
    projectId: resolvedProjectId,
    submitKey,
    joinedAt: now,
    lastSeen: now,
    status: kind === 'llm' ? 'idle' : undefined,
    detached: false,
    permissionMode: paneInfo?.permissionMode ?? 'supervised',
  };
  participants.set(participantKey(uniqueName, resolvedProjectId), participant);
  bumpParticipantSessionEpoch(uniqueName, resolvedProjectId);

  // Update the pane tab to show the chat name
  if (paneId) updatePaneTitle(paneId, uniqueName);

  const msg = appendMessage({
    from: uniqueName,
    to: null,
    body: `${uniqueName} joined${paneId ? ` (${paneId})` : ''}`,
    type: 'join',
  }, participant.projectId);
  emitToProject('chat:join', participant, participant.projectId);
  emitToProject('chat:message', msg, participant.projectId);
  emitMembers(participant.projectId);

  if (paneId) startPanePromptWatcher(uniqueName, participant.projectId, paneId);
  persistParticipantsForProject(participant.projectId);

  return participant;
}

export function leave(name: string, projectId?: string | null): boolean {
  const participant = projectId !== undefined
    ? getParticipantExact(name, projectId)
    : getParticipant(name);
  if (!participant) return false;
  const pid = participant.projectId;
  const removed = participants.delete(participantKey(name, pid));
  if (removed) {
    const key = participantKey(name, pid);
    clearParticipantStatusTimer(name, pid);
    stopPanePromptWatcher(key);
    participantSessionEpochs.delete(key);
    const disconnectTimer = paneDisconnectTimers.get(key);
    if (disconnectTimer) { clearTimeout(disconnectTimer); paneDisconnectTimers.delete(key); }
    const msg = appendMessage({
      from: name,
      to: null,
      body: `${name} left`,
      type: 'leave',
    }, pid);
    emitToProject('chat:leave', { name }, pid);
    emitToProject('chat:message', msg, pid);
    emitMembers(pid);
    persistParticipantsForProject(pid);

    // Fail-fast: cancel any running pipes this participant is in
    failPipesForParticipant(name, pid, 'left');
  }
  return removed;
}

/** Mark a participant as detached (MCP session closed but pane still alive).
 *  The alias stays reserved so a subsequent join from the same pane + model reclaims it. */
export function detach(name: string, projectId?: string | null): boolean {
  const participant = projectId !== undefined
    ? getParticipantExact(name, projectId)
    : getParticipant(name);
  if (!participant) return false;
  participant.detached = true;
  clearParticipantStatusTimer(name, participant.projectId);
  stopPanePromptWatcher(participantKey(name, participant.projectId));
  bumpParticipantSessionEpoch(name, participant.projectId);
  emitMembers(participant.projectId);

  // Fail-fast: cancel any running pipes this participant is in
  failPipesForParticipant(name, participant.projectId, 'detached');
  return true;
}

function pruneStaleParticipants(): void {
  for (const participant of [...participants.values()]) {
    if (participant.kind !== 'llm' || !participant.paneId) continue;
    if (globalPtys.has(participant.paneId)) continue;
    // Pane is gone — detach gracefully instead of removing
    disconnectParticipant(participant.name, participant.projectId, 'pane disappeared');
  }
}

/** Gracefully disconnect a participant: unlink pane, keep in registry, start auto-removal timer. */
function disconnectParticipant(name: string, projectId: string | null, reason: string): void {
  const participant = getParticipantExact(name, projectId);
  if (!participant) return;

  participant.paneId = null;
  participant.detached = true;
  clearParticipantStatusTimer(name, projectId);
  stopPanePromptWatcher(participantKey(name, projectId));
  bumpParticipantSessionEpoch(name, projectId);
  emitMembers(projectId);
  persistParticipantsForProject(projectId);

  // Fail-fast: cancel any running pipes this participant is in
  const pipeReason = reason === 'pane closed' ? 'pane-closed' : 'detached';
  failPipesForParticipant(name, projectId, pipeReason as 'left' | 'detached' | 'pane-closed');

  // Start auto-removal timer — if not reclaimed within timeout, fully remove
  const key = participantKey(name, projectId);
  const existing = paneDisconnectTimers.get(key);
  if (existing) clearTimeout(existing);
  paneDisconnectTimers.set(key, setTimeout(() => {
    paneDisconnectTimers.delete(key);
    const p = getParticipantExact(name, projectId);
    if (p && p.detached) {
      leave(name, projectId);
    }
  }, PANE_DISCONNECT_TIMEOUT_MS));
}

export async function send(from: string, body: string, to?: string, projectId?: string | null): Promise<ChatMessage> {
  pruneStaleParticipants();

  // Update lastSeen — use project-scoped lookup when available
  const resolvedPid = resolveProjectId(projectId);
  const sender = resolvedPid ? getParticipantExact(from, resolvedPid) : getParticipant(from);
  if (sender) sender.lastSeen = new Date().toISOString();

  // Determine sender kind for routing rules
  const senderKind = sender?.kind ?? (from === 'user' ? 'user' : 'llm');

  // Use the sender's project — NOT the global active project.
  // For dashboard/user sends (no participant record), fall back to activeProjectId().
  const senderProjectId = sender?.projectId ?? activeProjectId();
  const resolvedSenderProjectId = resolveProjectId(senderProjectId);

  // ─── Pipe command detection (user-only) ────────────────────────────
  if (from === 'user' && isPipeCommand(body)) {
    return handlePipeCommand(body, resolvedSenderProjectId);
  }

  // ─── Pipe response detection (LLM-only, log-centric) ──────────────
  // For store-tracked pipes, chat_send is NEVER treated as a pipe response.
  // Participants must use pipe_submit for store-tracked pipes.
  let pipeMeta: PipeMessageMeta | undefined;
  if (from !== 'system' && from !== 'user' && resolvedSenderProjectId) {
    pipeMeta = detectPipeResponse(from, body, resolvedSenderProjectId);
    // If the detected pipe is tracked in the store, suppress auto-detection.
    // This prevents regular chat from being classified as pipe output.
    if (pipeMeta && pipeStore.getPipe(pipeMeta.pipeId, resolvedSenderProjectId)) {
      pipeMeta = undefined;
    }
    // Ensure #pipe-{id} anchor is always in the stored body for searchability
    if (pipeMeta && !body.includes(`#pipe-${pipeMeta.pipeId}`)) {
      body = `#pipe-${pipeMeta.pipeId} ${body}`;
    }
  }

  // Resolve targets:
  // - User senders: explicit `to` takes priority, then body @mentions
  // - LLM senders: always extract @mentions from body (ignore `to` param)
  const targets = resolveTargets(from, body, to, senderKind, resolvedSenderProjectId);

  if (sender?.kind === 'llm' && sender.projectId === resolvedSenderProjectId && sender.status && sender.status !== 'idle') {
    setParticipantStatus(sender.name, resolvedSenderProjectId, sender.status);
  }
  if (senderKind === 'user') {
    for (const targetName of targets) {
      const status = markAssignedParticipantStatus(body, targetName);
      if (status) setParticipantStatus(targetName, resolvedSenderProjectId, status);
    }
  }

  const msg = appendMessage({
    from,
    to: targets.length === 1 ? targets[0] : targets.length > 1 ? targets.join(',') : null,
    body,
    type: 'message',
    ...(pipeMeta ? { pipe: pipeMeta } : {}),
  }, resolvedSenderProjectId);

  // Emit to dashboard clients viewing this project only
  emitToProject('chat:message', msg, resolvedSenderProjectId);

  // PTY delivery — broadcast every message to all same-project participants except the sender.
  // `targets` remain semantic metadata for intent and UI display.
  for (const p of participants.values()) {
    if (p.name !== from && p.paneId && p.projectId === resolvedSenderProjectId) {
      await deliverToPty(p.name, resolvedSenderProjectId, msg);
    }
  }

  // ─── Pipe reducer: check if this message triggers next step ────────
  // NOTE: pipeMeta is only set for legacy pipes NOT tracked in the store.
  // Store-tracked pipes are suppressed above — they require pipe_submit.
  if (pipeMeta) {
    runPipeReducer(pipeMeta.pipeId, resolvedSenderProjectId)
      .catch(err => console.error('[pipe] reducer failed:', err));
  }

  return msg;
}

/** Extract delivery targets from explicit `to` param or @mentions in message body.
 *  Only considers participants in the active project.
 *  For LLM senders: always extract @mentions from body (LLMs target via @mentions only).
 *  For user senders: explicit `to` takes priority, then body @mentions. */
function resolveTargets(from: string, body: string, to?: string, senderKind?: 'user' | 'llm', projectId?: string | null): string[] {
  const pid = resolveProjectId(projectId);

  // Explicit `to` takes priority — but only for user senders.
  // LLM senders always resolve from body @mentions.
  if (to && senderKind !== 'llm') {
    const target = getParticipantExact(to, pid);
    return target && target.projectId === pid ? [to] : [];
  }

  // Scan body for all @mentions that match known participants in this project
  const mentions: string[] = [];
  const regex = /@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1];
    const p = getParticipantExact(name, pid);
    if (p && p.projectId === pid && name !== from && !mentions.includes(name)) {
      mentions.push(name);
    }
  }
  return mentions;
}

function deliverToPty(targetName: string, projectId: string | null, msg: ChatMessage): Promise<void> {
  const target = getParticipantExact(targetName, projectId);
  if (!target?.paneId || target.detached) {
    return Promise.resolve();
  }

  const paneId = target.paneId;
  const sessionEpoch = currentParticipantSessionEpoch(targetName, projectId);
  const previous = paneDeliveryQueues.get(paneId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const liveTarget = getParticipantExact(targetName, projectId);
      if (!liveTarget?.paneId || liveTarget.detached || liveTarget.paneId !== paneId || currentParticipantSessionEpoch(targetName, projectId) !== sessionEpoch) {
        return;
      }

      const entry = globalPtys.get(paneId);
      if (!entry) {
        disconnectParticipant(targetName, projectId, 'pane disappeared during delivery');
        return;
      }

      const formatted = `[DevGlide Chat] @${msg.from}: ${msg.body}`;

      entry.ptyProcess.write(formatted);

      await new Promise((resolve) => setTimeout(resolve, PTY_SUBMIT_DELAY_MS));

      const refreshed = getParticipantExact(targetName, projectId);
      if (!refreshed?.paneId || refreshed.detached || refreshed.paneId !== paneId || currentParticipantSessionEpoch(targetName, projectId) !== sessionEpoch) {
        return;
      }

      const refreshedEntry = globalPtys.get(paneId);
      if (!refreshedEntry) {
        disconnectParticipant(targetName, projectId, 'pane disappeared before submit');
        return;
      }

      refreshedEntry.ptyProcess.write(refreshed.submitKey);
    })
    .finally(() => {
      if (paneDeliveryQueues.get(paneId) === next) {
        paneDeliveryQueues.delete(paneId);
      }
    });

  paneDeliveryQueues.set(paneId, next);
  return next;
}

export function listParticipants(projectId?: string | null): ChatParticipant[] {
  pruneStaleParticipants();

  const pid = resolveProjectId(projectId);
  const result: ChatParticipant[] = [];
  for (const p of participants.values()) {
    // Only return participants that belong to the active project
    if (p.projectId === pid) {
      result.push(p);
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function getParticipant(name: string, projectId?: string | null): ChatParticipant | undefined {
  // Exact lookup when projectId is provided
  if (projectId !== undefined) return getParticipantExact(name, projectId);
  // Fallback: scan by name, prefer active project if ambiguous
  const matches = [...participants.values()].filter((p) => p.name === name);
  if (matches.length <= 1) return matches[0];
  const pid = activeProjectId();
  return matches.find((p) => p.projectId === pid) ?? matches[0];
}

export function getParticipantByPaneId(paneId: string, projectId?: string | null): ChatParticipant | undefined {
  pruneStaleParticipants();

  if (projectId !== undefined) {
    for (const participant of participants.values()) {
      if (participant.paneId === paneId && participant.projectId === projectId) return participant;
    }
    return undefined;
  }

  const matches = [...participants.values()].filter((participant) => participant.paneId === paneId);
  if (matches.length <= 1) return matches[0];
  const pid = activeProjectId();
  return matches.find((participant) => participant.projectId === pid) ?? matches[0];
}

/** Clear chat history for the active project and notify dashboard clients. */
export function clearHistory(projectId?: string | null): void {
  const pid = resolveProjectId(projectId);
  clearMessages(pid);
  emitToProject('chat:cleared', {}, pid);
}

/** Handle pane closure — gracefully disconnect participants linked to this pane.
 *  Participants are detached (not removed) so they can reclaim within the timeout window.
 *  Scoped by projectId to avoid affecting participants from other projects. */
export function onPaneClosed(paneId: string, projectId?: string | null): void {
  for (const p of [...participants.values()]) {
    if (p.paneId === paneId && (projectId == null || p.projectId === projectId)) {
      disconnectParticipant(p.name, p.projectId, 'pane closed');
    }
  }
}


// ── Pipe orchestration (log-centric reducer model) ───────────────────────────

async function handlePipeCommand(body: string, projectId: string | null): Promise<ChatMessage> {
  const parsed = parsePipeCommand(body);
  if (isPipeParseError(parsed)) {
    const userMsg = appendMessage({ from: 'user', to: null, body, type: 'message' }, projectId);
    emitToProject('chat:message', userMsg, projectId);
    const errorMsg = appendMessage({
      from: 'system', to: null,
      body: `Pipe error: ${parsed.error}`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', errorMsg, projectId);
    return userMsg;
  }

  // Store command (not PTY-delivered)
  const userMsg = appendMessage({ from: 'user', to: null, body, type: 'message' }, projectId);
  emitToProject('chat:message', userMsg, projectId);

  // Validate all assignees are connected, live LLM participants
  const invalid: string[] = [];
  const reasons: string[] = [];
  for (const a of parsed.assignees) {
    const p = getParticipantExact(a, projectId);
    if (!p) { invalid.push(a); reasons.push(`@${a} not found`); continue; }
    if (p.kind !== 'llm') { invalid.push(a); reasons.push(`@${a} is not an LLM`); continue; }
    if (p.detached) { invalid.push(a); reasons.push(`@${a} is detached`); continue; }
    if (!p.paneId) { invalid.push(a); reasons.push(`@${a} has no pane`); continue; }
  }
  if (invalid.length > 0) {
    const errorMsg = appendMessage({
      from: 'system', to: null,
      body: `Pipe error: invalid assignees (${reasons.join('; ')}). All assignees must be connected LLM participants with a live pane.`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', errorMsg, projectId);
    return userMsg;
  }

  // Write start message to log with pipe metadata
  const pipeId = pipeReducer.generatePipeId();
  const desc = pipeReducer.getStartDescription(parsed);

  // Create pipe in the isolated stage store
  pipeStore.createPipe(pipeId, parsed.mode, parsed.assignees, parsed.prompt, projectId);

  const startMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${pipeId} Pipe started (${parsed.mode}): ${desc}`,
    type: 'system',
    pipe: {
      pipeId,
      mode: parsed.mode,
      role: 'start',
      assignees: parsed.assignees,
      prompt: parsed.prompt,
    },
  }, projectId);
  emitToProject('chat:message', startMsg, projectId);
  emitToProject('chat:pipe', { type: 'start', pipeId, mode: parsed.mode }, projectId);

  // Run reducer to emit initial handoff/fan-out
  await runPipeReducer(pipeId, projectId);

  return userMsg;
}

/** Detect if an LLM message is a response to an active pipe.
 *  Uses #pipe-{id} in the body as primary discriminator; falls back to
 *  most-recently-prompted pipe if no explicit tag is present. */
function detectPipeResponse(from: string, body: string, projectId: string | null): PipeMessageMeta | undefined {
  const messages = readMessages({ limit: 10000 }, projectId);

  // Collect all pipe IDs from log
  const pipeIds = new Set<string>();
  for (const msg of messages) {
    if (msg.pipe?.pipeId) pipeIds.add(msg.pipe.pipeId);
  }
  if (pipeIds.size === 0) return undefined;

  // Primary: check if body explicitly references #pipe-{id}
  const explicitMatch = body.match(/#pipe-([a-f0-9]+)/);
  if (explicitMatch && pipeIds.has(explicitMatch[1])) {
    const state = pipeReducer.derivePipeState(messages, explicitMatch[1]);
    if (state) {
      const meta = pipeReducer.matchResponse(state, from);
      if (meta) return meta;
    }
  }

  // Fallback: find the most recently prompted pipe for this sender
  // (scan messages in reverse to find last handoff/fan-out-request/synth-request targeting this sender)
  let lastPromptedPipeId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.pipe) continue;
    const role = msg.pipe.role;
    if (
      msg.pipe.targetAssignee === from &&
      (role === 'handoff' || role === 'fan-out-request' || role === 'synth-request')
    ) {
      lastPromptedPipeId = msg.pipe.pipeId;
      break;
    }
  }

  if (lastPromptedPipeId) {
    const state = pipeReducer.derivePipeState(messages, lastPromptedPipeId);
    if (state) {
      const meta = pipeReducer.matchResponse(state, from);
      if (meta) return meta;
    }
  }

  return undefined;
}

/** Run the pipe reducer: scan log, compute next actions, execute them.
 *  Stage outputs are read from the pipe store (source of truth), merged into
 *  the log-derived state so the reducer's action computation uses store data. */
async function runPipeReducer(pipeId: string, projectId: string | null): Promise<void> {
  // Read only messages for this pipe instead of scanning full history
  const messages = readMessages({ limit: 10000, pipeId }, projectId);
  const state = pipeReducer.derivePipeState(messages, pipeId);
  if (!state) return;

  // When the pipe is tracked in the store, the store is the SOLE source of truth
  // for stage content — clear log-derived outputs and use only store data.
  // This prevents regular chat messages from ever becoming stage input.
  const storedPipe = pipeStore.getPipe(pipeId, projectId);
  if (storedPipe) {
    state.stageOutputs.clear();
    state.fanOutOutputs.clear();
    for (const [assignee, slotList] of storedPipe.slots) {
      for (const slot of slotList) {
        if (slot.status === 'submitted' && slot.content) {
          if (slot.stage !== undefined) {
            state.stageOutputs.set(slot.stage, { from: assignee, body: slot.content });
          }
          if (slot.role === 'fan-out') {
            state.fanOutOutputs.set(assignee, slot.content);
          }
        }
      }
    }
  }

  // Check for completion
  if (state.hasFinal) {
    pipeStore.markPipeStatus(pipeId, 'completed', projectId);
    const completeMsg = appendMessage({
      from: 'system', to: null,
      body: `#pipe-${pipeId} Pipe completed.`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', completeMsg, projectId);
    emitToProject('chat:pipe', { type: 'complete', pipeId }, projectId);
    return;
  }

  const actions = pipeReducer.computeNextActions(state);
  for (const action of actions) {
    // Grant lease to target assignee in the store
    if (storedPipe) {
      const leaseResult = pipeStore.grantLease(pipeId, action.targetAssignee, projectId);
      if (!leaseResult.ok) {
        // Participant has a lease for another pipe — queue this pipe for retry
        // when the conflicting lease is released. Do NOT deliver the handoff.
        pipeStore.addPendingPipe(action.targetAssignee, projectId, pipeId);

        // Emit a visible diagnostic so users/agents know the pipe is queued
        const diagMsg = appendMessage({
          from: 'system', to: null,
          body: `#pipe-${pipeId} Stage for @${action.targetAssignee} is queued: ${leaseResult.error}`,
          type: 'system',
          pipe: {
            pipeId,
            mode: storedPipe.mode,
            role: 'lease-queued' as any,
            targetAssignee: action.targetAssignee,
          },
        }, projectId);
        emitToProject('chat:message', diagMsg, projectId);
        continue;
      }
    }

    // Store the delivery in log with pipe metadata
    const deliveryMsg = appendMessage({
      from: 'system',
      to: action.targetAssignee,
      body: action.body,
      type: 'system',
      pipe: action.pipe,
    }, projectId);

    // Emit status to dashboard
    emitToProject('chat:message', deliveryMsg, projectId);

    // PTY deliver only to the target assignee
    const target = getParticipantExact(action.targetAssignee, projectId);
    if (target?.paneId && !target.detached) {
      await deliverToPty(action.targetAssignee, projectId, deliveryMsg);
    }
  }
}

/** Drain pending pipe queues for a list of assignees whose leases were just released.
 *  Re-runs the reducer for each blocked pipe so handoffs can be retried. */
function drainPendingPipes(assignees: string[], projectId: string | null): void {
  for (const assignee of assignees) {
    const pendingPipeIds = pipeStore.popPendingPipes(assignee, projectId);
    for (const pendingPipeId of pendingPipeIds) {
      runPipeReducer(pendingPipeId, projectId)
        .catch(err => console.error('[pipe] pending reducer failed:', err));
    }
  }
}

/** Fail-fast: cancel running pipes when a participant becomes unavailable. */
function failPipesForParticipant(
  name: string,
  projectId: string | null,
  reason: 'left' | 'detached' | 'pane-closed',
): void {
  // Use the active pipe index for O(1) lookup instead of scanning full history
  const activePipeIds = pipeStore.getActivePipesForParticipant(name, projectId);

  for (const pipeId of activePipeIds) {
    // Idempotency: check pipe is still running in the store
    const storedPipe = pipeStore.getPipe(pipeId, projectId);
    if (!storedPipe || storedPipe.status !== 'running') continue;

    // Derive state from log for the mode info needed by system messages
    const state = pipeReducer.derivePipeState(
      readMessages({ limit: 10000, pipeId }, projectId), pipeId,
    );
    if (!state || state.status !== 'running') continue;

    // Append assignee-unavailable
    appendMessage({
      from: 'system', to: null,
      body: `#pipe-${pipeId} @${name} became unavailable (${reason}).`,
      type: 'system',
      pipe: {
        pipeId,
        mode: state.mode,
        role: 'assignee-unavailable',
        targetAssignee: name,
        reason,
      },
    }, projectId);

    // Update store — releases leases for this pipe's assignees
    const releasedAssignees = pipeStore.markPipeStatus(pipeId, 'failed', projectId);

    // Append failed
    const failMsg = appendMessage({
      from: 'system', to: null,
      body: `#pipe-${pipeId} Pipe stopped: @${name} became unavailable.`,
      type: 'system',
      pipe: {
        pipeId,
        mode: state.mode,
        role: 'failed',
        reason,
      },
    }, projectId);
    emitToProject('chat:message', failMsg, projectId);
    emitToProject('chat:pipe', { type: 'failed', pipeId }, projectId);

    // Drain pending queues for released assignees — unblock any pipes waiting for their lease
    drainPendingPipes(releasedAssignees, projectId);
  }
}

/** Cancel a running pipe by user request. */
export async function cancelPipeRun(pipeId: string, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const messages = readMessages({ limit: 10000 }, pid);
  const state = pipeReducer.derivePipeState(messages, pipeId);
  if (!state || state.status !== 'running') return false;

  // Update store — releases leases for this pipe's assignees
  const releasedAssignees = pipeStore.markPipeStatus(pipeId, 'cancelled', pid);

  const cancelMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${pipeId} Pipe cancelled.`,
    type: 'system',
    pipe: {
      pipeId,
      mode: state.mode,
      role: 'cancelled',
      reason: 'cancelled-by-user',
    },
  }, pid);
  emitToProject('chat:message', cancelMsg, pid);
  emitToProject('chat:pipe', { type: 'cancel', pipeId }, pid);

  // Drain pending queues for released assignees — unblock any pipes waiting for their lease
  drainPendingPipes(releasedAssignees, pid);

  return true;
}

/** Submit a stage artifact via the dedicated pipe_submit path.
 *  Validates lease, stores content, posts a display message, and advances the pipeline. */
export async function submitPipeStage(
  pipeId: string,
  from: string,
  content: string,
  projectId: string | null,
): Promise<{ ok: boolean; error?: string; code?: string; message?: ChatMessage }> {
  // Validate and store in the pipe stage store
  const result = pipeStore.submitStage(pipeId, from, content, projectId, true);
  if (!result.ok) return { ok: false, error: result.error, code: result.code };

  // Determine pipe role for the chat message metadata
  const storedPipe = pipeStore.getPipe(pipeId, projectId);
  if (!storedPipe) return { ok: false, error: 'Pipe not found after submit' };

  const slot = result.slot;
  let role: PipeMessageMeta['role'] = 'stage-output';
  if (slot?.role === 'final') role = 'final';
  else if (slot?.role === 'fan-out') role = 'fan-out';

  const pipeMeta: PipeMessageMeta = {
    pipeId,
    mode: storedPipe.mode,
    role,
    stage: slot?.stage,
  };

  // Post a chat message for display (pipe artifact visible in chat history)
  const body = `#pipe-${pipeId} ${content}`;
  const msg = appendMessage({
    from,
    to: null,
    body,
    type: 'message',
    pipe: pipeMeta,
  }, projectId);
  emitToProject('chat:message', msg, projectId);

  // PTY deliver to other participants so they see the output
  for (const p of participants.values()) {
    if (p.name !== from && p.paneId && p.projectId === projectId) {
      await deliverToPty(p.name, projectId, msg);
    }
  }

  // Run the reducer to advance the pipeline
  await runPipeReducer(pipeId, projectId);

  // Lease was released by submitStage — drain pending queues to unblock
  // any pipes that were waiting for this participant's lease.
  drainPendingPipes([from], projectId);

  return { ok: true, message: msg };
}

/** Get pipe status from the store. */
export function getPipeStoreStatus(pipeId: string, projectId?: string | null) {
  return pipeStore.getPipeStatus(pipeId, resolveProjectId(projectId));
}

/** Get active pipes for a project (derived from log). */
export function getActivePipes(projectId?: string | null): Array<{ pipeId: string; mode: string; status: string }> {
  const pid = resolveProjectId(projectId);
  const messages = readMessages({ limit: 10000 }, pid);
  const pipeIds = new Set<string>();
  for (const msg of messages) {
    if (msg.pipe?.pipeId) pipeIds.add(msg.pipe.pipeId);
  }

  const result: Array<{ pipeId: string; mode: string; status: string }> = [];
  for (const pipeId of pipeIds) {
    const state = pipeReducer.derivePipeState(messages, pipeId);
    if (state && state.status === 'running') {
      result.push({ pipeId: state.pipeId, mode: state.mode, status: state.status });
    }
  }
  return result;
}

/** Get a specific pipe's state (derived from log). */
export function getPipeRun(pipeId: string, projectId?: string | null): { pipeId: string; mode: string; status: string; projectId: string | null } | undefined {
  const pid = resolveProjectId(projectId);
  const messages = readMessages({ limit: 10000 }, pid);
  const state = pipeReducer.derivePipeState(messages, pipeId);
  if (!state) return undefined;
  return { pipeId: state.pipeId, mode: state.mode, status: state.status, projectId: pid };
}

/** No-op: pipes are now self-recovering from the chat log. */
export function restorePipes(_projectId: string | null): string[] {
  return [];
}
