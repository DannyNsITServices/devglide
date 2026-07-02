import type { Namespace } from 'socket.io';
import type { ChatParticipant, ChatMessage, PipeMessageMeta, PipeUiEvent } from '../types.js';
import { globalPtys, dashboardState, getShellNsp } from '../../shell/src/runtime/shell-state.js';
import { appendMessage, appendPipeEvent, readMessages, clearMessages, saveParticipants, loadParticipants, discoverPersistedPipeIds, readAllPipeEvents, removePipeFiles } from './chat-store.js';
import type { PersistedParticipant } from './chat-store.js';
import { getActiveProject, onProjectChange } from '../../../project-context.js';
import { isPipeCommand, parsePipeCommand, isPipeParseError, validatePipeAssigneeCount, isBrainstormCommand, parseBrainstormCommand } from './pipe-parser.js';
import * as brainstormStore from './brainstorm-store.js';
import * as pipeReducer from './pipe-reducer.js';
import * as pipeStore from './pipe-store.js';
import * as pipeDelivery from './pipe-delivery.js';
import * as assignmentQueries from './pipe-assignment-queries.js';
import * as provenance from './pipe-provenance.js';
import * as materializer from './pipe-assignment-materializer.js';
import * as payloadStore from './payload-store.js';
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
const PANE_DISCONNECT_TIMEOUT_MS = 10_000; // 10 seconds before auto-removal

// ── Pipe reliability constants ──────────────────────────────────────────────
const PIPE_WATCHDOG_INTERVAL_MS = 5_000; // 5 seconds — pane liveness + deadline check

const paneDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Pipe stage deadline timers ──────────────────────────────────────────────
// Keyed by "pipeId:assignee" — one timer per active lease
const stageDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
let pipeWatchdogInterval: ReturnType<typeof setInterval> | null = null;

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

function getMessageAuthority(
  targetName: string,
  msg: ChatMessage,
): 'pipe' | null {
  if (
    msg.from === 'system'
    && msg.pipe?.targetAssignee === targetName
    && (msg.pipe.role === 'handoff' || msg.pipe.role === 'fan-out-request' || msg.pipe.role === 'synth-request')
  ) {
    return 'pipe';
  }

  return null;
}

export function _getMessageAuthorityForTest(
  targetName: string,
  _projectId: string | null,
  msg: ChatMessage,
): 'pipe' | null {
  return getMessageAuthority(targetName, msg);
}

