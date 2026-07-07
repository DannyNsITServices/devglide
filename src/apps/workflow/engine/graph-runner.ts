import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  ExecutionContext,
  ExecutorServices,
  SSEEmitter,
  RunStatus,
  LoopConfig,
} from '../types.js';
import { executeNode } from './node-executor.js';
import { evaluate } from './expression-evaluator.js';
import { getActiveProject } from '../../../project-context.js';

const MAX_LOOP_ITERATIONS = 1000;

export async function runWorkflow(
  workflow: Workflow,
  emit: SSEEmitter,
  triggerPayload?: unknown,
  initialVariables?: Map<string, unknown>,
  services?: ExecutorServices,
  cancelToken?: { cancelled: boolean },
): Promise<ExecutionContext> {
  const nodeMap = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes) nodeMap.set(node.id, node);

  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const node of workflow.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
  }

  const startNodes = workflow.nodes.filter(
    (n) => n.type === 'trigger' || (incoming.get(n.id)?.length ?? 0) === 0,
  );

  // Snapshot active project at workflow start — executors use this instead of the
  // mutable global, so mid-run project switches don't affect execution.
  const ap = getActiveProject();
  const projectSnapshot = ap
    ? { id: ap.id, name: ap.name, path: ap.path }
    : undefined;

  const context: ExecutionContext = {
    runId: crypto.randomUUID(),
    workflowId: workflow.id,
    variables: new Map<string, unknown>(),
    nodeStates: new Map(),
    status: 'running',
    startedAt: new Date().toISOString(),
    cancelled: false,
    loopStack: [],
    project: projectSnapshot,
    services: services ?? {},
  };
  // Carry the root cancel token so sub-workflow executors can hand it to
  // their children — the parent's own `cancelled` flag is only mirrored at
  // the loop head, which is suspended while a sub-workflow node runs.
  context.cancelToken = cancelToken ?? { cancelled: false };

  for (const v of workflow.variables) {
    if (v.defaultValue !== undefined) {
      context.variables.set(v.name, coerceVariable(v.defaultValue, v.type));
    }
  }

  if (initialVariables) {
    for (const [key, value] of initialVariables) {
      context.variables.set(key, value);
    }
  }

  if (triggerPayload !== undefined) {
    context.variables.set('__triggerPayload', triggerPayload);
  }

  const queue: string[] = startNodes.map((n) => n.id);
  const queueSet = new Set<string>(queue);
  const loopCounters = new Map<string, number>();
  // Loop nodes waiting for their body to finish before the next iteration
  const activeLoopBodies = new Map<string, Set<string>>();
  const requeueCounts = new Map<string, number>();
  const maxRequeues = workflow.nodes.length * 2;

  while ((queue.length > 0 || activeLoopBodies.size > 0) && !context.cancelled) {
    // External cancellation (RunManager cancelRun/shutdown) is signalled via
    // the shared cancel token — mirror it onto this run's context.
    if (cancelToken?.cancelled) {
      context.cancelled = true;
      break;
    }

    // Re-enqueue loop nodes whose body has fully completed
    for (const [loopId, bodyIds] of activeLoopBodies) {
      if (isBodyComplete(bodyIds, incoming, nodeMap, context)) {
        activeLoopBodies.delete(loopId);
        if (!queueSet.has(loopId)) {
          queue.push(loopId);
          queueSet.add(loopId);
        }
      }
    }
    // Remaining loop bodies can never complete (e.g. a body node failed) — stop
    if (queue.length === 0) break;

    const nodeId = queue.shift()!;
    queueSet.delete(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    if (!allPredecessorsComplete(nodeId, incoming, context, nodeMap)) {
      const count = (requeueCounts.get(nodeId) ?? 0) + 1;
      if (count > maxRequeues) {
        context.nodeStates.set(nodeId, {
          nodeId,
          status: 'failed',
          error: `Node "${node.label ?? nodeId}" stalled: predecessors never completed`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
        });
        emit({ type: 'error', message: `Predecessor stall detected for node "${node.label ?? nodeId}"` });
        continue;
      }
      requeueCounts.set(nodeId, count);
      queue.push(nodeId);
      queueSet.add(nodeId);
      continue;
    }

    const existingState = context.nodeStates.get(nodeId);
    if (existingState && (existingState.status === 'passed' || existingState.status === 'failed')) {
      if (node.type !== 'loop') {
        // A failed node must forward its ERROR edges, not its normal
        // successors — otherwise a stall-failed join re-dequeued later fires
        // its downstream branch in a run already reported as failed.
        if (existingState.status === 'failed') {
          handleFailure(node, outgoing, context, queue, queueSet, emit);
        } else {
          enqueueSuccessors(node, outgoing, context, queue, queueSet, emit);
        }
        continue;
      }
    }

    // At join nodes, propagate failure if any non-error predecessor failed
    if (anyPredecessorFailed(nodeId, incoming, context)) {
      context.nodeStates.set(nodeId, {
        nodeId,
        status: 'failed',
        error: `Skipped: predecessor on incoming branch failed`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        retryCount: 0,
      });
      emit({ type: 'node_done', nodeId, status: 'failed' });
      handleFailure(node, outgoing, context, queue, queueSet, emit);
      continue;
    }

    // The node is actually executing — its waiting is over, so its stall
    // budget resets (a legitimately-waiting join otherwise burns budget once
    // per interleaved node execution and false-positives near loops).
    requeueCounts.delete(nodeId);

    // Resolve {{loop.*}} against the innermost active loop whose body
    // contains this node — a single shared slot is clobbered by
    // nested/parallel loops.
    context.loopContext = loopContextForNode(nodeId, context);

    // Provide predecessor IDs so decision executor can find actual predecessors
    if (node.config.nodeType === 'decision') {
      const predecessorIds = (incoming.get(nodeId) ?? []).map((e) => e.source);
      context.variables.set('__predecessor_ids', predecessorIds);
    }

    const result = await executeNode(node, context, emit);

    // Clean up temporary predecessor context
    context.variables.delete('__predecessor_ids');

    if (node.config.nodeType === 'decision') {
      if (result.status === 'failed') {
        handleFailure(node, outgoing, context, queue, queueSet, emit);
      } else {
        handleDecision(node, outgoing, context, queue, queueSet, emit);
      }
      // Scope __decision_port to this decision — a stale value must never
      // route a later (or failed) decision down the wrong branch.
      context.variables.delete('__decision_port');
    } else if (node.config.nodeType === 'loop') {
      handleLoop(node, outgoing, incoming, context, queue, queueSet, emit, nodeMap, loopCounters, activeLoopBodies, requeueCounts);
    } else if (result.status === 'failed') {
      handleFailure(node, outgoing, context, queue, queueSet, emit);
    } else {
      enqueueSuccessors(node, outgoing, context, queue, queueSet, emit);
    }
  }

  const allStates = [...context.nodeStates.values()];
  const anyFailed = allStates.some((s) => s.status === 'failed');
  context.status = context.cancelled ? 'cancelled' : anyFailed ? 'failed' : 'passed';

  emit({ type: 'done', status: context.status });
  return context;
}

