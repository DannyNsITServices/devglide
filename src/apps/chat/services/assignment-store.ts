import { randomUUID } from 'crypto';
import type { PipeMode, AssignmentStatus } from '../types.js';
import { TERMINAL_ASSIGNMENT_STATUSES, ASSIGNMENT_TRANSITIONS } from '../types.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A durable assignment representing a unit of work for a pipe stage.
 *  Assignments replace implicit one-shot delivery with a trackable entity
 *  that has its own lifecycle, survives reconnects, and supports reassignment. */
export interface Assignment {
  assignmentId: string;       // stable UUID — immutable once created
  pipeId: string;
  stageId: string;            // structured: "linear:1", "fan-out:alice", "synth"
  payloadId: string;          // references the authoritative payload in payload-store
  assignee: string;           // current participant name
  role: 'stage-output' | 'fan-out' | 'final';
  stage?: number;             // 1-indexed for linear pipes
  status: AssignmentStatus;
  attempt: number;            // starts at 1, increments on retry (same assignee)
  version: number;            // optimistic concurrency — increments on every mutation

  // Timestamps (ISO 8601)
  createdAt: string;
  notifiedAt: string | null;
  acknowledgedAt: string | null;
  fetchedAt: string | null;
  submittedAt: string | null;
  expiredAt: string | null;
  reassignedAt: string | null;
  cancelledAt: string | null;

  // Reassignment chain — links assignments that replace each other
  supersededBy: string | null;  // assignmentId of the replacement
  supersedes: string | null;    // assignmentId this replaces
  reassignReason: string | null;
}

/** Error codes for assignment operations. */
export type AssignmentErrorCode =
  | 'ASSIGNMENT_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'ASSIGNMENT_TERMINAL'
  | 'DUPLICATE_ACTIVE';

/** Result of an assignment operation. */
export interface AssignmentResult {
  ok: boolean;
  error?: string;
  code?: AssignmentErrorCode;
  assignment?: Assignment;
}