function formatPtyHeader(targetName: string, msg: ChatMessage): string {
  const tags = ['DevGlide Chat'];

  const authority = getMessageAuthority(targetName, msg);
  if (authority) tags.push(`Assigned by: ${authority}`);

  return `[${tags.join(' | ')}]`;
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
  return /^\[DevGlide Chat(?: \| Assigned by: [a-z-]+)*\] @\S+:/m.test(text.trim());
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
export function persistParticipantsForProject(projectId: string | null): void {
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
      joinedVia: p.joinedVia,
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
      joinedVia: p.joinedVia ?? null,
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

function emitPipeEvent(event: Omit<PipeUiEvent, 'id' | 'ts'>, projectId?: string | null): PipeUiEvent {
  const stored = appendPipeEvent(event, projectId);
  emitToProject('chat:pipe', stored, projectId);
  return stored;
}

function ensurePipeAnchor(body: string, pipeId: string): string {
  const anchor = `#pipe-${pipeId}`;
  return body.includes(anchor) ? body : `${anchor} ${body}`;
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
export function deriveNameBase(hint: string, model: string | null): string {
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
  joinedVia?: 'rest' | 'mcp' | null,
): ChatParticipant {
  const now = new Date().toISOString();
  const resolvedProjectId = resolveProjectId(projectId);

  // Claim-or-create: try to reclaim an existing participant by paneId + identity
  const nameBase = deriveNameBase(name, model);
  const existing = findReclaimCandidate(paneId, nameBase, resolvedProjectId);
  if (existing) {
    const wasDetached = existing.detached;
    const previousJoinVia = existing.joinedVia ?? null;
    // Reattach: keep the same alias, update session fields
    existing.detached = false;
    existing.paneId = paneId;
    existing.paneNum = getPaneDisplayNumber(paneId);
    existing.model = model; // refresh — model may vary between sessions
    existing.submitKey = submitKey;
    existing.lastSeen = now;
    existing.status = 'idle';
    existing.joinedVia = joinedVia ?? existing.joinedVia ?? null;
    const reclaimPane = paneId ? dashboardState.panes.find(p => p.id === paneId) : null;
    existing.permissionMode = reclaimPane?.permissionMode ?? existing.permissionMode ?? 'supervised';
    clearParticipantStatusTimer(existing.name, resolvedProjectId);
    bumpParticipantSessionEpoch(existing.name, resolvedProjectId);
    // Cancel any pending auto-removal timer
    const disconnectKey = participantKey(existing.name, resolvedProjectId);
    const disconnectTimer = paneDisconnectTimers.get(disconnectKey);
    if (disconnectTimer) { clearTimeout(disconnectTimer); paneDisconnectTimers.delete(disconnectKey); }

    if (paneId) updatePaneTitle(paneId, existing.name);

    const joinAnnouncement =
      !wasDetached && previousJoinVia === 'rest' && joinedVia === 'mcp'
        ? 'session upgraded'
        : 'reconnected';
    const msg = appendMessage({
      from: existing.name,
      to: null,
      body: `${existing.name} ${joinAnnouncement}${paneId ? ` (${paneId})` : ''}`,
      type: 'join',
    }, existing.projectId);
    emitToProject('chat:join', existing, existing.projectId);
    emitToProject('chat:message', msg, existing.projectId);
    emitMembers(existing.projectId);

    if (paneId) startPanePromptWatcher(existing.name, existing.projectId, paneId);
    persistParticipantsForProject(existing.projectId);

    // Reconcile any pending pipe assignments after reconnect
    if (existing.kind === 'llm') {
      reconcileOnReconnect(existing.name, existing.projectId);
    }

    return { ...existing };
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
    joinedVia: joinedVia ?? null,
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

  return { ...participant };
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

  // Start auto-removal timer — if not reclaimed within timeout, fully remove
  const key = participantKey(name, participant.projectId);
  const existing = paneDisconnectTimers.get(key);
  if (existing) clearTimeout(existing);
  paneDisconnectTimers.set(key, setTimeout(() => {
    paneDisconnectTimers.delete(key);
    const p = getParticipantExact(name, participant.projectId);
    if (p && p.detached) {
      leave(name, participant.projectId);
    }
  }, PANE_DISCONNECT_TIMEOUT_MS));

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

  // ─── Brainstorm command detection (user-only) ──────────────────────
  if (from === 'user' && isBrainstormCommand(body)) {
    return handleBrainstormCommand(body, resolvedSenderProjectId);
  }

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
    if (pipeMeta) body = ensurePipeAnchor(body, pipeMeta.pipeId);
  }

  // ─── Build delivery plan (targeted PTY delivery) ────────────────────
  const plan = buildDeliveryPlan(from, body, to, senderKind, resolvedSenderProjectId);

  if (sender?.kind === 'llm' && sender.projectId === resolvedSenderProjectId && sender.status && sender.status !== 'idle') {
    setParticipantStatus(sender.name, resolvedSenderProjectId, sender.status);
  }
  // Status side-effects use concreteAssignees only — NOT recipients.
  // This prevents @all from setting every agent to "working".
  if (senderKind === 'user') {
    for (const targetName of plan.concreteAssignees) {
      const status = markAssignedParticipantStatus(body, targetName);
      if (status) setParticipantStatus(targetName, resolvedSenderProjectId, status);
    }
  }

  // Display `to` field — what the dashboard renders as `@sender → <to>`.
  // For explicit targets, list the validated names. For implicit user/system
  // broadcasts (Option B fallback), show "all" so the header reads
  // `@user → @all` instead of being silently absent.
  const displayTo = plan.targetLabels.length === 1
    ? plan.targetLabels[0]
    : plan.targetLabels.length > 1
      ? plan.targetLabels.join(', ')
      : plan.fallbackBroadcast
        ? 'all'
        : null;

  // ─── Compute delivery count BEFORE persisting ──────────────────────
  // So deliveredTo is included in the persisted message and socket emit.
  let expectedDeliveryCount: number;
  if (plan.recipients.length > 0) {
    expectedDeliveryCount = plan.recipients.length;
  } else if (plan.fallbackBroadcast) {
    // Count broadcast targets (Option B fallback)
    expectedDeliveryCount = 0;
    for (const p of participants.values()) {
      if (p.name !== from && p.paneId && p.projectId === resolvedSenderProjectId) {
        expectedDeliveryCount++;
      }
    }
  } else {
    expectedDeliveryCount = 0;
  }

  const msg = appendMessage({
    from,
    to: displayTo,
    body,
    type: 'message',
    ...(pipeMeta ? { pipe: pipeMeta } : {}),
    ...(expectedDeliveryCount > 0 ? { deliveredTo: expectedDeliveryCount } : {}),
    ...(plan.unresolvedTargets.length > 0 ? { unresolvedTargets: plan.unresolvedTargets } : {}),
  }, resolvedSenderProjectId);

  // Emit to dashboard clients viewing this project only
  emitToProject('chat:message', msg, resolvedSenderProjectId);

  // ─── Targeted PTY delivery ─────────────────────────────────────────
  // Deliver only to resolved recipients. If no recipients and sender is
  // user/system, fall back to broadcast (Option B backward compat).
  // LLM messages with no @mention: NO PTY delivery (token savings).
  if (plan.recipients.length > 0) {
    for (const name of plan.recipients) {
      await deliverToPty(name, resolvedSenderProjectId, msg);
    }
  } else if (plan.fallbackBroadcast) {
    // Option B: unaddressed user/system messages still broadcast
    for (const p of participants.values()) {
      if (p.name !== from && p.paneId && p.projectId === resolvedSenderProjectId) {
        await deliverToPty(p.name, resolvedSenderProjectId, msg);
      }
    }
  }
  // LLM with no @mention and no fallback: no PTY delivery.
  // Message is persisted (above) and visible in dashboard — just not PTY-injected.

  // ─── Pipe reducer: check if this message triggers next step ────────
  // NOTE: pipeMeta is only set for legacy pipes NOT tracked in the store.
  // Store-tracked pipes are suppressed above — they require pipe_submit.
  if (pipeMeta) {
    runPipeReducer(pipeMeta.pipeId, resolvedSenderProjectId)
      .catch(err => console.error('[pipe] reducer failed:', err));
  }

  return msg;
}

// ─── Targeted PTY Delivery — Two-stage target resolution ────────────

/** Reserved pseudo-targets that are semantic only (no PTY delivery). */
const SEMANTIC_ONLY_TARGETS = new Set(['user', 'system']);

/** Strip fenced code blocks (```...```) and inline code spans (`...`) from
 *  body text so the @mention regex doesn't pick up example syntax as real
 *  recipients. Replaces them with whitespace so character offsets stay sane
 *  and adjacent tokens don't accidentally fuse together. */
function stripCodeRegions(body: string): string {
  // Fenced first (greedy on whole blocks; non-greedy on the inner content).
  // Matches ``` optionally followed by a language tag, then anything until
  // the next ``` on its own boundary.
  let stripped = body.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
  // Inline code spans — single backticks. Run after fenced so we don't bite
  // into the fence markers themselves.
  stripped = stripped.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return stripped;
}

/** Extract raw @mention tokens from message body (pure string parsing, no state).
 *  Returns tokens like ["all"], ["claude-7", "codex-14"], ["team-ui"], or [].
 *  Handles explicit `to` param (which may be comma-separated), merging with
 *  body @mentions. Mentions inside inline code spans and fenced code blocks
 *  are ignored — they are example syntax, not real addressees. */
// senderKind kept in signature for backward compatibility / future use; the
// merge behavior is identical for user and llm senders.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function parseTargetTokens(body: string, to?: string, senderKind?: 'user' | 'llm'): string[] {
  const tokens: string[] = [];

  // Explicit `to` param — split on commas, trim, lowercase, drop empties.
  // Real-world: callers sometimes pass `to: "codex-3,pi-1"` instead of a
  // single name. Splitting here keeps the rest of the pipeline simple and
  // prevents the literal comma-string from leaking into displayed `msg.to`.
  if (to) {
    for (const raw of to.split(',')) {
      const normalized = raw.trim().toLowerCase();
      if (normalized && !tokens.includes(normalized)) tokens.push(normalized);
    }
  }

  // Scan body for all @mentions, but only outside code regions. The
  // capture is restricted to `[a-zA-Z0-9-]+` (letters, digits, hyphens)
  // so markdown formatting (`**`, `_`, `~`), trailing punctuation, and
  // parentheses cannot leak into the token. Note: underscore is excluded
  // because it's a markdown emphasis marker (`_@claude_`); chat aliases
  // in DevGlide use `-` as the separator. This is the parser-side
  // defense; `buildDeliveryPlan` adds a second defense by filtering
  // tokens that don't resolve to a real participant.
  const scannable = stripCodeRegions(body);
  const regex = /@([a-zA-Z0-9-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(scannable)) !== null) {
    const token = match[1];
    if (token && !tokens.includes(token)) tokens.push(token);
  }

  return tokens;
}

/** Expand raw target tokens into concrete participant names for PTY delivery.
 *  Returns { recipients, concreteAssignees } — recipients is the full delivery list,
 *  concreteAssignees is direct @mentions only (no group expansions) for status side-effects. */
export function expandToRecipients(
  tokens: string[],
  from: string,
  projectId: string | null,
): { recipients: string[]; concreteAssignees: string[]; unresolvedTargets: string[] } {
  const recipientSet = new Set<string>();
  const concreteSet = new Set<string>();
  const unresolvedSet = new Set<string>();
  const pid = resolveProjectId(projectId);

  for (const token of tokens) {
    if (token === 'all') {
      // @all → every live, non-detached participant except sender
      for (const p of participants.values()) {
        if (p.name !== from && p.projectId === pid && !p.detached && p.paneId) {
          recipientSet.add(p.name);
        }
      }
      // @all does NOT add to concreteAssignees — it's a group expansion
    } else if (SEMANTIC_ONLY_TARGETS.has(token)) {
      // @user, @system — semantic only, no PTY delivery target
      continue;
    } else {
      // Individual participant name
      const p = getParticipantExact(token, pid);
      if (p && p.projectId === pid && p.name !== from) {
        concreteSet.add(p.name);  // direct @mention → concrete assignee (always, for status)
        // Only add to recipients if live and deliverable (not detached, has pane)
        if (!p.detached && p.paneId) {
          recipientSet.add(p.name);
        }
      } else if (!p || p.projectId !== pid) {
        // Token doesn't match any known participant in this project
        unresolvedSet.add(token);
      }
    }
  }

  return {
    recipients: [...recipientSet],
    concreteAssignees: [...concreteSet],
    unresolvedTargets: [...unresolvedSet],
  };
}

/** Build a complete delivery plan from message content and sender context.
 *  Combines token parsing + recipient expansion + fallback logic. */
export function buildDeliveryPlan(
  from: string,
  body: string,
  to: string | undefined,
  senderKind: 'user' | 'llm',
  projectId: string | null,
): import('../types.js').DeliveryPlan {
  const tokens = parseTargetTokens(body, to, senderKind);
  const { recipients, concreteAssignees, unresolvedTargets } = expandToRecipients(tokens, from, projectId);

  // Determine fallback: ONLY truly unaddressed user/system messages broadcast (Option B).
  // If the sender wrote @mentions that didn't resolve (typo, offline, semantic-only),
  // that is NOT "unaddressed" — they intended a target, it just failed. No fallback.
  const hadTargetIntent = tokens.length > 0;
  const fallbackBroadcast = !hadTargetIntent && recipients.length === 0
    && (senderKind === 'user' || from === 'system');

  // Display label list: only tokens that resolved to a real participant
  // or the literal `all` group expansion. Unresolved garbage (markdown
  // leaks, typos, the literal comma-string from a comma-separated `to`
  // param, semantic-only `user`/`system`) is excluded so the dashboard
  // renderer never shows it. Sender alias is also excluded — sending to
  // yourself is nonsense. Order from `tokens` is preserved.
  const fromLower = from.toLowerCase();
  const concreteSet = new Set(concreteAssignees);
  const targetLabels: string[] = [];
  for (const token of tokens) {
    if (token === fromLower) continue;
    if (token === 'all' || concreteSet.has(token)) {
      if (!targetLabels.includes(token)) targetLabels.push(token);
    }
  }

  return { targetLabels, recipients, concreteAssignees, fallbackBroadcast, unresolvedTargets };
}

/** @deprecated Use buildDeliveryPlan() instead. Kept for backward compatibility during migration. */
function resolveTargets(from: string, body: string, to?: string, senderKind?: 'user' | 'llm', projectId?: string | null): string[] {
  const plan = buildDeliveryPlan(from, body, to, senderKind ?? 'llm', projectId ?? null);
  return plan.concreteAssignees;
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

      const header = formatPtyHeader(targetName, msg);
      let formatted = `${header} @${msg.from}: ${msg.body}`;

      // Write with retry — if the initial write fails, retry once after a short delay
      let writeOk = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const ptyEntry = attempt === 0 ? entry : globalPtys.get(paneId);
          if (!ptyEntry) {
            disconnectParticipant(targetName, projectId, 'pane disappeared during delivery retry');
            return;
          }
          ptyEntry.ptyProcess.write(formatted);
          writeOk = true;
          break;
        } catch (err) {
          if (attempt === 0) {
            console.warn(`[chat] PTY write failed for ${targetName}, retrying in 500ms:`, err);
            await new Promise((resolve) => setTimeout(resolve, 500));
          } else {
            console.error(`[chat] PTY write retry failed for ${targetName}, disconnecting:`, err);
            disconnectParticipant(targetName, projectId, 'pane write failed');
            return;
          }
        }
      }
      if (!writeOk) return;

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
      result.push({ ...p });
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function comparePipeAssigneeOrder(a: ChatParticipant, b: ChatParticipant): number {
  const byJoin = a.joinedAt.localeCompare(b.joinedAt);
  if (byJoin !== 0) return byJoin;
  return a.name.localeCompare(b.name);
}

export function listDefaultPipeAssignees(projectId?: string | null): ChatParticipant[] {
  pruneStaleParticipants();

  const pid = resolveProjectId(projectId);
  return [...participants.values()]
    .filter((participant) =>
      participant.projectId === pid
      && participant.kind === 'llm'
      && !participant.detached
      && !!participant.paneId)
    .sort(comparePipeAssigneeOrder);
}

export function getParticipant(name: string, projectId?: string | null): ChatParticipant | undefined {
  // Exact lookup when projectId is provided
  if (projectId !== undefined) return getParticipantExact(name, projectId);
  // No projectId supplied: scope strictly to the active project — never fall back
  // to a cross-project match, even when it is the only match by name.
  const pid = activeProjectId();
  return getParticipantExact(name, pid);
}

export function getParticipantByPaneId(paneId: string, projectId?: string | null): ChatParticipant | undefined {
  pruneStaleParticipants();

  // Determine the scope: explicit projectId if given, otherwise the active project.
  // Under no circumstances return a participant whose projectId differs from the scope.
  const pid = projectId !== undefined ? projectId : activeProjectId();
  for (const participant of participants.values()) {
    if (participant.paneId === paneId && participant.projectId === pid) return participant;
  }
  return undefined;
}

/** Clear chat history for the active project and notify dashboard clients. */
export function clearHistory(projectId?: string | null): void {
  const pid = resolveProjectId(projectId);
  clearMessages(pid);
  emitToProject('chat:cleared', {}, pid);
}

/** Clean up stale terminal pipes from both in-memory store and disk.
 *  Removes completed/failed/cancelled pipes older than the TTL.
 *  Returns the count of removed pipes. */
export function cleanupStalePipes(projectId?: string | null, ttlMs?: number): number {
  const pid = resolveProjectId(projectId);
  const removed = pipeStore.cleanupTerminalPipes(pid, ttlMs);
  if (removed.length > 0) {
    removePipeFiles(removed, pid);
    pipeDelivery.removeDeliveriesForPipes(removed, pid);
    console.log(`[pipe] Cleaned up ${removed.length} stale pipe(s): ${removed.join(', ')}`);
  }
  return removed.length;
}

/** Recover active pipes from persisted event logs after server restart.
 *  Rebuilds in-memory pipe state from per-pipe events files.
 *  Pipes that were running at shutdown are rehydrated; the reducer is re-run
 *  for each recovered pipe so leases can be re-granted when participants rejoin.
 *  Returns the count of recovered running pipes. */
export function recoverPipes(projectId?: string | null): number {
  const pid = resolveProjectId(projectId);
  const pipeIds = discoverPersistedPipeIds(pid);
  if (pipeIds.length === 0) return 0;

  // Collect all events across all pipe files
  const allEvents: import('./pipe-store.js').PipeRecoveryEvent[] = [];
  for (const pipeId of pipeIds) {
    // Skip if already in memory (shouldn't happen after fresh start)
    if (pipeStore.getPipe(pipeId, pid)) continue;

    const events = readAllPipeEvents(pipeId, pid);
    for (const event of events) {
      allEvents.push({
        type: event.type,
        pipeId: event.pipeId,
        mode: event.mode ?? undefined,
        assignees: event.assignees,
        prompt: event.prompt,
        stageTimeoutMs: event.stageTimeoutMs,
        timeoutPolicy: event.timeoutPolicy,
        from: event.from,
        role: event.role,
        stage: event.stage,
        content: event.content,
      });
    }
  }

  const runningPipeIds = pipeStore.rehydrateFromEvents(allEvents, pid);

  if (runningPipeIds.length > 0) {
    console.log(`[pipe] Recovered ${runningPipeIds.length} running pipe(s) from disk: ${runningPipeIds.join(', ')}`);
    startPipeWatchdog();
  }

  return runningPipeIds.length;
}

// ── Reconnect assignment reconciliation ──────────────────────────────────────

/** Reconcile pipe assignments when a participant reconnects (or joins for the
 *  first time after server restart with recovered pipes).
 *
 *  For each running pipe where the participant has pending or leased slots,
 *  re-run the reducer so that:
 *  - Pending slots get a lease grant + PTY handoff delivery
 *  - Leased slots whose deadline expired get released and reset to pending
 *  - Leased slots still within deadline get re-delivered to the now-live pane
 *
 *  Returns the number of pipes that were reconciled. */
export function reconcileOnReconnect(name: string, projectId: string | null): number {
  const assignments = pipeStore.getAssignmentsForParticipant(name, projectId);
  if (assignments.length === 0) return 0;

  const pipeIds = new Set<string>();
  for (const a of assignments) {
    if (a.slotStatus === 'pending' || a.slotStatus === 'leased') {
      pipeIds.add(a.pipeId);
    }
  }

  if (pipeIds.size === 0) return 0;

  for (const pipeId of pipeIds) {
    const lease = pipeStore.getActiveLease(name, projectId);
    if (lease && lease.pipeId === pipeId && pipeStore.isLeaseExpired(lease)) {
      pipeStore.releaseLease(name, projectId);
      const pipe = pipeStore.getPipe(pipeId, projectId);
      if (pipe) {
        const slots = pipe.slots.get(name);
        if (slots) {
          for (const slot of slots) {
            if (slot.status === 'leased') slot.status = 'pending';
          }
        }
      }
    }

    runPipeReducer(pipeId, projectId).catch((err) => {
      console.error(`[pipe] reconcileOnReconnect reducer error for pipe #${pipeId}:`, err);
    });
  }

  console.log(`[pipe] Reconciled ${pipeIds.size} pipe(s) for reconnected participant "${name}"`);
  return pipeIds.size;
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


// ── Pipe stage deadline management ──────────────────────────────────────────

function deadlineKey(pipeId: string, assignee: string): string {
  return `${pipeId}:${assignee}`;
}

/** Start a deadline timer for a leased pipe stage.
 *  When the timer fires, the timeout policy is applied. */
function startStageDeadline(
  pipeId: string,
  assignee: string,
  projectId: string | null,
  timeoutMs: number,
  policy: import('../types.js').PipeTimeoutPolicy,
): void {
  if (timeoutMs <= 0) return; // no timeout configured
  const key = deadlineKey(pipeId, assignee);
  const existing = stageDeadlineTimers.get(key);
  if (existing) clearTimeout(existing);
  stageDeadlineTimers.set(key, setTimeout(() => {
    stageDeadlineTimers.delete(key);
    handleStageTimeout(pipeId, assignee, projectId, policy);
  }, timeoutMs));
}

/** Clear a specific stage deadline (e.g. after successful submit). */
function clearStageDeadline(pipeId: string, assignee: string): void {
  const key = deadlineKey(pipeId, assignee);
  const timer = stageDeadlineTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    stageDeadlineTimers.delete(key);
  }
}

/** Clear all deadline timers for a pipe (e.g. when pipe reaches terminal state). */
function clearAllDeadlinesForPipe(pipeId: string): void {
  for (const [key, timer] of stageDeadlineTimers) {
    if (key.startsWith(`${pipeId}:`)) {
      clearTimeout(timer);
      stageDeadlineTimers.delete(key);
    }
  }
}

/** Handle a stage timeout by applying the configured policy. */
function handleStageTimeout(
  pipeId: string,
  assignee: string,
  projectId: string | null,
  policy: import('../types.js').PipeTimeoutPolicy,
): void {
  const pipe = pipeStore.getPipe(pipeId, projectId);
  if (!pipe || pipe.status !== 'running') return;

  if (policy === 'escalate') {
    // Notify user, keep pipe running — user decides what to do.
    // Clear the lease deadline so the assignee can still respond and the
    // watchdog doesn't re-fire this escalation on every tick.
    const lease = pipeStore.getActiveLease(assignee, projectId);
    if (lease && lease.pipeId === pipeId) lease.deadline = null;
    const escalateMsg = appendMessage({
      from: 'system', to: null,
      body: `#pipe-${pipeId} Stage timeout: @${assignee} has not responded within the deadline ` +
        `(${Math.round(pipe.stageTimeoutMs / 1000)}s). The pipe is still running. ` +
        `Cancel with \`/cancel-pipe ${pipeId}\` or wait for the participant to respond.`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', escalateMsg, projectId);
    return;
  }

  // 'fail' (default) or 'reassign' (not yet implemented — falls through to fail)
  clearAllDeadlinesForPipe(pipeId);
  const releasedAssignees = pipeStore.markPipeStatus(pipeId, 'failed', projectId);
  provenance.recordProvenance(projectId, { pipeId, event: 'failed', actor: 'system', actorKind: 'system', metadata: { reason: 'timeout', assignee, policy } });
  const policyNote = policy === 'reassign'
    ? ' (reassign policy not yet supported — pipe failed instead)'
    : '';
  const failMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${pipeId} Pipe timed out: @${assignee} did not submit within the deadline ` +
      `(${Math.round(pipe.stageTimeoutMs / 1000)}s).${policyNote}`,
    type: 'system',
    pipe: { pipeId, mode: pipe.mode, role: 'failed', reason: 'timeout' },
  }, projectId);
  emitToProject('chat:message', failMsg, projectId);
  emitPipeEvent({ type: 'failed', pipeId, reason: 'timeout' }, projectId);
  drainPendingPipes(releasedAssignees, projectId);
}

// ── Pipe liveness watchdog ──────────────────────────────────────────────────

const PIPE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let lastCleanupAt = 0;

/** Periodic watchdog that checks pane liveness for active pipe leaseholders
 *  and enforces stage deadlines. Runs every PIPE_WATCHDOG_INTERVAL_MS. */
function pipeWatchdogTick(): void {
  // 1. Prune stale participants (detect disappeared panes)
  pruneStaleParticipants();

  // 2. Check stage deadlines for leases that passed their deadline but whose
  //    timer hasn't fired yet (defensive — timers should handle this, but
  //    the watchdog catches edge cases like clock drift or timer GC)
  const now = Date.now();
  for (const [, lease] of pipeStore.getAllActiveLeases()) {
    if (!lease.deadline) continue;
    const deadlineMs = new Date(lease.deadline).getTime();
    if (now >= deadlineMs && !stageDeadlineTimers.has(deadlineKey(lease.pipeId, lease.assignee))) {
      // Deadline passed and no active timer — resolve immediately
      const pipe = pipeStore.getPipe(lease.pipeId, null) ??
                   findPipeAcrossProjects(lease.pipeId);
      if (pipe && pipe.status === 'running') {
        handleStageTimeout(lease.pipeId, lease.assignee, findProjectForPipe(lease.pipeId), pipe.timeoutPolicy);
      }
    }
  }

  // 3. Periodic cleanup of terminal pipes (throttled to every 10 minutes)
  //    Iterates all projects with pipe data, not just the active one.
  if (now - lastCleanupAt >= PIPE_CLEANUP_INTERVAL_MS) {
    lastCleanupAt = now;
    for (const pid of pipeStore.getTrackedProjectIds()) {
      const removed = pipeStore.cleanupTerminalPipes(pid);
      if (removed.length > 0) {
        removePipeFiles(removed, pid);
        pipeDelivery.removeDeliveriesForPipes(removed, pid);
      }
    }
  }
}

/** Find a pipe by scanning all project stores. */
function findPipeAcrossProjects(pipeId: string): import('./pipe-store.js').StoredPipe | undefined {
  // Try active project first, then scan all tracked projects
  const pid = activeProjectId();
  const pipe = pipeStore.getPipe(pipeId, pid);
  if (pipe) return pipe;
  for (const trackedPid of pipeStore.getTrackedProjectIds()) {
    if (trackedPid === pid) continue;
    const found = pipeStore.getPipe(pipeId, trackedPid);
    if (found) return found;
  }
  return undefined;
}

/** Find the projectId that owns a pipe by scanning all project stores. */
function findProjectForPipe(pipeId: string): string | null {
  const pid = activeProjectId();
  if (pipeStore.getPipe(pipeId, pid)) return pid;
  for (const trackedPid of pipeStore.getTrackedProjectIds()) {
    if (trackedPid === pid) continue;
    if (pipeStore.getPipe(pipeId, trackedPid)) return trackedPid;
  }
  return null;
}

/** Start the pipe watchdog interval. Idempotent — safe to call multiple times. */
export function startPipeWatchdog(): void {
  if (pipeWatchdogInterval) return;
  pipeWatchdogInterval = setInterval(pipeWatchdogTick, PIPE_WATCHDOG_INTERVAL_MS);
  // Don't prevent Node from exiting
  if (pipeWatchdogInterval.unref) pipeWatchdogInterval.unref();
}

/** Stop the pipe watchdog. Exported for test cleanup. */
export function stopPipeWatchdog(): void {
  if (pipeWatchdogInterval) {
    clearInterval(pipeWatchdogInterval);
    pipeWatchdogInterval = null;
  }
}

/** Clear all deadline timers. Exported for test cleanup. */
export function clearAllDeadlineTimers(): void {
  for (const [key, timer] of stageDeadlineTimers) {
    clearTimeout(timer);
    stageDeadlineTimers.delete(key);
  }
}

// ── Pipe orchestration (log-centric reducer model) ───────────────────────────

async function handlePipeCommand(body: string, projectId: string | null): Promise<ChatMessage> {
  const parsed = parsePipeCommand(body, (name) => getParticipantExact(name, projectId) != null);
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

  const resolvedAssignees = parsed.assignees.length > 0
    ? parsed.assignees
    : listDefaultPipeAssignees(projectId).map((participant) => participant.name);

  const countError = validatePipeAssigneeCount(parsed.mode, resolvedAssignees.length);
  if (countError) {
    const detail = parsed.assignees.length === 0
      ? ' No eligible default LLM assignees were available.'
      : '';
    const errorMsg = appendMessage({
      from: 'system', to: null,
      body: `Pipe error: ${countError}${detail}`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', errorMsg, projectId);
    return userMsg;
  }

  // Validate all assignees are connected, live LLM participants
  const invalid: string[] = [];
  const reasons: string[] = [];
  for (const a of resolvedAssignees) {
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
  const resolved = { ...parsed, assignees: resolvedAssignees };
  const desc = pipeReducer.getStartDescription(resolved);

  // Create pipe in the isolated stage store (with timeout config)
  pipeStore.createPipe(pipeId, parsed.mode, resolvedAssignees, parsed.prompt, projectId, {
    stageTimeoutMs: parsed.stageTimeoutMs,
    timeoutPolicy: parsed.timeoutPolicy,
  });
  provenance.recordProvenance(projectId, { pipeId, event: 'created', actor: 'user', actorKind: 'user', metadata: { mode: parsed.mode, assignees: resolvedAssignees } });

  // Ensure the pipe watchdog is running
  startPipeWatchdog();

  const startMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${pipeId} Pipe started (${parsed.mode}): ${desc}`,
    type: 'system',
    pipe: {
      pipeId,
      mode: parsed.mode,
      role: 'start',
      assignees: resolvedAssignees,
      prompt: parsed.prompt,
    },
  }, projectId);
  emitToProject('chat:message', startMsg, projectId);
  emitPipeEvent({
    type: 'start', pipeId, mode: parsed.mode,
    assignees: resolvedAssignees,
    prompt: parsed.prompt,
    stageTimeoutMs: parsed.stageTimeoutMs ?? pipeStore.DEFAULT_STAGE_TIMEOUT_MS,
    timeoutPolicy: parsed.timeoutPolicy ?? 'fail',
  }, projectId);

  // Run reducer to emit initial handoff/fan-out
  await runPipeReducer(pipeId, projectId);

  return userMsg;
}

/** Detect if an LLM message is a response to an active pipe.
 *  Uses #pipe-{id} in the body as primary discriminator; falls back to
 *  most-recently-prompted pipe if no explicit tag is present. */
function detectPipeResponse(from: string, body: string, projectId: string | null): PipeMessageMeta | undefined {
  // ── Store-backed detection (primary) ──
  const explicitMatch = body.match(/#pipe-([a-f0-9]+)/);
  if (explicitMatch) {
    const storedPipe = pipeStore.getPipe(explicitMatch[1], projectId);
    if (storedPipe && storedPipe.status === 'running') {
      const state = pipeReducer.buildStateFromStore(storedPipe);
      const meta = pipeReducer.matchResponse(state, from);
      if (meta) return meta;
    }
  }

  const senderPipeIds = pipeStore.getActivePipesForParticipant(from, projectId);
  for (const pipeId of senderPipeIds) {
    const storedPipe = pipeStore.getPipe(pipeId, projectId);
    if (!storedPipe || storedPipe.status !== 'running') continue;
    const state = pipeReducer.buildStateFromStore(storedPipe);
    const meta = pipeReducer.matchResponse(state, from);
    if (meta) return meta;
  }

  // ── Log-backed fallback (recovery / legacy pipes not in store) ──
  const messages = readMessages({ limit: 10000 }, projectId);
  const pipeIds = new Set<string>();
  for (const msg of messages) {
    if (msg.pipe?.pipeId) pipeIds.add(msg.pipe.pipeId);
  }
  if (pipeIds.size === 0) return undefined;

  if (explicitMatch && pipeIds.has(explicitMatch[1])) {
    const state = pipeReducer.derivePipeState(messages, explicitMatch[1]);
    if (state && state.status === 'running') {
      const meta = pipeReducer.matchResponse(state, from);
      if (meta) return meta;
    }
  }

  // Last resort: find the most recently prompted pipe for this sender in the log
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
    if (state && state.status === 'running') {
      const meta = pipeReducer.matchResponse(state, from);
      if (meta) return meta;
    }
  }

  return undefined;
}

/** Run the pipe reducer: derive state from pipe store, compute next actions, execute them.
 *  Pipe instructions and intermediate outputs NEVER enter chat history.
 *  Only the final result is appended as a public chat message. */
async function runPipeReducer(pipeId: string, projectId: string | null): Promise<void> {
  const storedPipe = pipeStore.getPipe(pipeId, projectId);
  if (!storedPipe || storedPipe.status !== 'running') return;

  // Build state entirely from pipe store — no log scanning
  const state = pipeReducer.buildStateFromStore(storedPipe);

  // Check for completion — broadcast final result as a public chat message
  if (state.hasFinal) {
    clearAllDeadlinesForPipe(pipeId);
    pipeDelivery.cancelAllDeliveries(pipeId, projectId);
    materializer.cancelPipeAssignments(pipeId, projectId);
    pipeStore.markPipeStatus(pipeId, 'completed', projectId);
    provenance.recordProvenance(projectId, { pipeId, event: 'completed', actor: 'system', actorKind: 'system' });

    // Read the final output from pipe state and persist it for the user.
    // Final output is user-only: persisted in chat history and emitted to
    // dashboard via Socket.IO, but NOT PTY-delivered to LLM participants.
    // This prevents long output from cluttering LLM terminals.
    const finalContent = readFinalOutput(pipeId, projectId);
    if (finalContent) {
      const resultMsg = appendMessage({
        from: finalContent.from, to: 'user',
        body: ensurePipeAnchor(finalContent.body, pipeId),
        type: 'message',
        pipe: { pipeId, mode: state.mode, role: 'final' },
      }, projectId);
      emitToProject('chat:message', resultMsg, projectId);
      // No PTY delivery — user sees it on dashboard only.
    }

    emitPipeEvent({ type: 'complete', pipeId }, projectId);

    // Check if this pipe is a brainstorm child — advance brainstorm state
    await advanceBrainstormOnChildComplete(pipeId, projectId);
    return;
  }

  const actions = pipeReducer.computeNextActions(state);
  for (const action of actions) {
    // Grant lease to target assignee in the store
    const leaseResult = pipeStore.grantLease(pipeId, action.targetAssignee, projectId);
    if (!leaseResult.ok) {
      pipeStore.addPendingPipe(action.targetAssignee, projectId, pipeId);
      // Emit queued diagnostic to dashboard UI only — NOT to chat history
      emitPipeEvent({
        type: 'queued',
        pipeId,
        assignee: action.targetAssignee,
        reason: leaseResult.error,
      }, projectId);
      continue;
    }

    // Start stage deadline timer for this lease
    startStageDeadline(pipeId, action.targetAssignee, projectId, storedPipe.stageTimeoutMs, storedPipe.timeoutPolicy);
    provenance.recordProvenance(projectId, { pipeId, event: 'stage-granted', actor: 'system', actorKind: 'system', stage: action.type === 'handoff' ? action.stage : undefined, role: action.type, metadata: { assignee: action.targetAssignee } });

    // Track emission in pipe store (replaces appendMessage to chat history)
    pipeStore.markEmitted(pipeId, action.type, action.type === 'handoff' ? action.stage : action.targetAssignee, projectId);

    // Materialize assignment + payload for lifecycle tracking
    const materialized = materializer.materializeAssignment(pipeId, state.mode, action, projectId);

    // Transport-layer: create delivery record for re-notify tracking
    pipeDelivery.createDelivery(
      pipeId, action.targetAssignee, action.type, action.body, projectId, action.stage,
    );

    // Format compact notification — PTY gets a pointer, not the full payload
    const notification = pipeDelivery.formatCompactNotification(
      pipeId,
      state.mode,
      action.type,
      action.targetAssignee,
      state.assignees.length,
      action.stage,
    );

    // Construct compact delivery message for PTY injection — NOT stored in chat history.
    const deliveryMsg: import('../types.js').ChatMessage = {
      id: `pipe-${pipeId}-${action.type}-${action.targetAssignee}`,
      ts: new Date().toISOString(),
      from: 'system',
      to: action.targetAssignee,
      body: notification.body,
      type: 'system',
      pipe: action.pipe,
    };

    // Emit to dashboard UI as a pipe event (not chat:message — stays out of chat rendering)
    emitPipeEvent({
      type: 'instruction',
      pipeId,
      actionType: action.type,
      assignee: action.targetAssignee,
      stage: action.stage,
    }, projectId);

    // PTY deliver only to the target assignee
    const target = getParticipantExact(action.targetAssignee, projectId);
    if (target?.paneId && !target.detached) {
      await deliverToPty(action.targetAssignee, projectId, deliveryMsg);
      // Transition assignment lifecycle: assigned → notified (after successful PTY delivery)
      if (materialized) {
        materializer.transitionAssignmentStatus(materialized.assignmentId, 'notified', projectId);
      }
      // Transport-layer: record notification attempt for re-notify tracking
      pipeDelivery.recordNotification(pipeId, action.targetAssignee, projectId);
      pipeDelivery.startRenotifyTimer(pipeId, action.targetAssignee, projectId, handleRenotify);
    }
  }
}

/** Re-notify: re-delivers compact notification to a tardy assignee. */
function handleRenotify(pipeId: string, assignee: string, projectId: string | null): void {
  const record = pipeDelivery.getDelivery(pipeId, assignee, projectId);
  if (!record || record.state !== 'notified') return;
  const pipe = pipeStore.getPipe(pipeId, projectId);
  if (!pipe || pipe.status !== 'running') return;
  const target = getParticipantExact(assignee, projectId);
  if (!target?.paneId || target.detached) return;
  const notification = pipeDelivery.formatCompactNotification(
    pipeId,
    pipe.mode,
    record.role as 'handoff' | 'fan-out-request' | 'synth-request',
    assignee,
    pipe.assignees.length,
    record.stage,
  );
  const renotifyMsg: import('../types.js').ChatMessage = {
    id: `pipe-${pipeId}-renotify-${assignee}-${record.notifyAttempts}`,
    ts: new Date().toISOString(), from: 'system', to: assignee,
    body: notification.body, type: 'system', pipe: notification.pipe,
  };
  deliverToPty(assignee, projectId, renotifyMsg)
    .then(() => {
      pipeDelivery.recordNotification(pipeId, assignee, projectId);
      pipeDelivery.startRenotifyTimer(pipeId, assignee, projectId, handleRenotify);
    })
    .catch(err => console.error(`[pipe] re-notify failed for ${assignee}:`, err));
}

/** Read the final output content from pipe state. */
function readFinalOutput(pipeId: string, projectId: string | null): { from: string; body: string } | null {
  const pipe = pipeStore.getPipe(pipeId, projectId);
  if (!pipe) return null;
  for (const [, slotList] of pipe.slots) {
    for (const slot of slotList) {
      if (slot.role === 'final' && slot.status === 'submitted' && slot.content) {
        return { from: slot.assignee, body: slot.content };
      }
    }
  }
  return null;
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

    // Clear all deadline timers and delivery tracking for this pipe
    clearAllDeadlinesForPipe(pipeId);
    pipeDelivery.cancelAllDeliveries(pipeId, projectId);
    materializer.cancelPipeAssignments(pipeId, projectId);

    // Update store — releases leases for this pipe's assignees
    const releasedAssignees = pipeStore.markPipeStatus(pipeId, 'failed', projectId);

    provenance.recordProvenance(projectId, { pipeId, event: 'failed', actor: 'system', actorKind: 'system', metadata: { reason, unavailableParticipant: name } });

    // Post failure to chat history (public lifecycle event)
    const failMsg = appendMessage({
      from: 'system', to: null,
      body: `#pipe-${pipeId} Pipe stopped: @${name} became unavailable (${reason}).`,
      type: 'system',
      pipe: {
        pipeId,
        mode: storedPipe.mode,
        role: 'failed',
        reason,
      },
    }, projectId);
    emitToProject('chat:message', failMsg, projectId);
    emitPipeEvent({ type: 'failed', pipeId }, projectId);

    // Drain pending queues for released assignees — unblock any pipes waiting for their lease
    drainPendingPipes(releasedAssignees, projectId);
  }
}