function allPredecessorsComplete(
  nodeId: string,
  incoming: Map<string, WorkflowEdge[]>,
  context: ExecutionContext,
  nodeMap: Map<string, WorkflowNode>,
): boolean {
  const edges = incoming.get(nodeId) ?? [];
  if (edges.length === 0) return true;

  return edges.every((edge) => {
    const state = context.nodeStates.get(edge.source);
    if (state && (state.status === 'passed' || state.status === 'failed')) return true;
    // Predecessors on an untaken decision branch will never run — treat them
    // as complete so a node joining both branches doesn't stall forever.
    return isNodeSkipped(edge.source, incoming, nodeMap, context, new Set());
  });
}

/**
 * An edge that can no longer fire, given its source's terminal state:
 * decision edges for unselected ports, conditional edges whose condition is
 * false, and error edges out of a node that passed. Nodes reachable only
 * through such edges count as skipped so joins do not stall forever.
 */
function isEdgeUntaken(
  edge: WorkflowEdge,
  nodeMap: Map<string, WorkflowNode>,
  context: ExecutionContext,
): boolean {
  const srcState = context.nodeStates.get(edge.source);
  const srcTerminal = srcState && (srcState.status === 'passed' || srcState.status === 'failed');

  // Error edges fire only on failure — after a pass they are dead.
  if (srcTerminal && edge.sourcePort === 'error' && srcState.status === 'passed') return true;

  // Conditional edge whose condition evaluated false never fires.
  if (srcTerminal && edge.condition && !evaluateEdgeCondition(edge, context)) return true;

  const srcNode = nodeMap.get(edge.source);
  if (srcNode?.config.nodeType !== 'decision') return false;
  if (srcState?.status !== 'passed') return false;
  // The decision executor stores the selected port in the node state output
  return typeof srcState.output === 'string' && edge.sourcePort !== srcState.output;
}

