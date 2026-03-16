import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, SubWorkflowConfig, WorkflowEvent } from '../../types.js';
import { runWorkflow } from '../graph-runner.js';

export const subWorkflowExecutor: ExecutorFunction = async (
  config: NodeConfig,
  context: ExecutionContext,
  emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as SubWorkflowConfig;

  try {
    if (!cfg.workflowId) {
      return { status: 'failed', error: 'workflowId is required' };
    }

    if (!context.services.workflow) {
      return { status: 'failed', error: 'Workflow services not available — ensure workflow module is initialized' };
    }

    const workflow = await context.services.workflow.getWorkflow(cfg.workflowId);
    if (!workflow) {
      return { status: 'failed', error: `Workflow ${cfg.workflowId} not found` };
    }

    const childVariables = new Map<string, unknown>(context.variables);
    if (cfg.inputMappings) {
      for (const [childKey, parentKey] of Object.entries(cfg.inputMappings)) {
        childVariables.set(childKey, context.variables.get(parentKey));
      }
    }

    const childEmit: SSEEmitter = (event: WorkflowEvent) => {
      emit(event);
    };

    const result = await runWorkflow(workflow, childEmit, undefined, childVariables, context.services);

    const outputVars: Record<string, unknown> = {};
    if (cfg.outputMappings && result.variables) {
      for (const [parentKey, childKey] of Object.entries(cfg.outputMappings)) {
        if (result.variables.has(childKey)) {
          outputVars[parentKey] = result.variables.get(childKey);
        }
      }
    }

    // Extract error from first failed node state (if any)
    let error: string | undefined;
    for (const ns of result.nodeStates.values()) {
      if (ns.status === 'failed' && ns.error) { error = ns.error; break; }
    }

    return {
      status: result.status === 'passed' ? 'passed' : 'failed',
      variables: Object.keys(outputVars).length > 0 ? outputVars : undefined,
      error,
    };
  } catch (err: unknown) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
};
