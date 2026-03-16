import { randomUUID } from 'crypto';
import type { Workflow, WorkflowNode, WorkflowEdge } from '../types.js';

interface LegacyStep {
  name: string;
  cmd: string;
  cwd?: string;
}

interface LegacyWorkflow {
  id?: string;
  name: string;
  description?: string;
  ecosystem?: string;
  steps: LegacyStep[];
}

/**
 * Converts legacy `{ id, name, description, ecosystem, steps }` format
 * to the new graph-based workflow format.
 */
export function convertLegacyWorkflow(legacy: LegacyWorkflow): Workflow {
  const now = new Date().toISOString();

  const triggerNode: WorkflowNode = {
    id: randomUUID(),
    type: 'trigger',
    label: 'Manual Trigger',
    config: {
      nodeType: 'trigger',
      triggerType: 'manual',
    },
    position: { x: 400, y: 0 },
  };

  const stepNodes: WorkflowNode[] = legacy.steps.map((step, i) => ({
    id: randomUUID(),
    type: 'action:shell' as const,
    label: step.name,
    config: {
      nodeType: 'action:shell' as const,
      command: step.cmd,
      ...(step.cwd ? { cwd: step.cwd } : {}),
      captureOutput: true,
    },
    position: { x: 400, y: 100 + i * 150 },
  }));

  const allNodes = [triggerNode, ...stepNodes];

  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < allNodes.length - 1; i++) {
    edges.push({
      id: randomUUID(),
      source: allNodes[i].id,
      target: allNodes[i + 1].id,
    });
  }

  return {
    id: legacy.id ?? randomUUID(),
    name: legacy.name,
    description: legacy.description,
    version: 1,
    tags: legacy.ecosystem ? [legacy.ecosystem] : [],
    nodes: allNodes,
    edges,
    variables: [],
    createdAt: now,
    updatedAt: now,
  };
}