/**
 * Innermost active loop frame whose body contains `nodeId` (frames are
 * pushed outermost-first, so scan from the end).
 */
function loopContextForNode(nodeId: string, context: ExecutionContext) {
  const stack = context.loopStack ?? [];
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].bodyIds.has(nodeId)) return stack[i].ctx;
  }
  return undefined;
}

/**
 * A node is skipped when it can never run: it has no state and every incoming
 * edge is either on an untaken decision branch or comes from a skipped node.
 */
function isNodeSkipped(
  nodeId: string,
  incoming: Map<string, WorkflowEdge[]>,
  nodeMap: Map<string, WorkflowNode>,
  context: ExecutionContext,
  visiting: Set<string>,
): boolean {
  if (context.nodeStates.has(nodeId)) return false;
  if (visiting.has(nodeId)) return false; // cycle — assume not skipped
  visiting.add(nodeId);

  const edges = incoming.get(nodeId) ?? [];
  if (edges.length === 0) return false;

  return edges.every((edge) => {
    if (isEdgeUntaken(edge, nodeMap, context)) return true;
    const state = context.nodeStates.get(edge.source);
    if (state && (state.status === 'passed' || state.status === 'failed')) return false;
    return isNodeSkipped(edge.source, incoming, nodeMap, context, visiting);
  });
}

/** True when every body node has finished (or can never run this iteration). */
function isBodyComplete(
  bodyIds: Set<string>,
  incoming: Map<string, WorkflowEdge[]>,
  nodeMap: Map<string, WorkflowNode>,
  context: ExecutionContext,
): boolean {
  for (const id of bodyIds) {
    const state = context.nodeStates.get(id);
    if (state && (state.status === 'passed' || state.status === 'failed')) continue;
    if (isNodeSkipped(id, incoming, nodeMap, context, new Set())) continue;
    return false;
  }
  return true;
}

function anyPredecessorFailed(
  nodeId: string,
  incoming: Map<string, WorkflowEdge[]>,
  context: ExecutionContext,
): boolean {
  const edges = incoming.get(nodeId) ?? [];
  return edges.some((edge) => {
    // Error edges carry failure intentionally — don't propagate through them
    if (edge.sourcePort === 'error') return false;
    const state = context.nodeStates.get(edge.source);
    return state?.status === 'failed';
  });
}

function enqueueSuccessors(
  node: WorkflowNode,
  outgoing: Map<string, WorkflowEdge[]>,
  context: ExecutionContext,
  queue: string[],
  queueSet: Set<string>,
  emit: SSEEmitter,
): void {
  const edges = outgoing.get(node.id) ?? [];
  for (const edge of edges) {
    if (edge.sourcePort === 'error') continue;
    if (edge.condition && !evaluateEdgeCondition(edge, context)) continue;

    emit({ type: 'edge_traversed', edgeId: edge.id, source: edge.source, target: edge.target });
    if (!queueSet.has(edge.target)) {
      queue.push(edge.target);
      queueSet.add(edge.target);
    }
  }
}

