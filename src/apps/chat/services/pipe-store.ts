import type { PipeMode, PipeStatus } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipeSlot {
  assignee: string;
  role: 'stage-output' | 'fan-out' | 'final';
  stage?: number;               // 1-indexed, for linear pipes
  status: 'pending' | 'leased' | 'submitted';
  content: string | null;
  submittedAt: string | null;
}

export interface StoredPipe {
  pipeId: string;
  mode: PipeMode;
  assignees: string[];
  prompt: string;
  status: PipeStatus;
  slots: Map<string, PipeSlot[]>;  // keyed by assignee name
  createdAt: string;
}

export interface LeaseInfo {
  pipeId: string;
  assignee: string;
  slotRole: string;
  stage?: number;
  grantedAt: string;
}

export type PipeErrorCode =
  | 'PIPE_NOT_FOUND'
  | 'PIPE_CLOSED'
  | 'PIPE_NOT_ASSIGNED'
  | 'PIPE_LEASE_NOT_HELD'
  | 'PIPE_ALREADY_SUBMITTED'
  | 'PIPE_LEASE_CONFLICT';

export interface SubmitResult {
  ok: boolean;
  error?: string;
  code?: PipeErrorCode;
  slot?: PipeSlot;
  pipe?: { pipeId: string; mode: PipeMode; status: PipeStatus };
}

// ── Storage ───────────────────────────────────────────────────────────────────

// projectId -> (pipeId -> StoredPipe)
const stores = new Map<string | null, Map<string, StoredPipe>>();

// "projectId:assigneeName" -> LeaseInfo  (one active lease per participant)
const activeLeases = new Map<string, LeaseInfo>();

// "projectId:assigneeName" -> Set<pipeId>  (pipes waiting for this participant's lease to release)
const pendingPipes = new Map<string, Set<string>>();

// "projectId:assigneeName" -> Set<pipeId>  (index of active/running pipes per participant)
const activePipeIndex = new Map<string, Set<string>>();

function addToActivePipeIndex(assignee: string, projectId: string | null, pipeId: string): void {
  const key = leaseKey(assignee, projectId);
  let pipeIds = activePipeIndex.get(key);
  if (!pipeIds) { pipeIds = new Set(); activePipeIndex.set(key, pipeIds); }
  pipeIds.add(pipeId);
}

function removeFromActivePipeIndex(assignee: string, projectId: string | null, pipeId: string): void {
  const key = leaseKey(assignee, projectId);
  const pipeIds = activePipeIndex.get(key);
  if (pipeIds) {
    pipeIds.delete(pipeId);
    if (pipeIds.size === 0) activePipeIndex.delete(key);
  }
}

/** Get all running pipe IDs for a participant (O(1) lookup). */
export function getActivePipesForParticipant(assignee: string, projectId: string | null): string[] {
  const key = leaseKey(assignee, projectId);
  const pipeIds = activePipeIndex.get(key);
  return pipeIds ? [...pipeIds] : [];
}

function leaseKey(assignee: string, projectId: string | null): string {
  return `${projectId ?? '__none__'}:${assignee}`;
}

function getProjectStore(projectId: string | null): Map<string, StoredPipe> {
  let store = stores.get(projectId);
  if (!store) {
    store = new Map();
    stores.set(projectId, store);
  }
  return store;
}

// ── Pipe lifecycle ────────────────────────────────────────────────────────────

