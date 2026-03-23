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
const participantStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const panePromptWatchers = new Map<string, { dispose: () => void }>();

const PTY_SUBMIT_BASE_DELAY_MS = 500;
const PTY_SUBMIT_PER_CHAR_MS = 1;
const PTY_SUBMIT_MAX_DELAY_MS = 5000;
const PTY_RETRY_SUBMIT_DELAY_MS = 1000;
const PTY_CHUNK_SIZE = 1024;
const PTY_CHUNK_DELAY_MS = 50;
const PARTICIPANT_IDLE_TIMEOUT_MS = 30_000;
const PROMPT_QUIESCENCE_MS = 2000;

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

const STRIP_ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;

function stripAnsi(str: string): string {
  return str.replace(STRIP_ANSI_RE, '');
}

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
// Names are derived from model + pane display number (e.g. "claude-1", "codex-2").
// The pane's per-project `num` is used — not the global pane ID counter —
// so names are deterministic within each project context.

/** Look up the pane's per-project display number from dashboardState. */
function getPaneDisplayNumber(paneId: string | null): string | null {
  if (!paneId) return null;
  const pane = dashboardState.panes.find(p => p.id === paneId);
  return pane ? String(pane.num) : null;
}

/** Derive a name from model + pane display number (e.g. "claude-1"). */
function deriveUniqueName(hint: string, model: string | null, paneId: string | null, projectId: string | null): string {
  const base = (model || hint || 'agent').toLowerCase().replace(/[^a-z0-9-]/g, '');
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
function updatePaneTitle(paneId: string, chatName: string): void {
  const pane = dashboardState.panes.find(p => p.id === paneId);
  if (!pane) return;
  pane.chatName = chatName;
  pane.title = `${pane.num}: ${chatName}`;
  // Notify shell page to update the tab (separate from terminal:cwd so CWD changes don't overwrite)
  getShellNsp()?.emit('state:pane-chat-name', { id: paneId, chatName });
}

/** Find an existing participant that can be reclaimed by projectId + paneId + model. */
function findReclaimCandidate(paneId: string | null, model: string | null, projectId: string | null): ChatParticipant | null {
  if (!paneId) return null;
  for (const p of participants.values()) {
    if (p.paneId === paneId && p.model === model && p.projectId === projectId) return p;
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

  // Claim-or-create: try to reclaim an existing participant by paneId + model
  const existing = findReclaimCandidate(paneId, model, resolvedProjectId);
  if (existing) {
    // Reattach: keep the same alias, update session fields
    existing.detached = false;
    existing.submitKey = submitKey;
    existing.lastSeen = now;
    existing.status = 'idle';
    clearParticipantStatusTimer(existing.name, resolvedProjectId);
    bumpParticipantSessionEpoch(existing.name, resolvedProjectId);

    if (paneId) updatePaneTitle(paneId, existing.name);

    const msg = appendMessage({
      from: existing.name,
      to: null,
      body: `${existing.name} reconnected${paneId ? ` (${paneId})` : ''}`,
      type: 'join',
    }, existing.projectId);
    emitToProject('chat:join', existing, existing.projectId);
    emitToProject('chat:message', msg, existing.projectId);

    if (paneId) startPanePromptWatcher(existing.name, existing.projectId, paneId);

    return existing;
  }

  // No reclaim candidate — derive name from model/identity
  const uniqueName = deriveUniqueName(name, model, paneId, resolvedProjectId);
  const participant: ChatParticipant = {
    name: uniqueName,
    kind,
    model,
    paneId,
    projectId: resolvedProjectId,
    submitKey,
    joinedAt: now,
    lastSeen: now,
    status: kind === 'llm' ? 'idle' : undefined,
    detached: false,
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

  if (paneId) startPanePromptWatcher(uniqueName, participant.projectId, paneId);

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
    clearParticipantStatusTimer(name, pid);
    stopPanePromptWatcher(participantKey(name, pid));
    participantSessionEpochs.delete(participantKey(name, pid));
    const msg = appendMessage({
      from: name,
      to: null,
      body: `${name} left`,
      type: 'leave',
    }, pid);
    emitToProject('chat:leave', { name }, pid);
    emitToProject('chat:message', msg, pid);
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
  return true;
}

function pruneStaleParticipants(): void {
  for (const participant of [...participants.values()]) {
    if (participant.kind !== 'llm' || !participant.paneId) continue;
    if (globalPtys.has(participant.paneId)) continue;
    // Pane is gone — full removal regardless of detached state
    leave(participant.name, participant.projectId);
  }
}

export function send(from: string, body: string, to?: string, projectId?: string | null): ChatMessage {
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
  }, resolvedSenderProjectId);

  // Emit to dashboard clients viewing this project only
  emitToProject('chat:message', msg, resolvedSenderProjectId);

  // PTY delivery — broadcast every message to all same-project participants except the sender.
  // `targets` remain semantic metadata for intent and UI display.
  for (const p of participants.values()) {
    if (p.name !== from && p.paneId && p.projectId === resolvedSenderProjectId) {
      deliverToPty(p.name, resolvedSenderProjectId, msg);
    }
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

function deliverToPty(targetName: string, projectId: string | null, msg: ChatMessage): void {
  const target = getParticipantExact(targetName, projectId);
  if (!target?.paneId || target.detached) return;

  const paneId = target.paneId;
  const sessionEpoch = currentParticipantSessionEpoch(targetName, projectId);
  const previous = paneDeliveryQueues.get(paneId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const liveTarget = getParticipantExact(targetName, projectId);
      if (!liveTarget?.paneId || liveTarget.detached || liveTarget.paneId !== paneId || currentParticipantSessionEpoch(targetName, projectId) !== sessionEpoch) return;

      const entry = globalPtys.get(paneId);
      if (!entry) {
        // Pane closed — unlink but keep participant
        liveTarget.paneId = null;
        return;
      }

      const formatted = `[DevGlide Chat] @${msg.from}: ${msg.body}`;

      // Write text in chunks to avoid PTY buffer overflow and crossterm
      // paste-burst detection issues with large messages. Revalidate
      // pane/session state between chunks so we stop writing if the
      // participant detaches or the pane closes mid-delivery.
      for (let offset = 0; offset < formatted.length; offset += PTY_CHUNK_SIZE) {
        if (offset > 0) {
          await new Promise((resolve) => setTimeout(resolve, PTY_CHUNK_DELAY_MS));
          const midTarget = getParticipantExact(targetName, projectId);
          if (!midTarget?.paneId || midTarget.detached || midTarget.paneId !== paneId || currentParticipantSessionEpoch(targetName, projectId) !== sessionEpoch) return;
          const midEntry = globalPtys.get(paneId);
          if (!midEntry) { midTarget.paneId = null; return; }
        }
        const chunk = formatted.slice(offset, offset + PTY_CHUNK_SIZE);
        const currentEntry = globalPtys.get(paneId);
        if (!currentEntry) return;
        currentEntry.ptyProcess.write(chunk);
      }

      // Adaptive delay before submit: scale with message length so crossterm
      // has time to finish processing the text before receiving CR.
      const submitDelay = Math.min(
        PTY_SUBMIT_BASE_DELAY_MS + formatted.length * PTY_SUBMIT_PER_CHAR_MS,
        PTY_SUBMIT_MAX_DELAY_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, submitDelay));

      const refreshed = getParticipantExact(targetName, projectId);
      if (!refreshed?.paneId || refreshed.detached || refreshed.paneId !== paneId || currentParticipantSessionEpoch(targetName, projectId) !== sessionEpoch) return;

      const refreshedEntry = globalPtys.get(paneId);
      if (!refreshedEntry) {
        refreshed.paneId = null;
        return;
      }

      refreshedEntry.ptyProcess.write(refreshed.submitKey);

      // Retry submit after additional delay — sometimes the first CR is swallowed
      // by TUI frameworks (e.g. crossterm paste-burst detection).
      await new Promise((resolve) => setTimeout(resolve, PTY_RETRY_SUBMIT_DELAY_MS));

      const retryTarget = getParticipantExact(targetName, projectId);
      if (!retryTarget?.paneId || retryTarget.detached || retryTarget.paneId !== paneId || currentParticipantSessionEpoch(targetName, projectId) !== sessionEpoch) return;

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

/** Clear chat history for the active project and notify dashboard clients. */
export function clearHistory(projectId?: string | null): void {
  const pid = resolveProjectId(projectId);
  clearMessages(pid);
  emitToProject('chat:cleared', {}, pid);
}

/** Handle pane closure — remove participants linked to this pane.
 *  Scoped by projectId to avoid removing participants from other projects
 *  that happen to share the same pane ID format. */
export function onPaneClosed(paneId: string, projectId?: string | null): void {
  for (const p of [...participants.values()]) {
    if (p.paneId === paneId && (projectId == null || p.projectId === projectId)) {
      leave(p.name, p.projectId);
    }
  }
}