/** Cancel a running pipe by user request. */
export async function cancelPipeRun(pipeId: string, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const pipe = pipeStore.getPipe(pipeId, pid);
  if (!pipe || pipe.status !== 'running') return false;

  // Clear all deadline timers and delivery tracking for this pipe
  clearAllDeadlinesForPipe(pipeId);
  pipeDelivery.cancelAllDeliveries(pipeId, pid);
  materializer.cancelPipeAssignments(pipeId, pid);

  // Update store — releases leases for this pipe's assignees
  const releasedAssignees = pipeStore.markPipeStatus(pipeId, 'cancelled', pid);
  provenance.recordProvenance(pid, { pipeId, event: 'cancelled', actor: 'user', actorKind: 'user' });

  const cancelMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${pipeId} Pipe cancelled.`,
    type: 'system',
    pipe: {
      pipeId,
      mode: pipe.mode,
      role: 'cancelled',
      reason: 'cancelled-by-user',
    },
  }, pid);
  emitToProject('chat:message', cancelMsg, pid);
  emitPipeEvent({ type: 'cancel', pipeId }, pid);

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
): Promise<{ ok: boolean; error?: string; code?: string; message?: ChatMessage; myWorkComplete?: boolean; pendingStages?: number }> {
  // Validate and store in the pipe stage store
  const result = pipeStore.submitStage(pipeId, from, content, projectId, true);
  if (!result.ok) return { ok: false, error: result.error, code: result.code };

  // Clear the stage deadline and delivery tracking — submit was successful
  pipeDelivery.recordSubmission(pipeId, from, projectId);
  // Complete the active assignment for this participant on this pipe
  const activeAssignments = materializer.getActiveAssignmentsForParticipant(from, pipeId, projectId);
  for (const a of activeAssignments) {
    materializer.completeAssignment(a.assignmentId, projectId);
  }
  clearStageDeadline(pipeId, from);
  provenance.recordProvenance(projectId, { pipeId, event: 'stage-submitted', actor: from, actorKind: getParticipant(from, projectId)?.kind ?? 'llm', stage: result.slot?.stage, role: result.slot?.role });

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

  // Emit non-final stage submissions as pipe-step events — NOT as chat:message.
  // The completion handler is the sole emitter of the public final result via chat:message.
  const body = ensurePipeAnchor(content, pipeId);
  const msg: import('../types.js').ChatMessage = {
    id: `pipe-${pipeId}-${role}-${from}`,
    ts: new Date().toISOString(),
    from,
    to: null,
    body,
    type: 'message',
    pipe: pipeMeta,
  };
  if (role !== 'final') {
    emitPipeEvent({ type: 'stage-output', pipeId, from, role, stage: slot?.stage, content: body }, projectId);
  }

  // Run the reducer to advance the pipeline
  await runPipeReducer(pipeId, projectId);

  // Lease was released by submitStage — drain pending queues to unblock
  // any pipes that were waiting for this participant's lease.
  drainPendingPipes([from], projectId);

  // Check if the submitter has remaining unsubmitted slots in this pipe
  const updatedPipe = pipeStore.getPipe(pipeId, projectId);
  const assigneeSlots = updatedPipe?.slots.get(from) ?? [];
  const pendingSlots = assigneeSlots.filter(s => s.status !== 'submitted');
  const myWorkComplete = pendingSlots.length === 0;
  const pendingStages = pendingSlots.length;

  return { ok: true, message: msg, myWorkComplete, pendingStages };
}

/** Get pipe status from the store. */
export function getPipeStoreStatus(pipeId: string, projectId?: string | null) {
  return pipeStore.getPipeStatus(pipeId, resolveProjectId(projectId));
}

/** Get active pipes for a project (from pipe store). */
export function getActivePipes(projectId?: string | null): Array<{ pipeId: string; mode: string; status: string }> {
  const pid = resolveProjectId(projectId);
  return pipeStore.listActivePipes(pid).map(p => ({ pipeId: p.pipeId, mode: p.mode, status: p.status }));
}

/** Get a specific pipe's state (from pipe store). */
export function getPipeRun(pipeId: string, projectId?: string | null): { pipeId: string; mode: string; status: string; projectId: string | null } | undefined {
  const pid = resolveProjectId(projectId);
  const pipe = pipeStore.getPipe(pipeId, pid);
  if (!pipe) return undefined;
  return { pipeId: pipe.pipeId, mode: pipe.mode, status: pipe.status, projectId: pid };
}

// ── Pipe assignment queries (caller-scoped) ──────────────────────────────────

/** List all assignments for a participant. */
export function listAssignments(callerName: string, projectId?: string | null) {
  const pid = resolveProjectId(projectId);
  return assignmentQueries.getAssignmentsForParticipant(callerName, pid);
}

/** Get assignment details for a participant on a specific pipe. */
export function getAssignment(pipeId: string, callerName: string, projectId?: string | null) {
  const pid = resolveProjectId(projectId);
  return assignmentQueries.getAssignmentForPipe(pipeId, callerName, pid);
}

// ── Pipe output read (caller-scoped) ──────────────────────────────────────────

export interface PipeReadOutputResult {
  pipeId: string;
  mode: string;
  stagePayload?: string | null;
  previousOutput?: { stage: number; from: string; content: string } | null;
  fanOutOutputs?: Array<{ from: string; content: string }>;
}

/** Read the pipe output that the caller is entitled to right now.
 *  Linear pipes: returns previous stage output for the current downstream assignee.
 *  Merge pipes: returns fan-out outputs for the synthesizer after synth-request. */
export function readPipeOutput(
  pipeId: string,
  callerName: string,
  projectId?: string | null,
): { ok: true; data: PipeReadOutputResult } | { ok: false; status: number; error: string } {
  const pid = resolveProjectId(projectId);
  const pipe = pipeStore.getPipe(pipeId, pid);
  if (!pipe) return { ok: false, status: 404, error: `Pipe #${pipeId} not found` };
  if (pipe.status !== 'running') {
    return { ok: false, status: 409, error: `Pipe #${pipeId} is ${pipe.status} — output reads are only allowed while the pipe is running` };
  }

  const assigneeIndex = pipe.assignees.indexOf(callerName);
  if (assigneeIndex === -1) {
    return { ok: false, status: 403, error: `${callerName} is not an assignee of pipe #${pipeId}` };
  }

  // Lease-aware read guard: reject reads from assignees with expired leases.
  // Must run BEFORE recordFetch so rejected reads don't suppress re-notify.
  const callerLease = pipeStore.getActiveLease(callerName, pid);
  if (callerLease?.pipeId === pipeId && pipeStore.isLeaseExpired(callerLease)) {
    return { ok: false, status: 403, error: `Lease for ${callerName} on pipe #${pipeId} has expired (deadline: ${callerLease.deadline}). Output read rejected.` };
  }

  // Record fetch acknowledgment — only after authorization succeeds
  pipeDelivery.recordFetch(pipeId, callerName, pid);

  // Transition assignment lifecycle: notified → payload_fetched
  const activeAssignments = materializer.getActiveAssignmentsForParticipant(callerName, pipeId, pid);
  for (const a of activeAssignments) {
    if (a.status === 'notified' || a.status === 'acknowledged') {
      materializer.transitionAssignmentStatus(a.assignmentId, a.status === 'notified' ? 'acknowledged' : 'payload_fetched', pid);
      // If we went notified→acknowledged, also advance to payload_fetched
      if (a.status === 'notified') {
        materializer.transitionAssignmentStatus(a.assignmentId, 'payload_fetched', pid);
      }
    }
  }

  // Read the authoritative assignment payload for this caller on this pipe.
  const currentAssignment = activeAssignments.find(a => a.assignee === callerName) ?? null;
  const stagePayload = currentAssignment
    ? (payloadStore.getPayload(currentAssignment.payloadId, pid)?.content ?? null)
    : null;

  if (pipe.mode === 'linear') {
    const callerStage = assigneeIndex + 1;
    if (callerStage === 1) {
      if (!stagePayload) {
        return { ok: false, status: 409, error: 'Stage 1 has no previous input to read' };
      }
      return { ok: true, data: { pipeId: pipe.pipeId, mode: pipe.mode, stagePayload, previousOutput: null } };
    }
    if (!pipe.emittedHandoffs.has(callerStage)) {
      return { ok: false, status: 409, error: `Handoff for stage ${callerStage} has not been emitted yet` };
    }
    const prevStage = callerStage - 1;
    const output = pipeStore.getStageOutput(pipeId, prevStage, pid);
    if (!output) {
      return { ok: false, status: 409, error: `Stage ${prevStage} output not yet submitted` };
    }
    return {
      ok: true,
      data: {
        pipeId: pipe.pipeId,
        mode: pipe.mode,
        stagePayload,
        previousOutput: { stage: prevStage, from: output.from, content: output.body },
      },
    };
  }

  // merge / merge-all / explain / summarize
  if (currentAssignment?.role === 'fan-out') {
    if (!stagePayload) {
      return { ok: false, status: 409, error: 'No stage input available for your fan-out assignment' };
    }
    return {
      ok: true,
      data: { pipeId: pipe.pipeId, mode: pipe.mode, stagePayload, previousOutput: null },
    };
  }

  const synthesizer = pipe.assignees[pipe.assignees.length - 1];
  if (callerName !== synthesizer) {
    return { ok: false, status: 403, error: `Only the synthesizer (@${synthesizer}) can read fan-out outputs` };
  }
  if (!pipe.emittedSynthRequest) {
    return { ok: false, status: 409, error: 'Synth request has not been emitted yet' };
  }
  const isMergeAll = pipe.mode === 'merge-all' || pipe.mode === 'explain' || pipe.mode === 'summarize';
  const outputs = pipeStore.getFanOutOutputs(pipeId, pid);
  const fanOutOutputs: Array<{ from: string; content: string }> = [];
  for (const [assignee, content] of outputs) {
    if (isMergeAll && assignee === synthesizer) continue;
    fanOutOutputs.push({ from: assignee, content });
  }
  return {
    ok: true,
    data: { pipeId: pipe.pipeId, mode: pipe.mode, stagePayload, fanOutOutputs },
  };
}