/** Create a new pipe in the store with slots for each assignee. */
export function createPipe(
  pipeId: string,
  mode: PipeMode,
  assignees: string[],
  prompt: string,
  projectId: string | null,
): StoredPipe {
  const store = getProjectStore(projectId);
  const slots = new Map<string, PipeSlot[]>();

  if (mode === 'linear') {
    for (let i = 0; i < assignees.length; i++) {
      const isLast = i === assignees.length - 1;
      slots.set(assignees[i], [{
        assignee: assignees[i],
        role: isLast ? 'final' : 'stage-output',
        stage: i + 1,
        status: 'pending',
        content: null,
        submittedAt: null,
      }]);
    }
  } else if (mode === 'merge') {
    // merge: fan-out assignees + last one is synthesizer
    const fanOutAssignees = assignees.slice(0, -1);
    const synthesizer = assignees[assignees.length - 1];
    for (const a of fanOutAssignees) {
      slots.set(a, [{
        assignee: a,
        role: 'fan-out',
        status: 'pending',
        content: null,
        submittedAt: null,
      }]);
    }
    slots.set(synthesizer, [{
      assignee: synthesizer,
      role: 'final',
      status: 'pending',
      content: null,
      submittedAt: null,
    }]);
  } else {
    // merge-all: ALL assignees get fan-out + last one gets final
    for (let i = 0; i < assignees.length; i++) {
      const a = assignees[i];
      const isLast = i === assignees.length - 1;
      const assigneeSlots: PipeSlot[] = [{
        assignee: a,
        role: 'fan-out',
        status: 'pending',
        content: null,
        submittedAt: null,
      }];
      if (isLast) {
        assigneeSlots.push({
          assignee: a,
          role: 'final',
          status: 'pending',
          content: null,
          submittedAt: null,
        });
      }
      slots.set(a, assigneeSlots);
    }
  }

  const pipe: StoredPipe = {
    pipeId,
    mode,
    assignees,
    prompt,
    status: 'running',
    slots,
    createdAt: new Date().toISOString(),
  };
  store.set(pipeId, pipe);

  // Populate active pipe index for all assignees
  for (const a of assignees) {
    addToActivePipeIndex(a, projectId, pipeId);
  }

  return pipe;
}

/** Get a pipe from the store. */
export function getPipe(pipeId: string, projectId: string | null): StoredPipe | undefined {
  return getProjectStore(projectId).get(pipeId);
}

/** Mark a pipe as completed, failed, or cancelled. Releases all leases for its assignees.
 *  Returns assignee names whose leases were released (callers should drain their pending queues). */
export function markPipeStatus(pipeId: string, status: PipeStatus, projectId: string | null): string[] {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return [];
  pipe.status = status;
  if (status !== 'running') {
    // Remove from active pipe index for all assignees
    for (const a of pipe.assignees) {
      removeFromActivePipeIndex(a, projectId, pipeId);
    }
    return releaseAllLeases(pipe, projectId);
  }
  return [];
}

// ── Lease management ──────────────────────────────────────────────────────────

/** Grant a lease to a participant for a specific pipe.
 *  A participant can only hold one active lease at a time.
 *  Returns error if the participant already holds a lease for a *different* pipe. */
export function grantLease(
  pipeId: string,
  assignee: string,
  projectId: string | null,
): { ok: boolean; error?: string; code?: PipeErrorCode; lease?: LeaseInfo } {
  const key = leaseKey(assignee, projectId);
  const existing = activeLeases.get(key);

  // Allow re-granting for the same pipe (idempotent)
  if (existing && existing.pipeId !== pipeId) {
    return {
      ok: false,
      code: 'PIPE_LEASE_CONFLICT',
      error: `${assignee} already holds a lease for pipe #${existing.pipeId}. ` +
        `Complete or release that pipe before starting pipe #${pipeId}.`,
    };
  }

  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return { ok: false, code: 'PIPE_NOT_FOUND', error: `Pipe #${pipeId} not found` };
  if (pipe.status !== 'running') return { ok: false, code: 'PIPE_CLOSED', error: `Pipe #${pipeId} is ${pipe.status}` };

  const assigneeSlots = pipe.slots.get(assignee);
  if (!assigneeSlots || assigneeSlots.length === 0) {
    return { ok: false, error: `${assignee} is not an assignee of pipe #${pipeId}` };
  }

  // Find the first pending or leased task for this assignee.
  // In merge-all, this will be fan-out first, then final.
  const slot = assigneeSlots.find(s => s.status === 'pending' || s.status === 'leased');
  if (!slot) return { ok: false, error: `${assignee} has no pending tasks for pipe #${pipeId}` };

  slot.status = 'leased';
  const lease: LeaseInfo = {
    pipeId,
    assignee,
    slotRole: slot.role,
    stage: slot.stage,
    grantedAt: new Date().toISOString(),
  };
  activeLeases.set(key, lease);
  return { ok: true, lease };
}

