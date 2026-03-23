export type DeliveryStatus = 'delivered' | 'uncertain' | 'failed' | 'pending';

export interface DeliveryInfo {
  target: string;
  status: DeliveryStatus;
  reason?: string;
}

export interface ChatMessage {
  id: string;
  ts: string;           // ISO timestamp
  from: string;         // participant name
  to: string | null;    // null = broadcast, "name" = direct
  body: string;         // markdown text
  type: 'message' | 'join' | 'leave' | 'system';
  delivery?: DeliveryInfo[];  // PTY delivery status per target (only for 'message' type)
}

export interface ChatParticipant {
  name: string;
  kind: 'user' | 'llm';
  model: string | null;  // e.g. "claude", "cursor", "codex"
  status?: 'idle' | 'working';
  paneId: string | null; // linked shell pane for PTY delivery
  projectId: string | null; // project this participant belongs to
  submitKey: string;     // character sent after delayed PTY injection to trigger submit (default \r, correct for all known clients)
  joinedAt: string;
  lastSeen: string;
  detached: boolean;     // true when MCP session closed but pane is still alive — awaiting reclaim
  clientId?: string;     // optional stable identity for future strong-reclaim support
}

export interface ChatJoinResponse extends ChatParticipant {
  rules: string;        // effective rules of engagement (markdown)
}
