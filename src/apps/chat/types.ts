export interface ChatMessage {
  id: string;
  ts: string;           // ISO timestamp
  from: string;         // participant name
  to: string | null;    // null = broadcast, "name" = direct
  body: string;         // markdown text
  type: 'message' | 'join' | 'leave' | 'system';
  pipe?: PipeMessageMeta; // present when message is part of a pipe run
}

// ── Pipe types ───────────────────────────────────────────────────────

export type PipeMode = 'linear' | 'merge' | 'merge-all';

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
  reason?: 'left' | 'detached' | 'pane-closed' | 'cancelled-by-user';
}

/** Derived pipe status — computed from log, not stored. */
export type PipeStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  clientId?: string;     // optional stable identity for future strong-reclaim support
  permissionMode?: 'supervised' | 'auto-accept' | 'unrestricted' | null; // permission mode the LLM was launched with
}

export interface ChatJoinResponse extends ChatParticipant {
  rules: string;        // effective rules of engagement (markdown)
}
