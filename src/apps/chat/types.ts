export interface ChatMessage {
  id: string;
  ts: string;           // ISO timestamp
  from: string;         // participant name
  to: string | null;    // null = no target, "name" = direct, "all" = broadcast, comma-separated for multi
  body: string;         // markdown text
  type: 'message' | 'join' | 'leave' | 'system';
  pipe?: PipeMessageMeta; // present when message is part of a pipe run
  deliveredTo?: number; // count of participants who received PTY delivery
  unresolvedTargets?: string[]; // @mention tokens that didn't match any known participant
}

/** Result of target resolution for PTY delivery. */
export interface DeliveryPlan {
  /** Raw @mention tokens as written (e.g. "all", "claude-7", "team-ui") — for msg.to storage */
  targetLabels: string[];
  /** Concrete participant names for PTY delivery (expanded from labels) */
  recipients: string[];
  /** Direct @mentions only (no group expansions) — for status side-effects */
  concreteAssignees: string[];
  /** Whether to fall back to broadcast when recipients is empty */
  fallbackBroadcast: boolean;
  /** Individual @mention tokens that didn't resolve to any known participant */
  unresolvedTargets: string[];
}

// ── Pipe types ───────────────────────────────────────────────────────

export type PipeMode = 'linear' | 'merge' | 'merge-all' | 'explain' | 'summarize';

export type PipeTimeoutPolicy = 'fail' | 'reassign' | 'escalate';

export type PipeRole =
  | 'start'
  | 'handoff'
  | 'fan-out-request'
  | 'stage-output'
  | 'fan-out'
  | 'synth-request'
  | 'final'
  | 'assignee-unavailable'
  | 'failed'
  | 'cancelled';

export interface PipeMessageMeta {
  pipeId: string;
  mode: PipeMode;
  role: PipeRole;
  assignees?: string[];         // ordered list on 'start'; defines sequence (linear) or fan-out + synth (merge, last = synth)
  prompt?: string;              // original user prompt, carried on 'start' so reducer can reconstruct it
  stage?: number;               // 1-indexed, for linear handoff/stage-output
  expectedAssignees?: string[]; // who the reducer expects responses from at current step
  targetAssignee?: string;      // who this system message is directed at (handoff, fan-out-request, synth-request)
  reason?: 'left' | 'detached' | 'pane-closed' | 'cancelled-by-user' | 'timeout';
}

/** Derived pipe status — computed from log, not stored. */
export type PipeStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type PipeUiEventType =
  | 'start'
  | 'complete'
  | 'failed'
  | 'cancel'
  | 'queued'
  | 'instruction'
  | 'stage-output';

export interface PipeUiEvent {
  id: string;
  ts: string;
  type: PipeUiEventType;
  pipeId: string;
  mode?: PipeMode | null;
  actionType?: 'handoff' | 'fan-out-request' | 'synth-request';
  assignee?: string;
  from?: string;
  role?: Extract<PipeRole, 'stage-output' | 'fan-out' | 'final'>;
  stage?: number;
  content?: string;
  reason?: string;
  // Recovery fields — present on 'start' events for state reconstruction
  assignees?: string[];
  prompt?: string;
  stageTimeoutMs?: number;
  timeoutPolicy?: PipeTimeoutPolicy;
}

export interface ChatParticipant {
  name: string;
  kind: 'user' | 'llm';
  model: string | null;  // e.g. "claude", "cursor", "codex"
  status?: 'idle' | 'working';
  paneId: string | null; // linked shell pane for PTY delivery
  paneNum: number | null; // per-project display number — used by frontend for color assignment
  projectId: string | null; // project this participant belongs to
  submitKey: string;     // character sent after delayed PTY injection to trigger submit (default \r, correct for all known clients)
  joinedAt: string;
  lastSeen: string;
  detached: boolean;     // true when MCP session closed but pane is still alive — awaiting reclaim
  joinedVia?: 'rest' | 'mcp' | null; // how the participant joined — 'rest' for direct REST call, 'mcp' for MCP tool
  clientId?: string;     // optional stable identity for future strong-reclaim support
  permissionMode?: 'supervised' | 'auto-accept' | 'unrestricted' | null; // permission mode the LLM was launched with
  role?: { slug: string; displayName: string } | null;
}

