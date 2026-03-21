export interface ChatMessage {
  id: string;
  ts: string;           // ISO timestamp
  from: string;         // participant name
  to: string | null;    // null = broadcast, "name" = direct
  body: string;         // markdown text
  topic: string | null; // extracted from first #hashtag in body, null = main chat
  type: 'message' | 'join' | 'leave' | 'system';
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
}