/** Compact notification envelope — the minimal info sent via PTY instead of full payload. */
export interface AssignmentNotification {
  assignmentId: string;
  pipeId: string;
  stageId: string;
  role: 'stage-output' | 'fan-out' | 'final';
  stage?: number;
  attempt: number;
  payloadId: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

// projectId -> (assignmentId -> Assignment)
const stores = new Map<string | null, Map<string, Assignment>>();

// projectId -> (pipeId:stageId -> assignmentId)  — index for active assignment per stage
const activeIndex = new Map<string | null, Map<string, string>>();

// projectId -> (assigneeName -> Set<assignmentId>)  — index for assignments per participant
const participantIndex = new Map<string | null, Map<string, Set<string>>>();

let clock: Clock = systemClock;

/** Override the clock used for timestamps (for testing). */
export function setClock(c: Clock): void {
  clock = c;
}

function getProjectStore(projectId: string | null): Map<string, Assignment> {
  let store = stores.get(projectId);
  if (!store) { store = new Map(); stores.set(projectId, store); }
  return store;
}

function getActiveIndex(projectId: string | null): Map<string, string> {
  let index = activeIndex.get(projectId);
  if (!index) { index = new Map(); activeIndex.set(projectId, index); }
  return index;
}

function getParticipantIndex(projectId: string | null): Map<string, Set<string>> {
  let index = participantIndex.get(projectId);
  if (!index) { index = new Map(); participantIndex.set(projectId, index); }
  return index;
}

function activeKey(pipeId: string, stageId: string): string {
  return `${pipeId}:${stageId}`;
}

function addToParticipantIndex(assignee: string, assignmentId: string, projectId: string | null): void {
  const index = getParticipantIndex(projectId);
  let ids = index.get(assignee);
  if (!ids) { ids = new Set(); index.set(assignee, ids); }
  ids.add(assignmentId);
}

function removeFromParticipantIndex(assignee: string, assignmentId: string, projectId: string | null): void {
  const index = getParticipantIndex(projectId);
  const ids = index.get(assignee);
  if (ids) {
    ids.delete(assignmentId);
    if (ids.size === 0) index.delete(assignee);
  }
}

// ── Stage ID derivation ───────────────────────────────────────────────────────

/** Derive a structured stageId from pipe mode and role.
 *  Format: "linear:<N>", "fan-out:<assignee>", "synth" */
export function deriveStageId(
  mode: PipeMode,
  role: 'stage-output' | 'fan-out' | 'final',
  opts?: { stage?: number; assignee?: string },
): string {
  if (mode === 'linear') return `linear:${opts?.stage ?? 0}`;
  if (role === 'fan-out') return `fan-out:${opts?.assignee ?? 'unknown'}`;
  return 'synth';
}

// ── Assignment lifecycle ──────────────────────────────────────────────────────

/** Create a new assignment for a pipe stage.
 *  If an active assignment already exists for this pipe+stageId, returns an error
 *  unless it has been superseded/reassigned. */
export function createAssignment(
  pipeId: string,
  stageId: string,
  payloadId: string,
  assignee: string,
  role: 'stage-output' | 'fan-out' | 'final',
  projectId: string | null,
  opts?: { stage?: number; supersedes?: string },
): AssignmentResult {
  const store = getProjectStore(projectId);
  const aIndex = getActiveIndex(projectId);
  const key = activeKey(pipeId, stageId);

  // Check for existing active assignment on this stage
  const existingId = aIndex.get(key);
  if (existingId) {
    const existing = store.get(existingId);
    if (existing && !TERMINAL_ASSIGNMENT_STATUSES.has(existing.status)) {
      return {
        ok: false,
        code: 'DUPLICATE_ACTIVE',
        error: `Active assignment ${existingId} already exists for ${key}`,
      };
    }
  }

  const attempt = opts?.supersedes
    ? (store.get(opts.supersedes)?.attempt ?? 0) + 1
    : 1;

  const assignment: Assignment = {
    assignmentId: randomUUID(),
    pipeId,
    stageId,
    payloadId,
    assignee,
    role,
    stage: opts?.stage,
    status: 'assigned',
    attempt,
    version: 1,
    createdAt: clock.isoNow(),
    notifiedAt: null,
    acknowledgedAt: null,
    fetchedAt: null,
    submittedAt: null,
    expiredAt: null,
    reassignedAt: null,
    cancelledAt: null,
    supersededBy: null,
    supersedes: opts?.supersedes ?? null,
    reassignReason: null,
  };

  store.set(assignment.assignmentId, assignment);
  aIndex.set(key, assignment.assignmentId);
  addToParticipantIndex(assignee, assignment.assignmentId, projectId);

  return { ok: true, assignment: { ...assignment } };
}

/** Transition an assignment to a new status.
 *  Validates the transition against the state machine and increments the version.
 *  Optionally checks the expected version for optimistic concurrency. */
export function transitionAssignment(
  assignmentId: string,
  newStatus: AssignmentStatus,
  projectId: string | null,
  opts?: { expectedVersion?: number },
): AssignmentResult {
  const store = getProjectStore(projectId);
  const assignment = store.get(assignmentId);
  if (!assignment) {
    return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', error: `Assignment ${assignmentId} not found` };
  }

  if (TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) {
    return {
      ok: false,
      code: 'ASSIGNMENT_TERMINAL',
      error: `Assignment ${assignmentId} is in terminal status '${assignment.status}'`,
    };
  }

  const allowed = ASSIGNMENT_TRANSITIONS[assignment.status];
  if (!allowed.includes(newStatus)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      error: `Cannot transition from '${assignment.status}' to '${newStatus}'`,
    };
  }

