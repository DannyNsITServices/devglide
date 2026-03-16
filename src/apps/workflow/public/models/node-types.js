// ── Workflow Editor — Node Type Registry ────────────────────────────────
// Defines all 12 node types with config fields, icons, colors, and defaults.
// Config field schemas mirror the TypeScript interfaces in types.ts.

export const NODE_CATEGORIES = [
  { id: 'triggers', label: 'Triggers', color: '#f59e0b' },
  { id: 'actions',  label: 'Actions',  color: '#6366f1' },
  { id: 'control',  label: 'Control Flow', color: '#ec4899' },
  { id: 'steps',    label: 'Steps',    color: '#64748b' },
];

export const NODE_TYPES = {
  // ── Triggers ────────────────────────────────────────────────────────────
  'trigger': {
    label: 'Trigger',
    category: 'triggers',
    icon: '\u26A1',
    color: '#f59e0b',
    ports: { in: 0, out: 1 },
    configFields: [
      { key: 'triggerType', label: 'Trigger Type', type: 'select',
        options: ['manual', 'prompt', 'voice', 'webhook', 'schedule', 'git-event', 'log-pattern', 'kanban-move'] },
      { key: 'cron', label: 'Cron Expression', type: 'text',
        showWhen: { triggerType: 'schedule' } },
      { key: 'gitEvent', label: 'Git Event', type: 'select',
        options: ['commit', 'push', 'branch-create', 'tag'],
        showWhen: { triggerType: 'git-event' } },
      { key: 'gitBranch', label: 'Branch Filter', type: 'text',
        showWhen: { triggerType: 'git-event' } },
      { key: 'logPattern', label: 'Log Pattern (regex)', type: 'text',
        showWhen: { triggerType: 'log-pattern' } },
      { key: 'kanbanTargetColumn', label: 'Target Column', type: 'text',
        showWhen: { triggerType: 'kanban-move' } },
    ],
    defaultConfig: { nodeType: 'trigger', triggerType: 'manual' },
  },

  // ── Actions ─────────────────────────────────────────────────────────────
  'action:shell': {
    label: 'Shell',
    category: 'actions',
    icon: '\u{1F4BB}',
    color: '#22c55e',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'command', label: 'Command', type: 'textarea' },
      { key: 'cwd', label: 'Working Directory', type: 'text' },
      { key: 'captureOutput', label: 'Capture Output', type: 'checkbox' },
      { key: 'outputVariable', label: 'Output Variable', type: 'text' },
    ],
    defaultConfig: { nodeType: 'action:shell', command: '', captureOutput: true },
  },

  'action:kanban': {
    label: 'Kanban',
    category: 'actions',
    icon: '\u{1F4CB}',
    color: '#3b82f6',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'operation', label: 'Operation', type: 'select',
        options: ['create', 'move', 'update', 'append-work-log', 'append-review', 'list'] },
      { key: 'featureId', label: 'Feature ID', type: 'text' },
      { key: 'itemId', label: 'Item ID', type: 'text' },
      { key: 'columnName', label: 'Column Name', type: 'text',
        showWhen: { operation: 'move' } },
      { key: 'title', label: 'Title', type: 'text',
        showWhen: { operation: 'create' } },
      { key: 'description', label: 'Description', type: 'textarea',
        showWhen: { operation: 'create' } },
      { key: 'content', label: 'Content', type: 'textarea' },
    ],
    defaultConfig: { nodeType: 'action:kanban', operation: 'create' },
  },

  'action:git': {
    label: 'Git',
    category: 'actions',
    icon: '\u{1F500}',
    color: '#f97316',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'operation', label: 'Operation', type: 'select',
        options: ['status', 'diff', 'commit', 'push', 'branch-create', 'checkout', 'add'] },
      { key: 'message', label: 'Commit Message', type: 'text',
        showWhen: { operation: 'commit' } },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'files', label: 'Files (one per line)', type: 'textarea' },
    ],
    defaultConfig: { nodeType: 'action:git', operation: 'status' },
  },

  'action:llm': {
    label: 'LLM',
    category: 'actions',
    icon: '\u{1F9E0}',
    color: '#8b5cf6',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'promptSource', label: 'Prompt Source', type: 'select',
        options: ['inline', 'file'] },
      { key: 'prompt', label: 'Prompt', type: 'textarea',
        showWhen: { promptSource: 'inline' } },
      { key: 'promptFile', label: 'Prompt File', type: 'text',
        showWhen: { promptSource: 'file' } },
      { key: 'model', label: 'Model', type: 'text' },
      { key: 'temperature', label: 'Temperature', type: 'number' },
      { key: 'maxTokens', label: 'Max Tokens', type: 'number' },
    ],
    defaultConfig: { nodeType: 'action:llm', promptSource: 'inline', prompt: '' },
  },

  'action:test': {
    label: 'Test',
    category: 'actions',
    icon: '\u{1F9EA}',
    color: '#06b6d4',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'operation', label: 'Operation', type: 'select',
        options: ['run-scenario', 'run-saved', 'save-scenario', 'list-saved'] },
      { key: 'scenarioId', label: 'Scenario ID', type: 'text' },
      { key: 'target', label: 'Target URL', type: 'text',
        showWhen: { operation: 'run-scenario' } },
      { key: 'linkedItemId', label: 'Linked Item ID', type: 'text' },
    ],
    defaultConfig: { nodeType: 'action:test', operation: 'run-saved' },
  },

  'action:log': {
    label: 'Log',
    category: 'actions',
    icon: '\u{1F4DD}',
    color: '#64748b',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'operation', label: 'Operation', type: 'select',
        options: ['write', 'read', 'clear'] },
      { key: 'targetPath', label: 'Target Path', type: 'text' },
      { key: 'type', label: 'Log Type', type: 'text',
        showWhen: { operation: 'write' } },
      { key: 'message', label: 'Message', type: 'textarea',
        showWhen: { operation: 'write' } },
      { key: 'lines', label: 'Lines to Read', type: 'number',
        showWhen: { operation: 'read' } },
    ],
    defaultConfig: { nodeType: 'action:log', operation: 'write' },
  },

  'action:file': {
    label: 'File',
    category: 'actions',
    icon: '\u{1F4C1}',
    color: '#14b8a6',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'operation', label: 'Operation', type: 'select',
        options: ['read', 'write', 'append', 'exists', 'tree'] },
      { key: 'path', label: 'Path', type: 'text' },
      { key: 'content', label: 'Content', type: 'textarea',
        showWhen: { operation: 'write' } },
    ],
    defaultConfig: { nodeType: 'action:file', operation: 'read', path: '' },
  },

  'action:http': {
    label: 'HTTP',
    category: 'actions',
    icon: '\u{1F310}',
    color: '#e11d48',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'method', label: 'Method', type: 'select',
        options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      { key: 'url', label: 'URL', type: 'text' },
      { key: 'headers', label: 'Headers (JSON)', type: 'textarea' },
      { key: 'body', label: 'Body', type: 'textarea' },
    ],
    defaultConfig: { nodeType: 'action:http', method: 'GET', url: '' },
  },

  // ── Control Flow ────────────────────────────────────────────────────────
  'decision': {
    label: 'Decision',
    category: 'control',
    icon: '\u{1F500}',
    color: '#ec4899',
    ports: { in: 1, out: 'dynamic' },
    configFields: [
      { key: 'conditionType', label: 'Condition Type', type: 'select',
        options: ['exit-code', 'variable', 'expression'] },
      { key: 'variable', label: 'Variable', type: 'text',
        showWhen: { conditionType: 'variable' } },
      { key: 'expression', label: 'Expression', type: 'text',
        showWhen: { conditionType: 'expression' } },
    ],
    defaultConfig: { nodeType: 'decision', conditionType: 'expression', ports: [] },
  },

  'loop': {
    label: 'Loop',
    category: 'control',
    icon: '\u{1F504}',
    color: '#d946ef',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'loopType', label: 'Loop Type', type: 'select',
        options: ['count', 'while', 'for-each'] },
      { key: 'count', label: 'Count', type: 'number',
        showWhen: { loopType: 'count' } },
      { key: 'condition', label: 'Condition', type: 'text',
        showWhen: { loopType: 'while' } },
      { key: 'collection', label: 'Collection Variable', type: 'text',
        showWhen: { loopType: 'for-each' } },
      { key: 'itemVariable', label: 'Item Variable', type: 'text',
        showWhen: { loopType: 'for-each' } },
      { key: 'maxIterations', label: 'Max Iterations', type: 'number' },
    ],
    defaultConfig: { nodeType: 'loop', loopType: 'count', count: 1 },
  },

  'sub-workflow': {
    label: 'Sub-Workflow',
    category: 'control',
    icon: '\u{1F4E6}',
    color: '#a855f7',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'workflowId', label: 'Workflow ID', type: 'text' },
    ],
    defaultConfig: { nodeType: 'sub-workflow', workflowId: '' },
  },

  // ── Steps (backward compat) ─────────────────────────────────────────────
  'step': {
    label: 'Step',
    category: 'steps',
    icon: '\u{1F4CB}',
    color: '#64748b',
    ports: { in: 1, out: 1 },
    configFields: [
      { key: 'instructions', label: 'Instructions', type: 'textarea' },
      { key: 'instructionFile', label: 'Instruction File (.md)', type: 'text' },
    ],
    defaultConfig: { nodeType: 'step', instructions: '', instructionFile: '' },
  },
};