/** Release a participant's active lease. */
export function releaseLease(assignee: string, projectId: string | null): void {
  activeLeases.delete(leaseKey(assignee, projectId));
}

/** Get the active lease for a participant (if any). */
export function getActiveLease(assignee: string, projectId: string | null): LeaseInfo | undefined {
  return activeLeases.get(leaseKey(assignee, projectId));
}

/** Release all leases for a pipe's assignees. Returns names of assignees whose leases were released. */
function releaseAllLeases(pipe: StoredPipe, projectId: string | null): string[] {
  const released: string[] = [];
  for (const assignee of pipe.assignees) {
    const lease = getActiveLease(assignee, projectId);
    if (lease?.pipeId === pipe.pipeId) {
      releaseLease(assignee, projectId);
      released.push(assignee);
    }
  }
  return released;
}

// ── Pending pipe queue (for lease conflicts) ──────────────────────────────────

/** Record that a pipe is waiting for a participant's lease to be released.
 *  Pipes are drained in creation-time order (oldest first). */
export function addPendingPipe(assignee: string, projectId: string | null, pipeId: string): void {
  const key = leaseKey(assignee, projectId);
  let pending = pendingPipes.get(key);
  if (!pending) { pending = new Set(); pendingPipes.set(key, pending); }
  pending.add(pipeId);
}

/** Pop all pending pipe IDs for a participant (called after lease release).
 *  Returns pipe IDs sorted by pipe creation time (oldest first). */
export function popPendingPipes(assignee: string, projectId: string | null): string[] {
  const key = leaseKey(assignee, projectId);
  const pending = pendingPipes.get(key);
  if (!pending || pending.size === 0) return [];
  const result = [...pending];
  pendingPipes.delete(key);

  // Sort by pipe creation time so older pipes are drained first
  const store = getProjectStore(projectId);
  result.sort((a, b) => {
    const pipeA = store.get(a);
    const pipeB = store.get(b);
    if (!pipeA || !pipeB) return 0;
    return pipeA.createdAt.localeCompare(pipeB.createdAt);
  });

  return result;
}

// ── Stage submission ──────────────────────────────────────────────────────────

/** Submit stage output for a pipe.
 *  @param requireLease If true (default), the assignee must hold the lease. Set false for backward compat via chat_send. */
