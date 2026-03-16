import type { WorkflowNode, WorkflowEdge } from '../types.js';
import { getRegisteredTypes } from '../engine/node-registry.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a workflow graph for structural correctness:
 * - Trigger node presence
 * - Node type validity
 * - Edge reference integrity
 * - Decision node port requirements
 * - Disconnected node detection
 * - Cycle detection via DFS
 */
export function validateWorkflowGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): ValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const registeredTypes = new Set(getRegisteredTypes());

  // Must have at least one trigger
  const triggerNodes = nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length === 0) {
    errors.push('Workflow must have at least one trigger node');
  }

  // Node type validation
  for (const node of nodes) {
    if (node.type !== 'trigger' && node.type !== 'sub-workflow' && !registeredTypes.has(node.type)) {
      errors.push(`Node "${node.label}" (${node.id}) has unknown type "${node.type}"`);
    }
  }

  // Edge reference integrity
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge "${edge.id}" references non-existent source node "${edge.source}"`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge "${edge.id}" references non-existent target node "${edge.target}"`);
    }
  }

  // Decision node port requirements
  for (const node of nodes) {
    if (node.type === 'decision') {
      const config = node.config as any;
      if (!config.ports || !Array.isArray(config.ports) || config.ports.length === 0) {
        errors.push(`Decision node "${node.label}" (${node.id}) must have at least one port`);
      }
    }
  }

  // Disconnected node detection
  for (const node of nodes) {
    if (node.type === 'trigger') continue;
    const hasIncoming = edges.some((e) => e.target === node.id);
    const hasOutgoing = edges.some((e) => e.source === node.id);
    if (!hasIncoming && !hasOutgoing) {
      errors.push(`Node "${node.label}" (${node.id}) is disconnected from the graph`);
    }
  }

  // Cycle detection via DFS (three-color algorithm)
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  for (const node of nodes) colors.set(node.id, WHITE);

  let hasCycle = false;

  function dfs(nodeId: string): void {
    if (hasCycle) return;
    colors.set(nodeId, GRAY);
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      const color = colors.get(neighbor);
      if (color === GRAY) { hasCycle = true; return; }
      if (color === WHITE) dfs(neighbor);
    }
    colors.set(nodeId, BLACK);
  }

  for (const node of nodes) {
    if (colors.get(node.id) === WHITE) {
      dfs(node.id);
      if (hasCycle) break;
    }
  }

  if (hasCycle) errors.push('Workflow graph contains a cycle');

  return { valid: errors.length === 0, errors };
}