export interface ChatJoinResponse extends ChatParticipant {
  rules: string;        // effective rules of engagement (markdown)
}

// ── Assignment types ────────────────────────────────────────────────

/** Lifecycle states for a durable assignment. */
export type AssignmentStatus =
  | 'assigned'          // created, notification not yet sent
  | 'notified'          // compact notification delivered via PTY
  | 'acknowledged'      // assignee acknowledged receipt
  | 'payload_fetched'   // assignee fetched the authoritative payload
  | 'submitted'         // assignee submitted stage output
  | 'expired'           // deadline passed without submission
  | 'reassigned'        // replaced by a new assignment to a different agent
  | 'superseded'        // replaced by a retry of the same agent
  | 'cancelled';        // pipe was cancelled, assignment voided

/** Terminal statuses — an assignment in one of these states cannot transition further. */
export const TERMINAL_ASSIGNMENT_STATUSES: ReadonlySet<AssignmentStatus> = new Set([
  'submitted', 'expired', 'reassigned', 'superseded', 'cancelled',
]);

/** Valid status transitions for the assignment state machine. */
export const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> = {
  assigned:         ['notified', 'expired', 'reassigned', 'superseded', 'cancelled'],
  notified:         ['acknowledged', 'expired', 'reassigned', 'superseded', 'cancelled'],
  acknowledged:     ['payload_fetched', 'expired', 'reassigned', 'superseded', 'cancelled'],
  payload_fetched:  ['submitted', 'expired', 'reassigned', 'superseded', 'cancelled'],
  submitted:        [],
  expired:          [],
  reassigned:       [],
  superseded:       [],
  cancelled:        [],
};

// ── Payload types ───────────────────────────────────────────────────

/** Lifecycle states for stored payloads. */
export type PayloadStatus = 'active' | 'archived' | 'deleted';

// —— Pipe observability types ———————————————————————————————————————————————

export interface StageTiming {
  stage?: number;
  assignee: string;
  role: Extract<PipeRole, 'stage-output' | 'fan-out' | 'final'>;
  grantedAt: string | null;
  submittedAt: string | null;
  deadline: string | null;
  durationMs: number | null;
}

export interface PipeTimingSummary {
  pipeId: string;
  mode: PipeMode;
  status: PipeStatus;
  createdAt: string;
  completedAt: string | null;
  totalDurationMs: number | null;
  stages: StageTiming[];
  criticalPathMs: number | null;
  stageTimeoutMs: number;
  timeoutPolicy: PipeTimeoutPolicy;
}

export interface RuntimeLeaseStatus {
  pipeId: string;
  assignee: string;
  slotRole: string;
  stage?: number;
  grantedAt: string;
  deadline: string | null;
  elapsedMs: number;
  remainingMs: number | null;
  isOverdue: boolean;
}

export interface DeadLetterEntry {
  pipeId: string;
  assignee: string;
  stage?: number;
  role: string;
  status: 'timeout-expired' | 'stuck' | 'delivery-failed';
  reason: string;
  grantedAt: string | null;
  deadline: string | null;
  elapsedMs: number;
  pipeMode: PipeMode;
  pipeStatus: PipeStatus;
}

// —— Pipe provenance types ————————————————————————————————————————————————

export type ProvenanceEvent =
  | 'created'
  | 'stage-granted'
  | 'stage-submitted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'payload-created'
  | 'payload-fetched'
  | 'assignment-created'
  | 'assignment-transitioned'
  | 'delivery-created'
  | 'delivery-fetched'
  | 'delivery-exhausted';

export interface ProvenanceRecord {
  ts: string;
  pipeId: string;
  event: ProvenanceEvent;
  actor: string;
  actorKind: 'user' | 'llm' | 'system';
  stage?: number;
  role?: PipeRole | Extract<PipeRole, 'stage-output' | 'fan-out' | 'final'>;
  assignmentId?: string;
  payloadId?: string;
  metadata?: Record<string, unknown>;
}
