export interface Workflow {
  id: string;
  name: string;
  description?: string;
  version: number;
  projectId?: string;
  tags: string[];
  enabled?: boolean;
  global?: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: VariableDefinition[];
  createdAt: string;
  updatedAt: string;
}

export type NodeType =
  | 'trigger'
  | 'action:shell'
  | 'action:kanban'
  | 'action:git'
  | 'action:test'
  | 'action:log'
  | 'action:file'
  | 'action:llm'
  | 'action:http'
  | 'decision'
  | 'loop'
  | 'sub-workflow';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  config: NodeConfig;
  position: { x: number; y: number };
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  condition?: EdgeCondition;
  label?: string;
}

export interface EdgeCondition {
  type: 'expression' | 'exit-code' | 'variable-match';
  expression?: string;
  variable?: string;
  operator?: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'matches';
  value?: string;
}

export interface VariableDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  defaultValue?: string;
  description?: string;
}

export type NodeConfig =
  | TriggerConfig
  | ShellConfig
  | KanbanConfig
  | GitConfig
  | TestConfig
  | LogConfig
  | FileConfig
  | LlmConfig
  | HttpConfig
  | DecisionConfig
  | LoopConfig
  | SubWorkflowConfig;

export interface TriggerConfig {
  nodeType: 'trigger';
  triggerType: 'manual' | 'prompt' | 'voice' | 'webhook' | 'schedule' | 'git-event' | 'log-pattern' | 'kanban-move';
  cron?: string;
  gitEvent?: 'commit' | 'push' | 'branch-create' | 'tag';
  gitBranch?: string;
  logPattern?: string;
  kanbanTargetColumn?: string;
}

export interface ShellConfig {
  nodeType: 'action:shell';
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  captureOutput?: boolean;
  outputVariable?: string;
}

export interface KanbanConfig {
  nodeType: 'action:kanban';
  operation: 'create' | 'move' | 'update' | 'append-work-log' | 'append-review' | 'list';
  featureId?: string;
  itemId?: string;
  columnName?: string;
  content?: string;
  title?: string;
  description?: string;
  priority?: string;
  type?: string;
}

export interface GitConfig {
  nodeType: 'action:git';
  operation: 'status' | 'diff' | 'commit' | 'push' | 'branch-create' | 'checkout' | 'add';
  message?: string;
  branch?: string;
  files?: string[];
}

export interface TestConfig {
  nodeType: 'action:test';
  operation: 'run-scenario' | 'run-saved' | 'save-scenario' | 'list-saved';
  scenarioId?: string;
  target?: string;
  steps?: Array<{
    command: string;
    selector?: string;
    text?: string;
    value?: string;
    timeout?: number;
    ms?: number;
    clear?: boolean;
    contains?: boolean;
    path?: string;
  }>;
  linkedItemId?: string;
}

export interface LogConfig {
  nodeType: 'action:log';
  operation: 'write' | 'read' | 'clear';
  targetPath?: string;
  type?: string;
  message?: string;
  lines?: number;
}

export interface FileConfig {
  nodeType: 'action:file';
  operation: 'read' | 'write' | 'append' | 'exists' | 'tree';
  path: string;
  content?: string;
}

export interface LlmConfig {
  nodeType: 'action:llm';
  promptSource: 'inline' | 'file';
  prompt?: string;
  promptFile?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface HttpConfig {
  nodeType: 'action:http';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DecisionConfig {
  nodeType: 'decision';
  conditionType: 'exit-code' | 'variable' | 'expression';
  variable?: string;
  expression?: string;
  ports: Array<{ id: string; label: string; condition?: string }>;
}

export interface LoopConfig {
  nodeType: 'loop';
  loopType: 'count' | 'while' | 'for-each';
  count?: number;
  condition?: string;
  collection?: string;
  itemVariable?: string;
  maxIterations?: number;
}

export interface SubWorkflowConfig {
  nodeType: 'sub-workflow';
  workflowId: string;
  inputMappings?: Record<string, string>;
  outputMappings?: Record<string, string>;
}

export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled';

/** Service contracts for executor dependency injection — decouples executors from app singletons. */
export interface ExecutorServices {
  test?: {
    submitScenario(data: { name: string; steps: unknown[]; target?: string }): unknown;
    getSavedScenario(id: string): Promise<{ name: string; steps: unknown[]; target: string } | null>;
    markRun(id: string): Promise<void>;
    saveScenario(data: { name: string; description?: string; target: string; steps: unknown[] }): Promise<unknown>;
    listSaved(): Promise<unknown[]>;
  };
  workflow?: {
    getWorkflow(id: string): Promise<Workflow | null>;
  };
}

export interface ExecutionContext {
  runId: string;
  workflowId: string;
  variables: Map<string, unknown>;
  nodeStates: Map<string, NodeExecutionState>;
  status: RunStatus;
  startedAt: string;
  cancelled: boolean;
  loopContext?: LoopContext;
  /** Snapshot of active project captured at workflow start — immune to mid-run changes */
  project?: { id: string; name: string; path: string };
  /** Injected service providers — decouples executors from app singletons */
  services: ExecutorServices;
}

export interface LoopContext {
  index: number;
  item?: unknown;
  collection?: unknown[];
}

export interface NodeExecutionState {
  nodeId: string;
  status: RunStatus;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: string;
  exitCode?: number;
  retryCount: number;
}

export type SSEEmitter = (event: WorkflowEvent) => void;

export type ExecutorFunction = (
  config: NodeConfig,
  context: ExecutionContext,
  emit: SSEEmitter,
) => Promise<ExecutorResult>;

export interface ExecutorResult {
  status: 'passed' | 'failed';
  output?: unknown;
  exitCode?: number;
  error?: string;
  variables?: Record<string, unknown>;
}

export type WorkflowEvent =
  | { type: 'node_start'; nodeId: string }
  | { type: 'output'; nodeId: string; data: string }
  | { type: 'node_done'; nodeId: string; status: RunStatus; exitCode?: number }
  | { type: 'edge_traversed'; edgeId: string; source: string; target: string }
  | { type: 'decision_result'; nodeId: string; port: string }
  | { type: 'loop_iteration'; nodeId: string; index: number }
  | { type: 'done'; status: RunStatus }
  | { type: 'error'; message: string };
