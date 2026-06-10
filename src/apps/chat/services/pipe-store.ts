import { createHash } from "crypto";
import type {
  PipeMode,
  PipeStatus,
  PipeTimeoutPolicy,
  StageTiming,
  PipeTimingSummary,
  DeadLetterEntry,
  RuntimeLeaseStatus,
} from "../types.js";
import { systemClock, type Clock } from "./clock.js";
import { getExhaustedDeliveries } from "./pipe-delivery.js";

let _pipeClock: Clock = systemClock;
export function _setObsClockForTest(c: Clock): void {
  _pipeClock = c;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipeSlot {
  assignee: string;
  role: "stage-output" | "fan-out" | "final";
  stage?: number; // 1-indexed, for linear pipes
  status: "pending" | "leased" | "submitted";
  content: string | null;
  submittedAt: string | null;
}

export interface StoredPipe {
  pipeId: string;
  mode: PipeMode;
  assignees: string[];
  prompt: string;
  status: PipeStatus;
  slots: Map<string, PipeSlot[]>; // keyed by assignee name
  createdAt: string;
  // Emission tracking — replaces log scanning for reducer idempotency
  emittedHandoffs: Set<number>; // linear stage numbers that have been delivered
  emittedFanOutRequests: Set<string>; // assignee names that received fan-out requests
  emittedSynthRequest: boolean; // whether synth-request has been sent
  // Stage timeout configuration
  stageTimeoutMs: number; // per-stage deadline in milliseconds (0 = no timeout)
  timeoutPolicy: PipeTimeoutPolicy; // what to do when a stage times out
}

export interface LeaseInfo {
  pipeId: string;
  assignee: string;
  slotRole: string;
  stage?: number;
  grantedAt: string;
  deadline: string | null; // ISO timestamp when this lease expires (null = no deadline)
}

export type PipeErrorCode =
  | "PIPE_NOT_FOUND"
  | "PIPE_CLOSED"
  | "PIPE_NOT_ASSIGNED"
  | "PIPE_LEASE_NOT_HELD"
  | "PIPE_LEASE_EXPIRED"
  | "PIPE_ALREADY_SUBMITTED"
  | "PIPE_LEASE_CONFLICT";

export interface SubmitResult {
  ok: boolean;
  error?: string;
  code?: PipeErrorCode;
  slot?: PipeSlot;
  pipe?: { pipeId: string; mode: PipeMode; status: PipeStatus };
}

export interface StageInputSource {
  from: string;
  content: string;
}

export interface StageInputPayload {
  role: "prompt" | "upstream-output" | "fan-out-prompt" | "fan-out-outputs";
  content: string | null;
  contentHash: string | null;
  contentVersion: number;
  stage?: number;
  totalStages?: number;
  assignee: string;
  prompt: string;
  sources?: StageInputSource[];
}

export type StageInputResult =
  | { ok: true; input: StageInputPayload }
  | { ok: false; code: PipeErrorCode; error: string };

// ── Storage ───────────────────────────────────────────────────────────────────

// projectId -> (pipeId -> StoredPipe)
const stores = new Map<string | null, Map<string, StoredPipe>>();

// "projectId:assigneeName" -> LeaseInfo  (one active lease per participant)
const activeLeases = new Map<string, LeaseInfo>();

// "projectId:assigneeName" -> Set<pipeId>  (pipes waiting for this participant's lease to release)
const pendingPipes = new Map<string, Set<string>>();

// "projectId:assigneeName" -> Set<pipeId>  (index of active/running pipes per participant)
const activePipeIndex = new Map<string, Set<string>>();

function addToActivePipeIndex(
  assignee: string,
  projectId: string | null,
  pipeId: string,
): void {
  const key = leaseKey(assignee, projectId);
  let pipeIds = activePipeIndex.get(key);
  if (!pipeIds) {
    pipeIds = new Set();
    activePipeIndex.set(key, pipeIds);
  }
  pipeIds.add(pipeId);
}

function removeFromActivePipeIndex(
  assignee: string,
  projectId: string | null,
  pipeId: string,
): void {
  const key = leaseKey(assignee, projectId);
  const pipeIds = activePipeIndex.get(key);
  if (pipeIds) {
    pipeIds.delete(pipeId);
    if (pipeIds.size === 0) activePipeIndex.delete(key);
  }
}

/** Get all running pipe IDs for a participant (O(1) lookup). */
export function getActivePipesForParticipant(
  assignee: string,
  projectId: string | null,
): string[] {
  const key = leaseKey(assignee, projectId);
  const pipeIds = activePipeIndex.get(key);
  return pipeIds ? [...pipeIds] : [];
}

function leaseKey(assignee: string, projectId: string | null): string {
  return `${projectId ?? "__none__"}:${assignee}`;
}

/** Get all projectIds that have pipe data in the store. */
export function getTrackedProjectIds(): Array<string | null> {
  return [...stores.keys()];
}

function getProjectStore(projectId: string | null): Map<string, StoredPipe> {
  let store = stores.get(projectId);
  if (!store) {
    store = new Map();
    stores.set(projectId, store);
  }
  return store;
}

function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Pipe lifecycle ────────────────────────────────────────────────────────────

export const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Create a new pipe in the store with slots for each assignee. */
export function createPipe(
  pipeId: string,
  mode: PipeMode,
  assignees: string[],
  prompt: string,
  projectId: string | null,
  opts?: { stageTimeoutMs?: number; timeoutPolicy?: PipeTimeoutPolicy },
): StoredPipe {
  const store = getProjectStore(projectId);
  const slots = new Map<string, PipeSlot[]>();

  if (mode === "linear") {
    for (let i = 0; i < assignees.length; i++) {
      const isLast = i === assignees.length - 1;
      slots.set(assignees[i], [
        {
          assignee: assignees[i],
          role: isLast ? "final" : "stage-output",
          stage: i + 1,
          status: "pending",
          content: null,
          submittedAt: null,
        },
      ]);
    }
  } else if (mode === "merge") {
    // merge: fan-out assignees + last one is synthesizer
    const fanOutAssignees = assignees.slice(0, -1);
    const synthesizer = assignees[assignees.length - 1];
    for (const a of fanOutAssignees) {
      slots.set(a, [
        {
          assignee: a,
          role: "fan-out",
          status: "pending",
          content: null,
          submittedAt: null,
        },
      ]);
    }
    slots.set(synthesizer, [
      {
        assignee: synthesizer,
        role: "final",
        status: "pending",
        content: null,
        submittedAt: null,
      },
    ]);
  } else {
    // merge-all style: ALL assignees get fan-out + last one gets final
    for (let i = 0; i < assignees.length; i++) {
      const a = assignees[i];
      const isLast = i === assignees.length - 1;
      const assigneeSlots: PipeSlot[] = [
        {
          assignee: a,
          role: "fan-out",
          status: "pending",
          content: null,
          submittedAt: null,
        },
      ];
      if (isLast) {
        assigneeSlots.push({
          assignee: a,
          role: "final",
          status: "pending",
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
    status: "running",
    slots,
    createdAt: new Date().toISOString(),
    emittedHandoffs: new Set(),
    emittedFanOutRequests: new Set(),
    emittedSynthRequest: false,
    stageTimeoutMs: opts?.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
    timeoutPolicy: opts?.timeoutPolicy ?? "fail",
  };
  store.set(pipeId, pipe);

  // Populate active pipe index for all assignees
  for (const a of assignees) {
    addToActivePipeIndex(a, projectId, pipeId);
  }

  return pipe;
}

/** Get a pipe from the store. */
export function getPipe(
  pipeId: string,
  projectId: string | null,
): StoredPipe | undefined {
  return getProjectStore(projectId).get(pipeId);
}

/** Track that a reducer action has been emitted (for idempotency without log scanning). */
export function markEmitted(
  pipeId: string,
  type: "handoff" | "fan-out-request" | "synth-request",
  key: string | number | undefined,
  projectId: string | null,
): void {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return;
  if (type === "handoff" && typeof key === "number")
    pipe.emittedHandoffs.add(key);
  else if (type === "fan-out-request" && typeof key === "string")
    pipe.emittedFanOutRequests.add(key);
  else if (type === "synth-request") pipe.emittedSynthRequest = true;
}

/** Mark a pipe as completed, failed, or cancelled. Releases all leases for its assignees.
 *  Returns assignee names whose leases were released (callers should drain their pending queues). */
export function markPipeStatus(
  pipeId: string,
  status: PipeStatus,
  projectId: string | null,
): string[] {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return [];
  pipe.status = status;
  if (status !== "running") {
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
      code: "PIPE_LEASE_CONFLICT",
      error:
        `${assignee} already holds a lease for pipe #${existing.pipeId}. ` +
        `Complete or release that pipe before starting pipe #${pipeId}.`,
    };
  }

  const pipe = getPipe(pipeId, projectId);
  if (!pipe)
    return {
      ok: false,
      code: "PIPE_NOT_FOUND",
      error: `Pipe #${pipeId} not found`,
    };
  if (pipe.status !== "running")
    return {
      ok: false,
      code: "PIPE_CLOSED",
      error: `Pipe #${pipeId} is ${pipe.status}`,
    };

  const assigneeSlots = pipe.slots.get(assignee);
  if (!assigneeSlots || assigneeSlots.length === 0) {
    return {
      ok: false,
      error: `${assignee} is not an assignee of pipe #${pipeId}`,
    };
  }

  // Find the first pending or leased task for this assignee.
  // In merge-all, this will be fan-out first, then final.
  const slot = assigneeSlots.find(
    (s) => s.status === "pending" || s.status === "leased",
  );
  if (!slot)
    return {
      ok: false,
      error: `${assignee} has no pending tasks for pipe #${pipeId}`,
    };

  slot.status = "leased";
  const now = new Date();
  const deadline =
    pipe.stageTimeoutMs > 0
      ? new Date(now.getTime() + pipe.stageTimeoutMs).toISOString()
      : null;
  const lease: LeaseInfo = {
    pipeId,
    assignee,
    slotRole: slot.role,
    stage: slot.stage,
    grantedAt: now.toISOString(),
    deadline,
  };
  activeLeases.set(key, lease);
  return { ok: true, lease };
}

/** Release a participant's active lease. */
export function releaseLease(assignee: string, projectId: string | null): void {
  activeLeases.delete(leaseKey(assignee, projectId));
}

/** Get the active lease for a participant (if any). */
export function getActiveLease(
  assignee: string,
  projectId: string | null,
): LeaseInfo | undefined {
  return activeLeases.get(leaseKey(assignee, projectId));
}

/** Check whether a lease has passed its deadline. */
export function isLeaseExpired(
  lease: LeaseInfo,
  now: number = Date.now(),
): boolean {
  if (!lease.deadline) return false;

  const deadline = new Date(lease.deadline).getTime();

  if (Number.isNaN(deadline)) {
    throw new Error(`Invalid deadline: ${lease.deadline}`);
  }

  return now >= deadline;
}

/** Release all leases for a pipe's assignees. Returns names of assignees whose leases were released. */
function releaseAllLeases(
  pipe: StoredPipe,
  projectId: string | null,
): string[] {
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

/** Get all active leases (for watchdog / deadline checks). */
export function getAllActiveLeases(): ReadonlyMap<string, LeaseInfo> {
  return activeLeases;
}

// ── Pending pipe queue (for lease conflicts) ──────────────────────────────────

/** Record that a pipe is waiting for a participant's lease to be released.
 *  Pipes are drained in creation-time order (oldest first). */
export function addPendingPipe(
  assignee: string,
  projectId: string | null,
  pipeId: string,
): void {
  const key = leaseKey(assignee, projectId);
  let pending = pendingPipes.get(key);
  if (!pending) {
    pending = new Set();
    pendingPipes.set(key, pending);
  }
  pending.add(pipeId);
}

/** Pop all pending pipe IDs for a participant (called after lease release).
 *  Returns pipe IDs sorted by pipe creation time (oldest first). */
export function popPendingPipes(
  assignee: string,
  projectId: string | null,
): string[] {
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
  if (!pipe)
    return {
      ok: false,
      code: "PIPE_NOT_FOUND",
      error: `Pipe #${pipeId} not found`,
    };
  if (pipe.status !== "running")
    return {
      ok: false,
      code: "PIPE_CLOSED",
      error: `Pipe #${pipeId} is ${pipe.status}`,
    };

  const assigneeSlots = pipe.slots.get(assignee);
  if (!assigneeSlots || assigneeSlots.length === 0) {
    return {
      ok: false,
      code: "PIPE_NOT_ASSIGNED",
      error: `${assignee} is not an assignee of pipe #${pipeId}`,
    };
  }

  let slot: PipeSlot | undefined;
  if (requireLease) {
    const lease = getActiveLease(assignee, projectId);
    if (!lease || lease.pipeId !== pipeId) {
      return {
        ok: false,
        code: "PIPE_LEASE_NOT_HELD",
        error:
          `${assignee} does not hold a lease for pipe #${pipeId}. ` +
          `Stage submission requires an active lease granted by the system.`,
      };
    }
    // Reject submits after the lease deadline has passed.
    if (isLeaseExpired(lease)) {
      return {
        ok: false,
        code: "PIPE_LEASE_EXPIRED",
        error:
          `Lease for ${assignee} on pipe #${pipeId} expired at ${lease.deadline}. ` +
          `The stage deadline has passed — submission rejected.`,
      };
    }
    slot = assigneeSlots.find(
      (s) =>
        s.role === lease.slotRole &&
        (s.stage === lease.stage ||
          (s.stage === undefined && lease.stage === undefined)) &&
        s.status === "leased",
    );
  } else {
    // Non-leased submission (backward compat) — take the first non-submitted task
    slot = assigneeSlots.find((s) => s.status !== "submitted");
  }

  if (!slot)
    return {
      ok: false,
      code: "PIPE_ALREADY_SUBMITTED",
      error: `${assignee} already submitted all tasks for pipe #${pipeId}`,
    };

  slot.content = content;
  slot.status = "submitted";
  slot.submittedAt = new Date().toISOString();
  releaseLease(assignee, projectId);

  return {
    ok: true,
    slot: { ...slot },
    pipe: { pipeId: pipe.pipeId, mode: pipe.mode, status: pipe.status },
  };
}

// ── Assignment queries (reconnect / recovery) ───────────────────────────────

export interface ParticipantAssignment {
  pipeId: string;
  mode: PipeMode;
  role: PipeSlot["role"];
  stage?: number;
  slotStatus: PipeSlot["status"];
  leaseStatus: "active" | "expired" | "none";
  deadline: string | null;
  grantedAt: string | null;
  pipeStatus: PipeStatus;
}

/** List all non-submitted slots for a participant across running pipes.
 *  Used by reconnect recovery and the pipe_list_assignments tool. */
export function getAssignmentsForParticipant(
  assignee: string,
  projectId: string | null,
): ParticipantAssignment[] {
  const activePipeIds = getActivePipesForParticipant(assignee, projectId);
  const assignments: ParticipantAssignment[] = [];
  const lease = getActiveLease(assignee, projectId);

  for (const pipeId of activePipeIds) {
    const pipe = getPipe(pipeId, projectId);
    if (!pipe) continue;

    const slots = pipe.slots.get(assignee);
    if (!slots) continue;

    for (const slot of slots) {
      if (slot.status === "submitted") continue;

      const isLeasedSlot =
        lease?.pipeId === pipeId &&
        lease.slotRole === slot.role &&
        (lease.stage === slot.stage ||
          (lease.stage === undefined && slot.stage === undefined));

      let leaseStatus: ParticipantAssignment["leaseStatus"] = "none";
      let deadline: string | null = null;
      let grantedAt: string | null = null;

      if (isLeasedSlot && lease) {
        leaseStatus = isLeaseExpired(lease) ? "expired" : "active";
        deadline = lease.deadline;
        grantedAt = lease.grantedAt;
      }

      assignments.push({
        pipeId,
        mode: pipe.mode,
        role: slot.role,
        stage: slot.stage,
        slotStatus: slot.status,
        leaseStatus,
        deadline,
        grantedAt,
        pipeStatus: pipe.status,
      });
    }
  }

  return assignments;
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
      if (slot.stage === stage && slot.status === "submitted" && slot.content) {
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
      if (
        slot.role === "fan-out" &&
        slot.status === "submitted" &&
        slot.content
      ) {
        outputs.set(slot.assignee, slot.content);
      }
    }
  }
  return outputs;
}

export function computeStageInput(
  pipeId: string,
  stage: number | undefined,
  assignee: string,
  projectId: string | null,
): StageInputResult {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) {
    return {
      ok: false,
      code: "PIPE_NOT_FOUND",
      error: `Pipe #${pipeId} not found`,
    };
  }
  if (pipe.status !== "running") {
    return {
      ok: false,
      code: "PIPE_CLOSED",
      error: `Pipe #${pipeId} is ${pipe.status}`,
    };
  }

  const assigneeIndex = pipe.assignees.indexOf(assignee);
  if (assigneeIndex === -1) {
    return {
      ok: false,
      code: "PIPE_NOT_ASSIGNED",
      error: `${assignee} is not an assignee of pipe #${pipeId}`,
    };
  }

  const resolvedStage =
    stage ?? (pipe.mode === "linear" ? assigneeIndex + 1 : undefined);

  if (pipe.mode === "linear") {
    if (
      !resolvedStage ||
      resolvedStage < 1 ||
      resolvedStage > pipe.assignees.length
    ) {
      return {
        ok: false,
        code: "PIPE_NOT_ASSIGNED",
        error: `Invalid stage ${String(stage)} for pipe #${pipeId}`,
      };
    }
    if (pipe.assignees[resolvedStage - 1] !== assignee) {
      return {
        ok: false,
        code: "PIPE_NOT_ASSIGNED",
        error: `${assignee} is not assigned to stage ${resolvedStage} of pipe #${pipeId}`,
      };
    }
    if (resolvedStage === 1) {
      return {
        ok: true,
        input: {
          role: "prompt",
          content: pipe.prompt,
          contentHash: computeContentHash(pipe.prompt),
          contentVersion: 1,
          stage: 1,
          totalStages: pipe.assignees.length,
          assignee,
          prompt: pipe.prompt,
        },
      };
    }

    const previous = getStageOutput(pipeId, resolvedStage - 1, projectId);
    return {
      ok: true,
      input: {
        role: "upstream-output",
        content: previous?.body ?? null,
        contentHash: previous ? computeContentHash(previous.body) : null,
        contentVersion: previous ? 1 : 0,
        stage: resolvedStage,
        totalStages: pipe.assignees.length,
        assignee,
        prompt: pipe.prompt,
        sources: previous
          ? [{ from: previous.from, content: previous.body }]
          : [],
      },
    };
  }

  const isMergeAll =
    pipe.mode === "merge-all" ||
    pipe.mode === "explain" ||
    pipe.mode === "summarize";
  const synthesizer = pipe.assignees[pipe.assignees.length - 1];
  const callerSlots = pipe.slots.get(assignee) ?? [];
  const callerFanOutSlot =
    callerSlots.find((slot) => slot.role === "fan-out") ?? null;
  const callerFinalSlot =
    callerSlots.find((slot) => slot.role === "final") ?? null;
  const fanOutOutputs = [...getFanOutOutputs(pipeId, projectId).entries()]
    .filter(([from]) => !(isMergeAll && from === synthesizer))
    .map(([from, content]) => ({ from, content }));

  // Dual-role synthesizers stay in fan-out mode until their own fan-out slot is submitted.
  const isSynthPhase =
    assignee === synthesizer &&
    callerFinalSlot != null &&
    (!callerFanOutSlot || callerFanOutSlot.status === "submitted");
  if (!isSynthPhase) {
    return {
      ok: true,
      input: {
        role: "fan-out-prompt",
        content: pipe.prompt,
        contentHash: computeContentHash(pipe.prompt),
        contentVersion: 1,
        assignee,
        prompt: pipe.prompt,
        sources: [],
      },
    };
  }

  const mergedContent = fanOutOutputs
    .map(({ from, content }) => `${from}: ${content}`)
    .join("\n\n");
  return {
    ok: true,
    input: {
      role: "fan-out-outputs",
      content: fanOutOutputs.length > 0 ? mergedContent : null,
      contentHash:
        fanOutOutputs.length > 0 ? computeContentHash(mergedContent) : null,
      contentVersion: fanOutOutputs.length > 0 ? 1 : 0,
      assignee,
      prompt: pipe.prompt,
      sources: fanOutOutputs,
    },
  };
}

/** Get pipe status summary for the pipe_status tool. */
export function getPipeStatus(
  pipeId: string,
  projectId: string | null,
):
  | {
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
    }
  | undefined {
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
  const result: Array<{
    pipeId: string;
    mode: PipeMode;
    status: PipeStatus;
    assignees: string[];
  }> = [];
  for (const pipe of store.values()) {
    if (pipe.status === "running") {
      result.push({
        pipeId: pipe.pipeId,
        mode: pipe.mode,
        status: pipe.status,
        assignees: pipe.assignees,
      });
    }
  }
  return result;
}

// ── Terminal pipe cleanup ────────────────────────────────────────────────────

export const DEFAULT_PIPE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Remove terminal pipes (completed/failed/cancelled) that exceed the given TTL.
 *  Returns the pipeIds that were removed. */
export function cleanupTerminalPipes(
  projectId: string | null,
  ttlMs: number = DEFAULT_PIPE_TTL_MS,
): string[] {
  const store = getProjectStore(projectId);
  const now = Date.now();
  const removed: string[] = [];

  for (const [pipeId, pipe] of store) {
    if (pipe.status === "running") continue;
    // Use the last slot submission time or createdAt as the reference
    let latestTs = new Date(pipe.createdAt).getTime();
    for (const [, slotList] of pipe.slots) {
      for (const slot of slotList) {
        if (slot.submittedAt) {
          const t = new Date(slot.submittedAt).getTime();
          if (t > latestTs) latestTs = t;
        }
      }
    }
    if (now - latestTs >= ttlMs) {
      store.delete(pipeId);
      removed.push(pipeId);
    }
  }

  return removed;
}

// ── Recovery from persisted events ───────────────────────────────────────────

export interface PipeRecoveryEvent {
  type: string;
  pipeId: string;
  mode?: PipeMode;
  assignees?: string[];
  prompt?: string;
  stageTimeoutMs?: number;
  timeoutPolicy?: PipeTimeoutPolicy;
  from?: string;
  role?: string;
  stage?: number;
  content?: string;
}

/** Rehydrate pipe state from persisted events.
 *  Called on server restart to rebuild in-memory pipes from event logs.
 *  Returns the list of pipeIds that are still in 'running' state. */
export function rehydrateFromEvents(
  events: PipeRecoveryEvent[],
  projectId: string | null,
): string[] {
  // Group events by pipeId, preserving order
  const grouped = new Map<string, PipeRecoveryEvent[]>();
  for (const event of events) {
    let list = grouped.get(event.pipeId);
    if (!list) {
      list = [];
      grouped.set(event.pipeId, list);
    }
    list.push(event);
  }

  const runningPipes: string[] = [];

  for (const [pipeId, pipeEvents] of grouped) {
    // Find the start event
    const startEvent = pipeEvents.find((e) => e.type === "start");
    if (
      !startEvent ||
      !startEvent.assignees ||
      !startEvent.prompt ||
      !startEvent.mode
    )
      continue;

    // Skip if already in store (shouldn't happen, but defensive)
    if (getPipe(pipeId, projectId)) continue;

    // Recreate the pipe
    createPipe(
      pipeId,
      startEvent.mode,
      startEvent.assignees,
      startEvent.prompt,
      projectId,
      {
        stageTimeoutMs: startEvent.stageTimeoutMs,
        timeoutPolicy: startEvent.timeoutPolicy,
      },
    );

    // Replay submissions
    for (const event of pipeEvents) {
      if (event.type === "stage-output" && event.from && event.content) {
        submitStage(pipeId, event.from, event.content, projectId, false);
      }
    }

    // Apply terminal status if pipe ended
    const terminalEvent = pipeEvents.find(
      (e) =>
        e.type === "complete" || e.type === "failed" || e.type === "cancel",
    );
    if (terminalEvent) {
      const status: PipeStatus =
        terminalEvent.type === "complete"
          ? "completed"
          : terminalEvent.type === "cancel"
            ? "cancelled"
            : "failed";
      markPipeStatus(pipeId, status, projectId);
    } else {
      // Pipe was running when server stopped — it's recoverable.
      // Rebuild emission tracking from submitted slot state so the reducer
      // doesn't re-emit handoffs/fan-outs that were already delivered.
      rebuildEmissionState(pipeId, projectId);
      runningPipes.push(pipeId);
    }
  }

  return runningPipes;
}

/** Rebuild emission tracking from submitted slot state.
 *  After rehydration, the emission sets are empty. This function infers which
 *  emissions have already occurred by examining slot statuses:
 *  - Linear: if stage N is submitted or leased, handoffs 1..N were emitted.
 *  - Merge/merge-all: if assignee X's fan-out slot is submitted/leased, their fan-out request was emitted.
 *  - If all fan-out slots are submitted, the synth request was emitted.
 *  This prevents the reducer from re-emitting stale prompts after restart. */
function rebuildEmissionState(pipeId: string, projectId: string | null): void {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return;

  if (pipe.mode === "linear") {
    // For linear pipes: any stage that is submitted or leased implies its handoff was emitted.
    // Also, the stage AFTER the last submitted stage was emitted (it's the next handoff target).
    let maxSubmittedStage = 0;
    for (const [, slotList] of pipe.slots) {
      for (const slot of slotList) {
        if (
          slot.stage &&
          (slot.status === "submitted" || slot.status === "leased")
        ) {
          if (slot.stage > maxSubmittedStage) maxSubmittedStage = slot.stage;
        }
      }
    }
    // Handoffs 1..maxSubmittedStage were emitted (each stage received its handoff and acted on it)
    for (let i = 1; i <= maxSubmittedStage; i++) {
      pipe.emittedHandoffs.add(i);
    }
  } else {
    // Merge / merge-all / explain / summarize
    const synthesizer = pipe.assignees[pipe.assignees.length - 1];
    let allFanOutsSubmitted = true;

    for (const [assignee, slotList] of pipe.slots) {
      for (const slot of slotList) {
        if (
          slot.role === "fan-out" &&
          (slot.status === "submitted" || slot.status === "leased")
        ) {
          pipe.emittedFanOutRequests.add(assignee);
        }
        if (slot.role === "fan-out" && slot.status !== "submitted") {
          allFanOutsSubmitted = false;
        }
      }
    }

    // If all fan-out slots are submitted AND the synthesizer has a leased/submitted final slot,
    // then the synth request was emitted
    if (allFanOutsSubmitted) {
      const synthSlots = pipe.slots.get(synthesizer);
      if (synthSlots) {
        const finalSlot = synthSlots.find((s) => s.role === "final");
        if (
          finalSlot &&
          (finalSlot.status === "leased" || finalSlot.status === "submitted")
        ) {
          pipe.emittedSynthRequest = true;
        }
      }
    }
  }
}

// ── Observability ────────────────────────────────────────────────────────────

export function getPipeTimingSummary(
  pipeId: string,
  projectId: string | null,
): PipeTimingSummary | undefined {
  const pipe = getPipe(pipeId, projectId);
  if (!pipe) return undefined;
  const stages: StageTiming[] = [];
  let latestSubmission: string | null = null;
  for (const [assignee, slotList] of pipe.slots) {
    const lease = getActiveLease(assignee, projectId);
    for (const slot of slotList) {
      const isActive =
        lease?.pipeId === pipeId &&
        lease.slotRole === slot.role &&
        (lease.stage === slot.stage ||
          (lease.stage === undefined && slot.stage === undefined));
      const grantedAt = isActive ? lease!.grantedAt : null;
      const deadline = isActive ? lease!.deadline : null;
      let durationMs: number | null = null;
      if (grantedAt && slot.submittedAt)
        durationMs =
          new Date(slot.submittedAt).getTime() - new Date(grantedAt).getTime();
      stages.push({
        stage: slot.stage,
        assignee: slot.assignee,
        role: slot.role,
        grantedAt,
        submittedAt: slot.submittedAt,
        deadline,
        durationMs,
      });
      if (
        slot.submittedAt &&
        (!latestSubmission || slot.submittedAt > latestSubmission)
      )
        latestSubmission = slot.submittedAt;
    }
  }
  const completedAt = pipe.status !== "running" ? latestSubmission : null;
  const totalDurationMs = completedAt
    ? new Date(completedAt).getTime() - new Date(pipe.createdAt).getTime()
    : null;
  let criticalPathMs: number | null = null;
  const durations = stages
    .filter((s) => s.durationMs !== null)
    .map((s) => ({ role: s.role, ms: s.durationMs! }));
  if (durations.length > 0) {
    if (pipe.mode === "linear")
      criticalPathMs = durations.reduce((sum, d) => sum + d.ms, 0);
    else {
      const fm = Math.max(
        ...durations.filter((d) => d.role === "fan-out").map((d) => d.ms),
        0,
      );
      criticalPathMs =
        fm + (durations.find((d) => d.role === "final")?.ms ?? 0);
    }
  }
  return {
    pipeId: pipe.pipeId,
    mode: pipe.mode,
    status: pipe.status,
    createdAt: pipe.createdAt,
    completedAt,
    totalDurationMs,
    stages,
    criticalPathMs,
    stageTimeoutMs: pipe.stageTimeoutMs,
    timeoutPolicy: pipe.timeoutPolicy,
  };
}

export function getRuntimeLeaseStatuses(
  projectId: string | null,
): RuntimeLeaseStatus[] {
  const nowMs = _pipeClock.now();
  const result: RuntimeLeaseStatus[] = [];
  const prefix = (projectId ?? "__none__") + ":";
  for (const [key, lease] of activeLeases) {
    if (!key.startsWith(prefix)) continue;
    const elapsedMs = nowMs - new Date(lease.grantedAt).getTime();
    const deadlineMs = lease.deadline
      ? new Date(lease.deadline).getTime()
      : null;
    result.push({
      pipeId: lease.pipeId,
      assignee: lease.assignee,
      slotRole: lease.slotRole,
      stage: lease.stage,
      grantedAt: lease.grantedAt,
      deadline: lease.deadline,
      elapsedMs,
      remainingMs: deadlineMs !== null ? deadlineMs - nowMs : null,
      isOverdue: deadlineMs !== null && nowMs > deadlineMs,
    });
  }
  return result;
}

export function getDeadLetterEntries(
  projectId: string | null,
): DeadLetterEntry[] {
  const nowMs = _pipeClock.now();
  const entries: DeadLetterEntry[] = [];
  for (const pipe of getProjectStore(projectId).values()) {
    if (pipe.status !== "running") continue;
    for (const [assignee, slotList] of pipe.slots) {
      for (const slot of slotList) {
        if (slot.status === "submitted") continue;
        const lease = getActiveLease(assignee, projectId);
        const isLeased =
          lease?.pipeId === pipe.pipeId && lease.slotRole === slot.role;
        if (isLeased && lease!.deadline) {
          const deadlineMs = new Date(lease!.deadline!).getTime();
          if (nowMs > deadlineMs)
            entries.push({
              pipeId: pipe.pipeId,
              assignee,
              stage: slot.stage,
              role: slot.role,
              status: "timeout-expired",
              reason:
                "Lease expired " +
                String(Math.round((nowMs - deadlineMs) / 1000)) +
                "s ago",
              grantedAt: lease!.grantedAt,
              deadline: lease!.deadline,
              elapsedMs: nowMs - new Date(lease!.grantedAt).getTime(),
              pipeMode: pipe.mode,
              pipeStatus: pipe.status,
            });
        }
        if (slot.status === "pending" && !isLeased) {
          const pipeAge = nowMs - new Date(pipe.createdAt).getTime();
          const threshold =
            pipe.stageTimeoutMs > 0 ? pipe.stageTimeoutMs * 2 : 10 * 60 * 1000;
          if (pipeAge > threshold)
            entries.push({
              pipeId: pipe.pipeId,
              assignee,
              stage: slot.stage,
              role: slot.role,
              status: "stuck",
              reason: "Pending for " + String(Math.round(pipeAge / 1000)) + "s",
              grantedAt: null,
              deadline: null,
              elapsedMs: pipeAge,
              pipeMode: pipe.mode,
              pipeStatus: pipe.status,
            });
        }
      }
    }
  }
  // Delivery-failed: notification retries exhausted
  for (const delivery of getExhaustedDeliveries(projectId)) {
    const reason = `Notification exhausted after ${delivery.notifyAttempts} attempts (state: ${delivery.state})`;
    entries.push({
      pipeId: delivery.pipeId,
      assignee: delivery.assignee,
      stage: delivery.stage,
      role: delivery.role,
      status: "delivery-failed",
      reason,
      grantedAt: delivery.assignedAt,
      deadline: null,
      elapsedMs: _pipeClock.now() - new Date(delivery.assignedAt).getTime(),
      pipeMode: getPipe(delivery.pipeId, projectId)?.mode ?? "linear",
      pipeStatus: getPipe(delivery.pipeId, projectId)?.status ?? "running",
    });
  }

  return entries;
}

export function listAllPipes(projectId: string | null): Array<{
  pipeId: string;
  mode: PipeMode;
  status: PipeStatus;
  assignees: string[];
  createdAt: string;
  stageTimeoutMs: number;
  timeoutPolicy: PipeTimeoutPolicy;
  slotSummary: {
    total: number;
    submitted: number;
    leased: number;
    pending: number;
  };
}> {
  const result: Array<{
    pipeId: string;
    mode: PipeMode;
    status: PipeStatus;
    assignees: string[];
    createdAt: string;
    stageTimeoutMs: number;
    timeoutPolicy: PipeTimeoutPolicy;
    slotSummary: {
      total: number;
      submitted: number;
      leased: number;
      pending: number;
    };
  }> = [];
  for (const pipe of getProjectStore(projectId).values()) {
    let total = 0,
      submitted = 0,
      leased = 0,
      pending = 0;
    for (const slotList of pipe.slots.values()) {
      for (const slot of slotList) {
        total++;
        if (slot.status === "submitted") submitted++;
        else if (slot.status === "leased") leased++;
        else pending++;
      }
    }
    result.push({
      pipeId: pipe.pipeId,
      mode: pipe.mode,
      status: pipe.status,
      assignees: pipe.assignees,
      createdAt: pipe.createdAt,
      stageTimeoutMs: pipe.stageTimeoutMs,
      timeoutPolicy: pipe.timeoutPolicy,
      slotSummary: { total, submitted, leased, pending },
    });
  }
  return result;
}

// ── Test helper ───────────────────────────────────────────────────────────────

/** Reset all in-memory state. For testing only. */
export function _resetForTest(): void {
  _pipeClock = systemClock;
  stores.clear();
  activeLeases.clear();
  pendingPipes.clear();
  activePipeIndex.clear();
}
