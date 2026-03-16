import { describe, it, expect, vi } from 'vitest';
import type { WorkflowNode, WorkflowEdge } from '../types.js';

// Mock the node registry before importing the validator
vi.mock('../engine/node-registry.js', () => ({
  getRegisteredTypes: () => ['trigger', 'action:shell', 'action:kanban', 'decision', 'loop'],
}));

const { validateWorkflowGraph } = await import('./workflow-validator.js');

function makeNode(id: string, type: string, label?: string): WorkflowNode {
  return { id, type: type as WorkflowNode['type'], label: label ?? id, config: {} as WorkflowNode['config'], position: { x: 0, y: 0 } };
}

function makeEdge(source: string, target: string): WorkflowEdge {
  return { id: `${source}-${target}`, source, target };
}

describe('validateWorkflowGraph', () => {
  it('passes a valid linear graph', () => {
    const nodes = [
      makeNode('t1', 'trigger'),
      makeNode('a1', 'action:shell'),
    ];
    const edges = [makeEdge('t1', 'a1')];
    const result = validateWorkflowGraph(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requires at least one trigger node', () => {
    const nodes = [makeNode('a1', 'action:shell')];
    const result = validateWorkflowGraph(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow must have at least one trigger node');
  });

  it('rejects unknown node types', () => {
    const nodes = [
      makeNode('t1', 'trigger'),
      makeNode('x1', 'action:unknown', 'MyNode'),
    ];
    const edges = [makeEdge('t1', 'x1')];
    const result = validateWorkflowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('unknown type');
  });

  it('detects dangling edge references', () => {
    const nodes = [makeNode('t1', 'trigger')];
    const edges = [makeEdge('t1', 'nonexistent')];
    const result = validateWorkflowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('non-existent target');
  });

  it('detects disconnected nodes', () => {
    const nodes = [
      makeNode('t1', 'trigger'),
      makeNode('a1', 'action:shell', 'Orphan'),
    ];
    const result = validateWorkflowGraph(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('disconnected'))).toBe(true);
  });

  it('detects cycles', () => {
    const nodes = [
      makeNode('t1', 'trigger'),
      makeNode('a1', 'action:shell'),
      makeNode('a2', 'action:shell'),
    ];
    const edges = [
      makeEdge('t1', 'a1'),
      makeEdge('a1', 'a2'),
      makeEdge('a2', 'a1'), // cycle
    ];
    const result = validateWorkflowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow graph contains a cycle');
  });

  it('detects decision nodes without ports', () => {
    const nodes = [
      makeNode('t1', 'trigger'),
      makeNode('d1', 'decision', 'MyDecision'),
    ];
    const edges = [makeEdge('t1', 'd1')];
    const result = validateWorkflowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must have at least one port'))).toBe(true);
  });

  it('allows sub-workflow nodes without registry check', () => {
    const nodes = [
      makeNode('t1', 'trigger'),
      makeNode('sw1', 'sub-workflow'),
    ];
    const edges = [makeEdge('t1', 'sw1')];
    const result = validateWorkflowGraph(nodes, edges);
    expect(result.valid).toBe(true);
  });
});
