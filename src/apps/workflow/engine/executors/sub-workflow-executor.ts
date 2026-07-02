import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, SubWorkflowConfig, WorkflowEvent } from '../../types.js';
import { runWorkflow } from '../graph-runner.js';

const MAX_SUB_WORKFLOW_DEPTH = 10;

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

    // Guard against unbounded recursion (A→A or A→B→A) — track the chain of
    // workflow ids through the run's variables (copied into every child).
    const parentChain = (context.variables.get('__sub_workflow_chain') as string[] | undefined) ?? [];
    const chain = [...parentChain, context.workflowId];
    if (chain.includes(cfg.workflowId)) {
      return { status: 'failed', error: `Sub-workflow cycle detected: ${[...chain, cfg.workflowId].join(' -> ')}` };
    }
    if (chain.length >= MAX_SUB_WORKFLOW_DEPTH) {
      return { status: 'failed', error: `Maximum sub-workflow depth (${MAX_SUB_WORKFLOW_DEPTH}) exceeded` };
    }

    const workflow = await context.services.workflow.getWorkflow(cfg.workflowId);
    if (!workflow) {
      return { status: 'failed', error: `Workflow ${cfg.workflowId} not found` };
    }

    const childVariables = new Map<string, unknown>(context.variables);
    childVariables.set('__sub_workflow_chain', chain);
    if (cfg.inputMappings) {
      for (const [childKey, parentKey] of Object.entries(cfg.inputMappings)) {
        childVariables.set(childKey, context.variables.get(parentKey));
      }
    }

    const childEmit: SSEEmitter = (event: WorkflowEvent) => {
      emit(event);
    };

    // Pass the parent context as cancel token so cancellation propagates to sub-workflows
    const result = await runWorkflow(workflow, childEmit, undefined, childVariables, context.services, context);

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