function handleFailure(
  node: WorkflowNode,
  outgoing: Map<string, WorkflowEdge[]>,
  context: ExecutionContext,
  queue: string[],
  queueSet: Set<string>,
  emit: SSEEmitter,
): void {
  const edges = outgoing.get(node.id) ?? [];
  const errorEdges = edges.filter((e) => e.sourcePort === 'error');

  if (errorEdges.length > 0) {
    for (const edge of errorEdges) {
      emit({ type: 'edge_traversed', edgeId: edge.id, source: edge.source, target: edge.target });
      if (!queueSet.has(edge.target)) {
        queue.push(edge.target);
        queueSet.add(edge.target);
      }
    }
  }
}

function handleDecision(
  node: WorkflowNode,
  outgoing: Map<string, WorkflowEdge[]>,
  context: ExecutionContext,
  queue: string[],
  queueSet: Set<string>,
  emit: SSEEmitter,
): void {
  const edges = outgoing.get(node.id) ?? [];

  // Use __decision_port set by the decision executor — single source of truth
  const matchedPort = context.variables.get('__decision_port') as string | undefined;

  if (matchedPort) {
    emit({ type: 'decision_result', nodeId: node.id, port: matchedPort });

    for (const edge of edges) {
      if (edge.sourcePort === matchedPort) {
        emit({ type: 'edge_traversed', edgeId: edge.id, source: edge.source, target: edge.target });
        if (!queueSet.has(edge.target)) {
          queue.push(edge.target);
          queueSet.add(edge.target);
        }
      }
    }
  }
}

function handleLoop(
  node: WorkflowNode,
  outgoing: Map<string, WorkflowEdge[]>,
  incoming: Map<string, WorkflowEdge[]>,
  context: ExecutionContext,
  queue: string[],
  queueSet: Set<string>,
  emit: SSEEmitter,
  nodeMap: Map<string, WorkflowNode>,
  loopCounters: Map<string, number>,
  activeLoopBodies: Map<string, Set<string>>,
  requeueCounts: Map<string, number>,
): void {
  const config = node.config as LoopConfig;
  const maxIter = config.maxIterations ?? MAX_LOOP_ITERATIONS;
  const counter = loopCounters.get(node.id) ?? 0;

  const edges = outgoing.get(node.id) ?? [];
  const bodyEdges = edges.filter((e) => e.sourcePort !== 'done' && e.sourcePort !== 'error');
  const doneEdges = edges.filter((e) => e.sourcePort === 'done');

  const shouldContinue = evaluateLoopCondition(config, counter, context);

  if (shouldContinue && counter < maxIter) {
    const loopCtx = {
      index: counter,
      item: getLoopItem(config, counter, context),
      collection: getLoopCollection(config, context),
    };
    context.loopContext = loopCtx;
    // Expose the current item under the user-configured variable name — the
    // builder UI offers `itemVariable` and body nodes reference it via
    // {{variables.<name>}}.
    if (config.loopType === 'for-each' && config.itemVariable) {
      context.variables.set(config.itemVariable, loopCtx.item);
    }

    emit({ type: 'loop_iteration', nodeId: node.id, index: counter });
    loopCounters.set(node.id, counter + 1);

    const bodyNodeIds = collectBodyNodes(bodyEdges, outgoing, doneEdges.map((e) => e.target));

    // Register/refresh this loop's frame so body nodes resolve {{loop.*}}
    // against the right loop even when loops nest or run in parallel.
    const stack = (context.loopStack ??= []);
    const frame = stack.find((f) => f.loopId === node.id);
    if (frame) {
      frame.ctx = loopCtx;
      frame.bodyIds = bodyNodeIds;
    } else {
      stack.push({ loopId: node.id, bodyIds: bodyNodeIds, ctx: loopCtx });
    }

    for (const id of bodyNodeIds) {
      context.nodeStates.delete(id);
      // Reset per-node bookkeeping too: an inner loop must restart from
      // iteration 0 on each outer iteration, and body nodes get a fresh
      // stall budget.
      loopCounters.delete(id);
      activeLoopBodies.delete(id);
      requeueCounts.delete(id);
    }

    for (const edge of bodyEdges) {
      emit({ type: 'edge_traversed', edgeId: edge.id, source: edge.source, target: edge.target });
      if (!queueSet.has(edge.target)) {
        queue.push(edge.target);
        queueSet.add(edge.target);
      }
    }

    if (bodyNodeIds.size === 0) {
      // No body — re-evaluate the loop immediately
      if (!queueSet.has(node.id)) {
        queue.push(node.id);
        queueSet.add(node.id);
      }
    } else {
      // Wait for the whole body to complete before the next iteration —
      // the main loop re-enqueues this node once every body node is done.
      activeLoopBodies.set(node.id, bodyNodeIds);
    }

    context.nodeStates.delete(node.id);
  } else {
    context.loopContext = undefined;
    activeLoopBodies.delete(node.id);
    // Loop finished — drop its frame so nodes after it resolve {{loop.*}}
    // against the enclosing loop (if any) instead of this one.
    if (context.loopStack) {
      context.loopStack = context.loopStack.filter((f) => f.loopId !== node.id);
    }
    for (const edge of doneEdges) {
      emit({ type: 'edge_traversed', edgeId: edge.id, source: edge.source, target: edge.target });
      if (!queueSet.has(edge.target)) {
        queue.push(edge.target);
        queueSet.add(edge.target);
      }
    }
  }
}