/**
 * Get the node type definition for a given type key.
 * @param {string} type
 * @returns {object|null}
 */
export function getNodeType(type) {
  return NODE_TYPES[type] ?? null;
}

/**
 * Get all node types within a category.
 * @param {string} categoryId
 * @returns {Array<[string, object]>}
 */
export function getNodesByCategory(categoryId) {
  return Object.entries(NODE_TYPES).filter(([, def]) => def.category === categoryId);
}

/**
 * Resolve the concrete output ports for a node.
 * For static ports (out: N), returns N port descriptors with ids 'out-0', 'out-1', ...
 * For dynamic ports (decision nodes), reads config.ports array.
 * Always returns at least one output port.
 * @param {object} node - { type, config }
 * @returns {Array<{ id: string, label: string }>}
 */
export function resolveOutputPorts(node) {
  const typeDef = NODE_TYPES[node.type];
  const portsDef = typeDef?.ports?.out ?? 1;

  if (portsDef === 'dynamic') {
    const configPorts = node.config?.ports;
    if (Array.isArray(configPorts) && configPorts.length > 0) {
      return configPorts.map(p => ({ id: p.id, label: p.label ?? p.id }));
    }
    // Fallback: single default output so the node is still connectable
    return [{ id: 'out-0', label: 'default' }];
  }

  const count = typeof portsDef === 'number' ? portsDef : 1;
  return Array.from({ length: count }, (_, i) => ({ id: `out-${i}`, label: `out-${i}` }));
}

/**
 * Resolve the number of input ports for a node.
 * @param {object} node - { type }
 * @returns {number}
 */
export function resolveInputPortCount(node) {
  const typeDef = NODE_TYPES[node.type];
  return typeDef?.ports?.in ?? 1;
}