export function submitStage(
  pipeId: string,
  assignee: string,
  content: string,
  projectId: string | null,
  requireLease = true,
): SubmitResult {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return { ok: false, code: 'PIPE_NOT_FOUND', error: `Pipe #${pipeId} not found` };
  if (pipe.status !== 'running') return { ok: false, code: 'PIPE_CLOSED', error: `Pipe #${pipeId} is ${pipe.status}` };

  const assigneeSlots = pipe.slots.get(assignee);
  if (!assigneeSlots || assigneeSlots.length === 0) {
    return { ok: false, code: 'PIPE_NOT_ASSIGNED', error: `${assignee} is not an assignee of pipe #${pipeId}` };
  }

  let slot: PipeSlot | undefined;
  if (requireLease) {
    const lease = getActiveLease(assignee, projectId);
    if (!lease || lease.pipeId !== pipeId) {
      return {
        ok: false,
        code: 'PIPE_LEASE_NOT_HELD',
        error: `${assignee} does not hold a lease for pipe #${pipeId}. ` +
          `Stage submission requires an active lease granted by the system.`,
      };
    }
    slot = assigneeSlots.find(s => s.role === lease.slotRole && (s.stage === lease.stage || (s.stage === undefined && lease.stage === undefined)) && s.status === 'leased');
  } else {
    // Non-leased submission (backward compat) — take the first non-submitted task
    slot = assigneeSlots.find(s => s.status !== 'submitted');
  }

  if (!slot) return { ok: false, code: 'PIPE_ALREADY_SUBMITTED', error: `${assignee} already submitted all tasks for pipe #${pipeId}` };

  slot.content = content;
  slot.status = 'submitted';
  slot.submittedAt = new Date().toISOString();
  releaseLease(assignee, projectId);

  return {
    ok: true,
    slot: { ...slot },
    pipe: { pipeId: pipe.pipeId, mode: pipe.mode, status: pipe.status },
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Get the stored output for a linear stage. */
export function getStageOutput(
  pipeId: string,
  stage: number,
  projectId: string | null,
): { from: string; body: string } | undefined {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return undefined;
  for (const slotList of pipe.slots.values()) {
    for (const slot of slotList) {
      if (slot.stage === stage && slot.status === 'submitted' && slot.content) {
        return { from: slot.assignee, body: slot.content };
      }
    }
  }
  return undefined;
}

/** Get all submitted fan-out outputs for a merge pipe. */
export function getFanOutOutputs(
  pipeId: string,
  projectId: string | null,
): Map<string, string> {
  const pipe = getPipe(pipeId, projectId);
  const outputs = new Map<string, string>();
  if (!pipe) return outputs;
  for (const slotList of pipe.slots.values()) {
    for (const slot of slotList) {
      if (slot.role === 'fan-out' && slot.status === 'submitted' && slot.content) {
        outputs.set(slot.assignee, slot.content);
      }
    }
  }
  return outputs;
}

/** Get pipe status summary for the pipe_status tool. */
export function getPipeStatus(pipeId: string, projectId: string | null): {
  pipeId: string;
  mode: PipeMode;
  status: PipeStatus;
  assignees: string[];
  prompt: string;
  slots: Array<{
    assignee: string;
    role: string;
    stage?: number;
    status: string;
    hasContent: boolean;
    submittedAt: string | null;
  }>;
  leases: Array<LeaseInfo>;
} | undefined {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return undefined;

  const slots: Array<{
    assignee: string;
    role: string;
    stage?: number;
    status: string;
    hasContent: boolean;
    submittedAt: string | null;
  }> = [];
  const leases: LeaseInfo[] = [];

  for (const [, slotList] of pipe.slots) {
    for (const slot of slotList) {
      slots.push({
        assignee: slot.assignee,
        role: slot.role,
        stage: slot.stage,
        status: slot.status,
        hasContent: slot.content !== null,
        submittedAt: slot.submittedAt,
      });
    }
    const lease = getActiveLease(slotList[0].assignee, projectId);
    if (lease?.pipeId === pipeId) leases.push(lease);
  }

  return {
    pipeId: pipe.pipeId,
    mode: pipe.mode,
    status: pipe.status,
    assignees: pipe.assignees,
    prompt: pipe.prompt,
    slots,
    leases,
  };
}

/** List all active (running) pipes for a project. */
export function listActivePipes(projectId: string | null): Array<{
  pipeId: string;
  mode: PipeMode;
  status: PipeStatus;
  assignees: string[];
}> {
  const store = getProjectStore(projectId);
  const result: Array<{ pipeId: string; mode: PipeMode; status: PipeStatus; assignees: string[] }> = [];
  for (const pipe of store.values()) {
    if (pipe.status === 'running') {
      result.push({ pipeId: pipe.pipeId, mode: pipe.mode, status: pipe.status, assignees: pipe.assignees });
    }
  }
  return result;
}

// ── Test helper ───────────────────────────────────────────────────────────────

/** Reset all in-memory state. For testing only. */
export function _resetForTest(): void {
  stores.clear();
  activeLeases.clear();
  pendingPipes.clear();
  activePipeIndex.clear();
}
