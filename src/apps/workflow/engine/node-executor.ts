import type {
  WorkflowNode,
  ExecutionContext,
  SSEEmitter,
  ExecutorResult,
  NodeExecutionState,
} from '../types.js';
import { getExecutor } from './node-registry.js';
import { VariableResolver } from './variable-resolver.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const resolver = new VariableResolver();

export async function executeNode(
  node: WorkflowNode,
  context: ExecutionContext,
  emit: SSEEmitter,
): Promise<ExecutorResult> {
  const executor = getExecutor(node.type);
  if (!executor) {
    const error = `No executor registered for node type: ${node.type}`;
    const state = failState(node.id, error);
    context.nodeStates.set(node.id, state);
    emit({ type: 'node_done', nodeId: node.id, status: 'failed' });
    return { status: 'failed', error };
  }

  const resolvedConfig = resolver.resolveObject(node.config, context);
  const maxRetries = node.retries ?? 0;
  const retryDelay = node.retryDelay ?? 1000;
  const timeout = node.timeout ?? DEFAULT_TIMEOUT_MS;

  const state: NodeExecutionState = {
    nodeId: node.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    retryCount: 0,
  };
  context.nodeStates.set(node.id, state);
  emit({ type: 'node_start', nodeId: node.id });

  let result: ExecutorResult | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    state.retryCount = attempt;

    try {
      result = await withTimeout(executor(resolvedConfig, context, emit), timeout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { status: 'failed', error: message };
    }

    if (result.status === 'passed' || attempt >= maxRetries) break;

    if (attempt < maxRetries) {
      await sleep(retryDelay);
    }
  }

  result = result!;

  state.status = result.status;
  state.completedAt = new Date().toISOString();
  state.output = result.output;
  state.exitCode = result.exitCode;
  state.error = result.error;

  if (result.variables) {
    for (const [key, value] of Object.entries(result.variables)) {
      context.variables.set(key, value);
    }
  }

  emit({ type: 'node_done', nodeId: node.id, status: result.status, exitCode: result.exitCode });

  return result;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Node timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failState(nodeId: string, error: string): NodeExecutionState {
  return {
    nodeId,
    status: 'failed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error,
    retryCount: 0,
  };
}