  if (opts?.expectedVersion !== undefined && opts.expectedVersion !== assignment.version) {
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      error: `Version conflict: expected ${opts.expectedVersion}, actual ${assignment.version}`,
    };
  }

  const now = clock.isoNow();
  assignment.status = newStatus;
  assignment.version++;

  // Set the corresponding timestamp
  switch (newStatus) {
    case 'notified':      assignment.notifiedAt = now; break;
    case 'acknowledged':  assignment.acknowledgedAt = now; break;
    case 'payload_fetched': assignment.fetchedAt = now; break;
    case 'submitted':     assignment.submittedAt = now; break;
    case 'expired':       assignment.expiredAt = now; break;
    case 'reassigned':    assignment.reassignedAt = now; break;
    case 'cancelled':     assignment.cancelledAt = now; break;
  }

  // On terminal transition, remove from active index if this is the active assignment
  if (TERMINAL_ASSIGNMENT_STATUSES.has(newStatus)) {
    const aIndex = getActiveIndex(projectId);
    const key = activeKey(assignment.pipeId, assignment.stageId);
    if (aIndex.get(key) === assignmentId) {
      aIndex.delete(key);
    }
  }

  return { ok: true, assignment: { ...assignment } };
}

/** Reassign an assignment to a different participant.
 *  Marks the current assignment as 'reassigned' and creates a new one for the new assignee.
 *  Returns both the old (reassigned) and new assignments. */
export function reassignAssignment(
  assignmentId: string,
  newAssignee: string,
  projectId: string | null,
  reason: string,
): { ok: true; old: Assignment; new: Assignment } | { ok: false; error: string; code?: AssignmentErrorCode } {
  const store = getProjectStore(projectId);
  const old = store.get(assignmentId);
  if (!old) {
    return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', error: `Assignment ${assignmentId} not found` };
  }

  if (TERMINAL_ASSIGNMENT_STATUSES.has(old.status)) {
    return {
      ok: false,
      code: 'ASSIGNMENT_TERMINAL',
      error: `Assignment ${assignmentId} is in terminal status '${old.status}'`,
    };
  }

  // Mark the old assignment as reassigned
  const now = clock.isoNow();
  old.status = 'reassigned';
  old.reassignedAt = now;
  old.reassignReason = reason;
  old.version++;

  // Remove from active index
  const aIndex = getActiveIndex(projectId);
  const key = activeKey(old.pipeId, old.stageId);
  aIndex.delete(key);

  // Create the replacement assignment
  const result = createAssignment(
    old.pipeId,
    old.stageId,
    old.payloadId,
    newAssignee,
    old.role,
    projectId,
    { stage: old.stage, supersedes: old.assignmentId },
  );

  if (!result.ok || !result.assignment) {
    // Roll back the old assignment
    old.status = 'assigned'; // restore — safe because we haven't updated chain yet
    old.reassignedAt = null;
    old.reassignReason = null;
    old.version--;
    aIndex.set(key, old.assignmentId);
    return { ok: false, error: result.error ?? 'Failed to create replacement assignment' };
  }

  // Link the chain
  old.supersededBy = result.assignment.assignmentId;
  const newAssignment = store.get(result.assignment.assignmentId)!;
  newAssignment.supersedes = old.assignmentId;

  return {
    ok: true,
    old: { ...old },
    new: { ...newAssignment },
  };
}

/** Cancel all non-terminal assignments for a pipe.
 *  Called when a pipe is cancelled or failed. Returns cancelled assignmentIds. */
