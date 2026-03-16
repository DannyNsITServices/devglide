import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, TriggerConfig } from '../../types.js';

export const triggerExecutor: ExecutorFunction = async (
  config: NodeConfig,
  context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as TriggerConfig;
  const payload = context.variables.get('__triggerPayload');

  switch (cfg.triggerType) {
    case 'manual':
      return { status: 'passed', output: 'Manual trigger' };

    case 'schedule':
      return { status: 'passed', output: payload ?? 'Scheduled trigger' };

    case 'git-event':
      return { status: 'passed', output: payload ?? 'Git event trigger' };

    case 'log-pattern':
      return { status: 'passed', output: payload ?? 'Log pattern trigger' };

    case 'kanban-move':
      return { status: 'passed', output: payload ?? 'Kanban move trigger' };

    case 'webhook':
      return { status: 'passed', output: payload ?? 'Webhook trigger' };

    case 'prompt':
      return { status: 'passed', output: payload ?? 'Prompt trigger' };

    case 'voice':
      return { status: 'passed', output: payload ?? 'Voice trigger' };

    default:
      return { status: 'passed', output: payload ?? 'Unknown trigger' };
  }
};
