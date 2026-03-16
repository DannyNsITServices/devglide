import type { NodeType, ExecutorFunction } from '../types.js';

const registry = new Map<NodeType, ExecutorFunction>();

export function registerExecutor(type: NodeType, executor: ExecutorFunction): void {
  registry.set(type, executor);
}

export function getExecutor(type: NodeType): ExecutorFunction | undefined {
  return registry.get(type);
}

export function getRegisteredTypes(): NodeType[] {
  return [...registry.keys()];
}