// ── Brainstorm command handling ───────────────────────────────────────────────

async function handleBrainstormCommand(body: string, projectId: string | null): Promise<ChatMessage> {
  const parsed = parseBrainstormCommand(body, (name) => getParticipantExact(name, projectId) != null);
  if ('error' in parsed) {
    const userMsg = appendMessage({ from: 'user', to: null, body, type: 'message' }, projectId);
    emitToProject('chat:message', userMsg, projectId);
    const errorMsg = appendMessage({
      from: 'system', to: null,
      body: `Brainstorm error: ${parsed.error}`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', errorMsg, projectId);
    return userMsg;
  }

  const userMsg = appendMessage({ from: 'user', to: null, body, type: 'message' }, projectId);
  emitToProject('chat:message', userMsg, projectId);

  // Resolve assignees (default to all active LLMs if none specified)
  const resolvedAssignees = parsed.assignees.length > 0
    ? parsed.assignees
    : listDefaultPipeAssignees(projectId).map(p => p.name);

  if (resolvedAssignees.length < 2) {
    const detail = parsed.assignees.length === 0
      ? ' No eligible default LLM assignees were available.'
      : '';
    const errorMsg = appendMessage({
      from: 'system', to: null,
      body: `Brainstorm error: at least 2 LLM participants are required.${detail}`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', errorMsg, projectId);
    return userMsg;
  }

  // Validate assignees are connected LLMs
  const invalid: string[] = [];
  const reasons: string[] = [];
  for (const a of resolvedAssignees) {
    const p = getParticipantExact(a, projectId);
    if (!p) { invalid.push(a); reasons.push(`@${a} not found`); continue; }
    if (p.kind !== 'llm') { invalid.push(a); reasons.push(`@${a} is not an LLM`); continue; }
    if (p.detached) { invalid.push(a); reasons.push(`@${a} is detached`); continue; }
    if (!p.paneId) { invalid.push(a); reasons.push(`@${a} has no pane`); continue; }
  }
  if (invalid.length > 0) {
    const errorMsg = appendMessage({
      from: 'system', to: null,
      body: `Brainstorm error: invalid assignees (${reasons.join('; ')}).`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', errorMsg, projectId);
    return userMsg;
  }

  // Create brainstorm record
  const brainstormId = pipeReducer.generatePipeId();
  brainstormStore.createBrainstorm(brainstormId, resolvedAssignees, parsed.prompt, projectId);

  const assigneeList = resolvedAssignees.map(a => `@${a}`).join(', ');
  const startMsg = appendMessage({
    from: 'system', to: null,
    body: `#brainstorm-${brainstormId} Brainstorm started: ${assigneeList}\nTopic: ${parsed.prompt}\nPhase: Ideas`,
    type: 'system',
  }, projectId);
  emitToProject('chat:message', startMsg, projectId);

  // Launch the first idea round (merge-all child pipe)
  await launchBrainstormIdeaRound(brainstormId, projectId);

  return userMsg;
}

/** Launch (or re-launch on retry) a merge-all child pipe for the brainstorm idea phase. */
async function launchBrainstormIdeaRound(brainstormId: string, projectId: string | null): Promise<void> {
  const record = brainstormStore.getBrainstorm(brainstormId, projectId);
  if (!record) return;

  const prompt = record.latestUserNote
    ? `${record.prompt}\n\nUser note: ${record.latestUserNote}`
    : record.prompt;

  const childPipeId = pipeReducer.generatePipeId();
  pipeStore.createPipe(childPipeId, 'merge-all', record.assignees, prompt, projectId);
  brainstormStore.linkChildPipe(brainstormId, childPipeId, projectId);
  brainstormStore.updateBrainstorm(brainstormId, projectId, {
    activeChildPipeId: childPipeId,
    phase: 'ideas',
    ideaIterations: record.ideaIterations + 1,
  });

  const desc = pipeReducer.getStartDescription({ mode: 'merge-all', assignees: record.assignees, prompt });
  const pipeStartMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${childPipeId} Pipe started (merge-all): ${desc}`,
    type: 'system',
    pipe: { pipeId: childPipeId, mode: 'merge-all' as const, role: 'start' as const, assignees: record.assignees, prompt },
  }, projectId);
  emitToProject('chat:message', pipeStartMsg, projectId);
  emitPipeEvent({
    type: 'start', pipeId: childPipeId, mode: 'merge-all',
    assignees: record.assignees, prompt,
    stageTimeoutMs: pipeStore.DEFAULT_STAGE_TIMEOUT_MS,
    timeoutPolicy: 'fail',
  }, projectId);

  await runPipeReducer(childPipeId, projectId);
}

/** Called when a child pipe completes — advances the brainstorm phase if applicable. */
async function advanceBrainstormOnChildComplete(childPipeId: string, projectId: string | null): Promise<void> {
  const record = brainstormStore.findBrainstormByChildPipe(childPipeId, projectId);
  if (!record || record.activeChildPipeId !== childPipeId) return;

  if (record.phase === 'ideas') {
    const finalOutput = readFinalOutput(childPipeId, projectId);
    brainstormStore.updateBrainstorm(record.id, projectId, {
      phase: 'ideas_review',
      activeChildPipeId: null,
      candidateIdea: finalOutput?.body ?? null,
    });

    const reviewMsg = appendMessage({
      from: 'system', to: null,
      body: `#brainstorm-${record.id} Ideas phase complete (iteration ${record.ideaIterations}).\nReview the merged idea above and choose:\n• Accept — advance to detail phase\n• Retry — rerun idea generation\n• Retry with note — add guidance and rerun`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', reviewMsg, projectId);
    return;
  }

  if (record.phase === 'details') {
    const finalOutput = readFinalOutput(childPipeId, projectId);
    brainstormStore.updateBrainstorm(record.id, projectId, {
      phase: 'details_review',
      activeChildPipeId: null,
      candidateDraft: finalOutput?.body ?? null,
    });

    const reviewMsg = appendMessage({
      from: 'system', to: null,
      body: `#brainstorm-${record.id} Detail pass complete (iteration ${record.detailIterations}).\nReview the detailed draft above and choose:\n• Finalize — accept draft and generate final output\n• Adjust — retry detail pass with guidance\n• Back to Ideas — return to idea phase`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', reviewMsg, projectId);
    return;
  }

  if (record.phase === 'finalizing') {
    brainstormStore.updateBrainstorm(record.id, projectId, {
      phase: 'complete',
      activeChildPipeId: null,
    });

    const completeMsg = appendMessage({
      from: 'system', to: null,
      body: `#brainstorm-${record.id} Brainstorm complete.`,
      type: 'system',
    }, projectId);
    emitToProject('chat:message', completeMsg, projectId);
  }
}

/** Re-launch the idea round with an optional user note (called by approve/retry endpoints). */
export async function brainstormRetryIdeas(brainstormId: string, userNote: string | null, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const record = brainstormStore.getBrainstorm(brainstormId, pid);
  if (!record || record.phase !== 'ideas_review') return false;

  brainstormStore.updateBrainstorm(brainstormId, pid, { latestUserNote: userNote });
  await launchBrainstormIdeaRound(brainstormId, pid);
  return true;
}

/** Accept the current idea and launch detail phase (linear child pipe). */
export async function brainstormAcceptIdea(brainstormId: string, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const record = brainstormStore.getBrainstorm(brainstormId, pid);
  if (!record || record.phase !== 'ideas_review') return false;

  brainstormStore.updateBrainstorm(brainstormId, pid, {
    acceptedIdea: record.candidateIdea,
    candidateIdea: null,
    latestUserNote: null,
  });

  const acceptMsg = appendMessage({
    from: 'system', to: null,
    body: `#brainstorm-${brainstormId} Idea accepted. Advancing to detail phase.`,
    type: 'system',
  }, pid);
  emitToProject('chat:message', acceptMsg, pid);

  await launchBrainstormDetailRound(brainstormId, pid);
  return true;
}

/** Launch (or re-launch on adjust) a linear child pipe for the brainstorm detail phase. */
async function launchBrainstormDetailRound(brainstormId: string, projectId: string | null): Promise<void> {
  const record = brainstormStore.getBrainstorm(brainstormId, projectId);
  if (!record) return;

  let prompt = `Brainstorm detail phase — deepen the following accepted idea:\n\n${record.acceptedIdea}\n\nAdd implementation details, architecture considerations, trade-offs, and concrete next steps.`;
  if (record.latestUserNote) {
    prompt += `\n\nUser note: ${record.latestUserNote}`;
  }

  const childPipeId = pipeReducer.generatePipeId();
  pipeStore.createPipe(childPipeId, 'linear', record.assignees, prompt, projectId);
  brainstormStore.linkChildPipe(brainstormId, childPipeId, projectId);
  brainstormStore.updateBrainstorm(brainstormId, projectId, {
    activeChildPipeId: childPipeId,
    phase: 'details',
    detailIterations: record.detailIterations + 1,
  });

  const desc = pipeReducer.getStartDescription({ mode: 'linear', assignees: record.assignees, prompt });
  const pipeStartMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${childPipeId} Pipe started (linear): ${desc}`,
    type: 'system',
    pipe: { pipeId: childPipeId, mode: 'linear' as const, role: 'start' as const, assignees: record.assignees, prompt },
  }, projectId);
  emitToProject('chat:message', pipeStartMsg, projectId);
  emitPipeEvent({
    type: 'start', pipeId: childPipeId, mode: 'linear',
    assignees: record.assignees, prompt,
    stageTimeoutMs: pipeStore.DEFAULT_STAGE_TIMEOUT_MS,
    timeoutPolicy: 'fail',
  }, projectId);

  await runPipeReducer(childPipeId, projectId);
}

/** Launch the finalize pass — single LLM produces the final structured output. */
async function launchBrainstormFinalizeRound(brainstormId: string, projectId: string | null): Promise<void> {
  const record = brainstormStore.getBrainstorm(brainstormId, projectId);
  if (!record) return;

  const prompt = `Brainstorm finalize — produce the final comprehensive document.\n\nAccepted Idea:\n${record.acceptedIdea}\n\nAccepted Detail Draft:\n${record.acceptedDraft}\n\nCreate a complete, structured output covering: concept, architecture, trade-offs, decisions, and next steps.`;

  // Use a single assignee (first in list) for the final pass
  const finalAssignees = [record.assignees[0]];
  const childPipeId = pipeReducer.generatePipeId();
  pipeStore.createPipe(childPipeId, 'linear', finalAssignees, prompt, projectId);
  brainstormStore.linkChildPipe(brainstormId, childPipeId, projectId);
  brainstormStore.updateBrainstorm(brainstormId, projectId, {
    activeChildPipeId: childPipeId,
    phase: 'finalizing',
  });

  const desc = pipeReducer.getStartDescription({ mode: 'linear', assignees: finalAssignees, prompt });
  const pipeStartMsg = appendMessage({
    from: 'system', to: null,
    body: `#pipe-${childPipeId} Pipe started (linear): ${desc}`,
    type: 'system',
    pipe: { pipeId: childPipeId, mode: 'linear' as const, role: 'start' as const, assignees: finalAssignees, prompt },
  }, projectId);
  emitToProject('chat:message', pipeStartMsg, projectId);
  emitPipeEvent({
    type: 'start', pipeId: childPipeId, mode: 'linear',
    assignees: finalAssignees, prompt,
    stageTimeoutMs: pipeStore.DEFAULT_STAGE_TIMEOUT_MS,
    timeoutPolicy: 'fail',
  }, projectId);

  await runPipeReducer(childPipeId, projectId);
}

/** Adjust and retry the current detail pass with a user note. */
export async function brainstormAdjustDetails(brainstormId: string, userNote: string | null, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const record = brainstormStore.getBrainstorm(brainstormId, pid);
  if (!record || record.phase !== 'details_review') return false;

  brainstormStore.updateBrainstorm(brainstormId, pid, { latestUserNote: userNote, candidateDraft: null });
  await launchBrainstormDetailRound(brainstormId, pid);
  return true;
}

/** Accept the current detail draft and launch the finalize phase. */
export async function brainstormFinalize(brainstormId: string, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const record = brainstormStore.getBrainstorm(brainstormId, pid);
  if (!record || record.phase !== 'details_review') return false;

  brainstormStore.updateBrainstorm(brainstormId, pid, {
    acceptedDraft: record.candidateDraft,
    candidateDraft: null,
  });

  const acceptMsg = appendMessage({
    from: 'system', to: null,
    body: `#brainstorm-${brainstormId} Details accepted. Generating final output.`,
    type: 'system',
  }, pid);
  emitToProject('chat:message', acceptMsg, pid);

  await launchBrainstormFinalizeRound(brainstormId, pid);
  return true;
}

/** Go back to ideas phase from detail review. */
export async function brainstormBackToIdeas(brainstormId: string, projectId?: string | null): Promise<boolean> {
  const pid = resolveProjectId(projectId);
  const record = brainstormStore.getBrainstorm(brainstormId, pid);
  if (!record || record.phase !== 'details_review') return false;

  brainstormStore.updateBrainstorm(brainstormId, pid, {
    phase: 'ideas_review',
    candidateDraft: null,
    acceptedDraft: null,
    latestUserNote: null,
  });

  const backMsg = appendMessage({
    from: 'system', to: null,
    body: `#brainstorm-${brainstormId} Returning to ideas phase. Review the idea and choose: Accept, Retry, or Retry with note.`,
    type: 'system',
  }, pid);
  emitToProject('chat:message', backMsg, pid);
  return true;
}

// ── Brainstorm accessors ─────────────────────────────────────────────────────

export function getBrainstormRecord(id: string, projectId?: string | null) {
  return brainstormStore.getBrainstorm(id, resolveProjectId(projectId));
}

export function getActiveBrainstorms(projectId?: string | null) {
  return brainstormStore.listActiveBrainstorms(resolveProjectId(projectId));
}

// ── Pipe observability ──────────────────────────────────────────────────────

export function getPipeTimingSummary(pipeId: string, projectId?: string | null) {
  return pipeStore.getPipeTimingSummary(pipeId, resolveProjectId(projectId));
}
export function getRuntimeLeaseStatuses(projectId?: string | null) {
  return pipeStore.getRuntimeLeaseStatuses(resolveProjectId(projectId));
}
export function getDeadLetterEntries(projectId?: string | null) {
  return pipeStore.getDeadLetterEntries(resolveProjectId(projectId));
}
export function listAllPipes(projectId?: string | null) {
  return pipeStore.listAllPipes(resolveProjectId(projectId));
}
export function getPipeProvenance(pipeId: string, projectId?: string | null) {
  return provenance.getProvenanceForPipe(pipeId, resolveProjectId(projectId));
}
export function queryPipeProvenance(
  projectId?: string | null,
  filters?: { pipeId?: string; actor?: string; event?: string; since?: string },
) {
  return provenance.queryProvenance(resolveProjectId(projectId), filters as Parameters<typeof provenance.queryProvenance>[1]);
}
