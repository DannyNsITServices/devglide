import { registerExecutor } from '../node-registry.js';
import { triggerExecutor } from './trigger-executor.js';
import { shellExecutor } from './shell-executor.js';
import { kanbanExecutor } from './kanban-executor.js';
import { gitExecutor } from './git-executor.js';
import { testExecutor } from './test-executor.js';
import { logExecutor } from './log-executor.js';
import { fileExecutor } from './file-executor.js';
import { llmExecutor } from './llm-executor.js';
import { httpExecutor } from './http-executor.js';
import { decisionExecutor } from './decision-executor.js';
import { loopExecutor } from './loop-executor.js';
import { subWorkflowExecutor } from './sub-workflow-executor.js';

export function registerAllExecutors(): void {
  registerExecutor('trigger', triggerExecutor);
  registerExecutor('action:shell', shellExecutor);
  registerExecutor('action:kanban', kanbanExecutor);
  registerExecutor('action:git', gitExecutor);
  registerExecutor('action:test', testExecutor);
  registerExecutor('action:log', logExecutor);
  registerExecutor('action:file', fileExecutor);
  registerExecutor('action:llm', llmExecutor);
  registerExecutor('action:http', httpExecutor);
  registerExecutor('decision', decisionExecutor);
  registerExecutor('loop', loopExecutor);
  registerExecutor('sub-workflow', subWorkflowExecutor);
}
