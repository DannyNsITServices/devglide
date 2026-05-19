// ── Kanban domain contracts ──────────────────────────────────────────────────

export const KANBAN_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type KanbanPriority = typeof KANBAN_PRIORITIES[number];

export const KANBAN_ITEM_TYPES = ["TASK", "BUG"] as const;
export type KanbanItemType = typeof KANBAN_ITEM_TYPES[number];

/** REST API accepts these extended types; MCP/UI only use TASK and BUG. */
export const KANBAN_ITEM_TYPES_EXTENDED = ["BUG", "TASK", "FEATURE", "IMPROVEMENT", "EPIC"] as const;
export type KanbanItemTypeExtended = typeof KANBAN_ITEM_TYPES_EXTENDED[number];

export interface KanbanColumnDefinition {
  name: string;
  color: string;
  order: number;
}

export const KANBAN_DEFAULT_COLUMNS: KanbanColumnDefinition[] = [
  { name: "Backlog", color: "#64748b", order: 0 },
  { name: "Todo", color: "#3b82f6", order: 1 },
  { name: "In Progress", color: "#f59e0b", order: 2 },
  { name: "In Review", color: "#8b5cf6", order: 3 },
  { name: "Testing", color: "#14b8a6", order: 4 },
  { name: "Done", color: "#22c55e", order: 5 },
];

// ── Log types ────────────────────────────────────────────────────────────────

export interface LogEntry {
  type: string;
  session: string;
  seq: number;
  ts: string;
  url?: string;
  ua?: string;
  message?: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  targetPath: string;
}

export interface TriggerCommand {
  command: string;
  selector?: string;
  text?: string;
  value?: string;
  timeout?: number;
  ms?: number;
  clear?: boolean;
  contains?: boolean;
  path?: string;
}

export interface TriggerScenario {
  id?: string;
  name: string;
  description?: string;
  steps: TriggerCommand[];
  target: string;
  createdAt?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}
