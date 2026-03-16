import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter } from '../../types.js';

/**
 * Loop executor is a pass-through — all loop iteration logic is owned by
 * handleLoop() in graph-runner.ts which has access to the graph structure.
 * The executor simply signals readiness so the graph-runner can take over.
 */
export const loopExecutor: ExecutorFunction = async (
  _config: NodeConfig,
  _context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  return { status: 'passed' };
};
