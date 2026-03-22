export interface ChatMessage {
  id: string;
  ts: string;           // ISO timestamp
  from: string;         // participant name
  to: string | null;    // null = broadcast, "name" = direct
  body: string;         // markdown text
  type: 'message' | 'join' | 'leave' | 'system';
  assignedTo?: string | null;
  assignmentStatus?: 'assigned' | 'active' | 'done' | null;
}

export interface ChatParticipant {
  name: string;
  kind: 'user' | 'llm';
  model: string | null;  // e.g. "claude", "cursor", "codex"
  paneId: string | null; // linked shell pane for PTY delivery
  projectId: string | null; // project this participant belongs to
  submitKey: string;     // character sent after delayed PTY injection to trigger submit (default \r, correct for all known clients)
  joinedAt: string;
  lastSeen: string;
  detached: boolean;     // true when MCP session closed but pane is still alive — awaiting reclaim
  clientId?: string;     // optional stable identity for future strong-reclaim support
  isAssigned?: boolean;
  assignmentStatus?: 'assigned' | 'active' | 'done' | null;
}

export interface ChatJoinResponse extends ChatParticipant {
  rules: string;        // effective rules of engagement (markdown)
}

export interface ChatAssignment {
  messageId: string;
  owner: string | null;
  status: 'assigned' | 'active' | 'done';
  assignedAt: string;
  expiresAt: string | null;
}