function evaluateLoopCondition(
  config: LoopConfig,
  counter: number,
  context: ExecutionContext,
): boolean {
  switch (config.loopType) {
    case 'count':
      return counter < (config.count ?? 0);
    case 'while':
      return config.condition ? evaluate(config.condition, context) : false;
    case 'for-each': {
      const collection = getLoopCollection(config, context);
      return collection !== undefined && counter < (collection?.length ?? 0);
    }
    default:
      return false;
  }
}

function getLoopCollection(config: LoopConfig, context: ExecutionContext): unknown[] | undefined {
  if (!config.collection) return undefined;
  const value = context.variables.get(config.collection);
  return Array.isArray(value) ? value : undefined;
}

function getLoopItem(config: LoopConfig, index: number, context: ExecutionContext): unknown {
  if (config.loopType !== 'for-each') return undefined;
  const collection = getLoopCollection(config, context);
  return collection?.[index];
}

function collectBodyNodes(
  bodyEdges: WorkflowEdge[],
  outgoing: Map<string, WorkflowEdge[]>,
  exitNodeIds: string[],
): Set<string> {
  const bodyNodes = new Set<string>();
  const visited = new Set<string>();
  const stack = bodyEdges.map((e) => e.target);

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id) || exitNodeIds.includes(id)) continue;
    visited.add(id);
    bodyNodes.add(id);

    const successors = outgoing.get(id) ?? [];
    for (const edge of successors) {
      stack.push(edge.target);
    }
  }

  return bodyNodes;
}

function evaluateEdgeCondition(edge: WorkflowEdge, context: ExecutionContext): boolean {
  if (!edge.condition) return true;

  const { type, variable, operator, value, expression } = edge.condition;

  switch (type) {
    case 'expression':
      return expression ? evaluate(expression, context) : true;

    case 'exit-code': {
      const sourceState = context.nodeStates.get(edge.source);
      const exitCode = sourceState?.exitCode;
      const target = value !== undefined ? Number(value) : 0;
      return exitCode === target;
    }

    case 'variable-match': {
      if (!variable || !operator) return true;
      const actual = String(context.variables.get(variable) ?? '');
      const expected = value ?? '';
      return compareValues(actual, expected, operator);
    }

    default:
      return true;
  }
}

function compareValues(
  left: string,
  right: string,
  operator: string,
): boolean {
  switch (operator) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '>': return Number(left) > Number(right);
    case '<': return Number(left) < Number(right);
    case '>=': return Number(left) >= Number(right);
    case '<=': return Number(left) <= Number(right);
    case 'contains': return left.includes(right);
    case 'matches': {
      try {
        if (right.length > 200) return false;
        return new RegExp(right).test(left);
      } catch { return false; }
    }
    default: return false;
  }
}

function coerceVariable(value: string, type: string): unknown {
  switch (type) {
    case 'number': return Number(value);
    case 'boolean': return value === 'true';
    case 'json': {
      try { return JSON.parse(value); } catch { return value; }
    }
    default: return value;
  }
}