export function cancelPipeAssignments(pipeId: string, projectId: string | null): string[] {
  const store = getProjectStore(projectId);
  const cancelled: string[] = [];

  for (const assignment of store.values()) {
    if (assignment.pipeId !== pipeId) continue;
    if (TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) continue;

    assignment.status = 'cancelled';
    assignment.cancelledAt = clock.isoNow();
    assignment.version++;
    cancelled.push(assignment.assignmentId);

    // Remove from active index
    const aIndex = getActiveIndex(projectId);
    const key = activeKey(assignment.pipeId, assignment.stageId);
    if (aIndex.get(key) === assignment.assignmentId) {
      aIndex.delete(key);
    }
  }

  return cancelled;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Get an assignment by ID. */
export function getAssignment(assignmentId: string, projectId: string | null): Assignment | undefined {
  return getProjectStore(projectId).get(assignmentId);
}

/** Get the currently active (non-terminal) assignment for a pipe stage.
 *  Returns undefined if no active assignment exists. */
export function getActiveAssignment(
  pipeId: string,
  stageId: string,
  projectId: string | null,
): Assignment | undefined {
  const aIndex = getActiveIndex(projectId);
  const id = aIndex.get(activeKey(pipeId, stageId));
  if (!id) return undefined;
  const assignment = getProjectStore(projectId).get(id);
  if (!assignment || TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) return undefined;
  return assignment;
}

/** List all assignments for a pipe (including terminal ones for audit trail). */
export function getAssignmentsByPipe(pipeId: string, projectId: string | null): Assignment[] {
  const store = getProjectStore(projectId);
  const result: Assignment[] = [];
  for (const assignment of store.values()) {
    if (assignment.pipeId === pipeId) result.push(assignment);
  }
  return result;
}

/** Get all active (non-terminal) assignments for a participant.
 *  Used for reconnect recovery — the participant can see what work is pending. */
export function getActiveAssignmentsForParticipant(
  assignee: string,
  projectId: string | null,
): Assignment[] {
  const pIndex = getParticipantIndex(projectId);
  const ids = pIndex.get(assignee);
  if (!ids) return [];
  const store = getProjectStore(projectId);
  const result: Assignment[] = [];
  for (const id of ids) {
    const assignment = store.get(id);
    if (assignment && !TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) {
      result.push(assignment);
    }
  }
  return result;
}

/** Get the full reassignment chain for an assignment (oldest first).
 *  Follows the supersedes chain backward to the original assignment. */
export function getAssignmentChain(assignmentId: string, projectId: string | null): Assignment[] {
  const store = getProjectStore(projectId);
  const chain: Assignment[] = [];

  // Walk backward to find the root
  let current = store.get(assignmentId);
  const visited = new Set<string>();
  while (current && !visited.has(current.assignmentId)) {
    visited.add(current.assignmentId);
    chain.unshift(current);
    if (current.supersedes) {
      current = store.get(current.supersedes);
    } else {
      break;
    }
  }

  // Walk forward from root to find any successors not yet in the chain
  let last = chain[chain.length - 1];
  while (last?.supersededBy) {
    const next = store.get(last.supersededBy);
    if (!next || visited.has(next.assignmentId)) break;
    visited.add(next.assignmentId);
    chain.push(next);
    last = next;
  }

  return chain;
}

/** Build a compact notification envelope from an assignment. */
export function toNotification(assignment: Assignment): AssignmentNotification {
  return {
    assignmentId: assignment.assignmentId,
    pipeId: assignment.pipeId,
    stageId: assignment.stageId,
    role: assignment.role,
    stage: assignment.stage,
    attempt: assignment.attempt,
    payloadId: assignment.payloadId,
  };
}

/** Check whether an assignment is stale (has been reassigned or superseded).
 *  Stale assignments can still be read but not progressed. */
export function isStale(assignmentId: string, projectId: string | null): boolean {
  const assignment = getProjectStore(projectId).get(assignmentId);
  if (!assignment) return true;
  return assignment.status === 'reassigned' || assignment.status === 'superseded';
}

/** Check if a fetch/ack on a stale assignment should be silently accepted or rejected.
 *  After reassignment: ack/fetch are silently dropped (no error to the client).
 *  After cancel/expire: rejected with an error. */
export function staleAccessPolicy(
  assignmentId: string,
  projectId: string | null,
): 'accept-silent' | 'reject' | 'ok' {
  const assignment = getProjectStore(projectId).get(assignmentId);
  if (!assignment) return 'reject';
  if (!TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) return 'ok';
  if (assignment.status === 'reassigned' || assignment.status === 'superseded') return 'accept-silent';
  return 'reject';
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/** Default retention for terminal assignments: 24 hours. */
export const DEFAULT_ASSIGNMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Remove terminal assignments older than the given TTL.
 *  Returns the number of assignments removed. */
export function cleanupTerminalAssignments(
  projectId: string | null,
  ttlMs: number = DEFAULT_ASSIGNMENT_TTL_MS,
): number {
  const store = getProjectStore(projectId);
  const now = clock.now();
  let removed = 0;

  for (const [id, assignment] of store) {
    if (!TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) continue;

    // Use the terminal timestamp for TTL calculation
    const terminalTs = assignment.submittedAt
      ?? assignment.expiredAt
      ?? assignment.reassignedAt
      ?? assignment.cancelledAt
      ?? assignment.createdAt;

    if (now - new Date(terminalTs).getTime() >= ttlMs) {
      store.delete(id);
      removeFromParticipantIndex(assignment.assignee, id, projectId);
      removed++;
    }
  }

  return removed;
}

/** Get all projectIds that have assignment data in the store. */
export function getTrackedProjectIds(): Array<string | null> {
  return [...stores.keys()];
}

// ── Recovery ──────────────────────────────────────────────────────────────────

/** Assignment recovery event — persisted to JSONL for rehydration. */
export interface AssignmentRecoveryEvent {
  type: 'assignment-created' | 'assignment-transitioned' | 'assignment-reassigned' | 'assignment-cancelled';
  assignmentId: string;
  pipeId: string;
  stageId: string;
  payloadId?: string;
  assignee?: string;
  role?: 'stage-output' | 'fan-out' | 'final';
  stage?: number;
  status?: AssignmentStatus;
  attempt?: number;
  supersedes?: string;
  newAssignee?: string;
  reason?: string;
  ts?: string;
}

/** Rehydrate assignment state from persisted events.
 *  Called on server restart. Returns assignmentIds that are still active. */
export function rehydrateFromEvents(
  events: AssignmentRecoveryEvent[],
  projectId: string | null,
): string[] {
  const active: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'assignment-created': {
        if (!event.payloadId || !event.assignee || !event.role) break;
        createAssignment(
          event.pipeId,
          event.stageId,
          event.payloadId,
          event.assignee,
          event.role,
          projectId,
          { stage: event.stage, supersedes: event.supersedes },
        );
        // Restore the assignmentId to match the persisted one
        const store = getProjectStore(projectId);
        const aIndex = getActiveIndex(projectId);
        const key = activeKey(event.pipeId, event.stageId);
        const generatedId = aIndex.get(key);
        if (generatedId && generatedId !== event.assignmentId) {
          const assignment = store.get(generatedId);
          if (assignment) {
            store.delete(generatedId);
            assignment.assignmentId = event.assignmentId;
            store.set(event.assignmentId, assignment);
            aIndex.set(key, event.assignmentId);
            // Fix participant index
            removeFromParticipantIndex(event.assignee, generatedId, projectId);
            addToParticipantIndex(event.assignee, event.assignmentId, projectId);
          }
        }
        break;
      }
      case 'assignment-transitioned': {
        if (!event.status) break;
        transitionAssignment(event.assignmentId, event.status, projectId);
        break;
      }
      case 'assignment-reassigned': {
        if (!event.newAssignee) break;
        reassignAssignment(event.assignmentId, event.newAssignee, projectId, event.reason ?? 'recovery');
        break;
      }
      case 'assignment-cancelled': {
        cancelPipeAssignments(event.pipeId, projectId);
        break;
      }
    }
  }

  // Collect active assignments
  const store = getProjectStore(projectId);
  for (const assignment of store.values()) {
    if (!TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) {
      active.push(assignment.assignmentId);
    }
  }

  return active;
}

// ── Test helper ───────────────────────────────────────────────────────────────

/** Reset all in-memory state. For testing only. */
export function _resetForTest(): void {
  stores.clear();
  activeIndex.clear();
  participantIndex.clear();
  clock = systemClock;
}
