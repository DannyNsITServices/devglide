import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { Workflow } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { WORKFLOWS_DIR, INSTRUCTIONS_DIR, PROJECTS_DIR, projectDataDir } from '../../../packages/paths.js';
import { JsonFileStore } from '../../../packages/json-file-store.js';

// ── Zod schema for validating workflow JSON files from disk ──────────────────
const workflowFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    label: z.string(),
    config: z.record(z.unknown()),
    position: z.object({ x: z.number(), y: z.number() }),
  }).passthrough()),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
  }).passthrough()),
  variables: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'json']),
  }).passthrough()).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  description: z.string().optional(),
  projectId: z.string().optional(),
  enabled: z.boolean().optional(),
  global: z.boolean().optional(),
}).passthrough();

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  version: number;
  projectId?: string;
  tags: string[];
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
  scope: 'project' | 'global';
  enabled?: boolean;
  global?: boolean;
}

/**
 * Per-project and global workflow storage.
 * One JSON file per workflow for git-friendly diffs.
 */
export class WorkflowStore extends JsonFileStore<Workflow> {
  private static instance: WorkflowStore;
  protected readonly baseDir = WORKFLOWS_DIR;

  static getInstance(): WorkflowStore {
    if (!WorkflowStore.instance) {
      WorkflowStore.instance = new WorkflowStore();
    }
    return WorkflowStore.instance;
  }

  /** Override to add Zod validation on disk reads. */
  protected override async readEntityFile(filePath: string): Promise<Workflow | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = workflowFileSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(`[workflow-store] Invalid workflow file ${filePath}: ${result.error.issues[0]?.message}`);
        return null;
      }
      return result.data as unknown as Workflow;
    } catch {
      return null;
    }
  }

  async list(projectId?: string): Promise<WorkflowSummary[]> {
    const seen = new Map<string, WorkflowSummary>();
    const scopeId = projectId ?? getActiveProject()?.id;

    // Project-scoped workflows take precedence over global
    const projectDir = this.getProjectDir();
    if (projectDir) {
      for (const s of await this.scanDir(projectDir, 'project')) {
        seen.set(s.id, s);
      }
    }

    const globalDir = this.getGlobalDir();
    for (const s of await this.scanDir(globalDir, 'global')) {
      if (seen.has(s.id)) continue;
      // In a project context, only include global-dir workflows that are either:
      // - explicitly marked global, OR
      // - belong to this project (projectId matches)
      // Unscoped workflows (no projectId, not global) are legacy — skip in project context
      if (scopeId && !s.global) {
        if (!s.projectId || s.projectId !== scopeId) continue;
      }
      seen.set(s.id, s);
    }

    return [...seen.values()];
  }

  async listFull(projectId?: string): Promise<Workflow[]> {
    const seen = new Map<string, Workflow>();
    const scopeId = projectId ?? getActiveProject()?.id;

    const projectDir = this.getProjectDir();
    if (projectDir) {
      for (const w of await this.scanDirFull(projectDir)) {
        seen.set(w.id, w);
      }
    }

    const globalDir = this.getGlobalDir();
    for (const w of await this.scanDirFull(globalDir)) {
      if (seen.has(w.id)) continue;
      if (scopeId && !w.global) {
        if (!w.projectId || w.projectId !== scopeId) continue;
      }
      seen.set(w.id, w);
    }

    return [...seen.values()];
  }

  async save(
    input: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; scope?: 'project' | 'global'; enabled?: boolean },
  ): Promise<Workflow> {
    const lockKey = input.id ?? this.generateId();
    return this.withLock(lockKey, async () => {
      const now = new Date().toISOString();
      const isUpdate = !!input.id;

      let existing: Workflow | null = null;
      let oldScope: 'project' | 'global' | undefined;
      if (isUpdate) {
        existing = await this.get(input.id!);
        oldScope = await this.resolveExistingScope(input.id!);
      }

      const workflow: Workflow = {
        id: input.id ?? lockKey,
        name: input.name,
        description: input.description,
        version: input.version,
        projectId: input.projectId ?? existing?.projectId ?? getActiveProject()?.id,
        tags: input.tags,
        enabled: input.enabled,
        global: input.global,
        nodes: input.nodes,
        edges: input.edges,
        variables: input.variables,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      // When updating, preserve the original storage location; only new workflows use default scope
      let scope = input.scope;
      if (input.global === true) {
        scope = 'global';
      } else if (input.global === false && workflow.projectId) {
        scope = 'project';
      } else if (!scope && isUpdate) {
        scope = oldScope;
      }
      scope = scope ?? (getActiveProject() ? 'project' : 'global');

      await this.writeEntity(workflow, scope, workflow.projectId);

      // If scope changed during update, clean up old file location
      if (isUpdate && oldScope && oldScope !== scope) {
        await this.removeFromScope(workflow.id, oldScope, existing?.projectId ?? getActiveProject()?.id);
      }

      await this.generateInstructionsFile(workflow.projectId);

      return workflow;
    });
  }

  override async delete(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      const existing = await this.get(id);
      const projectDir = this.getProjectDir();
      if (projectDir) {
        try {
          await fs.unlink(path.join(projectDir, `${id}.json`));
          await this.generateInstructionsFile(existing?.projectId);
          return true;
        } catch {
          // Not in project dir, try global
        }
      }

      try {
        await fs.unlink(path.join(this.getGlobalDir(), `${id}.json`));
        await this.generateInstructionsFile(existing?.projectId);
        return true;
      } catch {
        return false;
      }
    });
  }

  async exists(id: string): Promise<boolean> {
    return (await this.get(id)) !== null;
  }

  async generateInstructionsFile(projectId?: string): Promise<void> {
    const markdown = await this.buildInstructionsMarkdown(projectId);
    if (projectId) {
      // ~/.devglide/projects/{projectId}/instructions.md
      const dir = projectDataDir(projectId, '');
      await this.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'instructions.md'), markdown);
    } else {
      // Global: ~/.devglide/instructions/_global.md
      await this.ensureDir(INSTRUCTIONS_DIR);
      await fs.writeFile(path.join(INSTRUCTIONS_DIR, '_global.md'), markdown);
    }
  }

  async getCompiledInstructions(projectId?: string): Promise<string> {
    return this.buildInstructionsMarkdown(projectId);
  }

  async match(prompt: string, projectId?: string): Promise<{ matches: Array<{ id: string; name: string; description?: string; tags: string[]; score: number; instructions: string }> }> {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return { matches: [] };

    const workflows = await this.listFull(projectId);
    const scored: Array<{ id: string; name: string; description?: string; tags: string[]; score: number; workflow: Workflow }> = [];

    for (const w of workflows) {
      if (w.enabled === false) continue;

      const corpus = this.buildSearchCorpus(w);
      const score = this.scoreMatch(tokens, corpus);
      if (score > 0) {
        scored.push({ id: w.id, name: w.name, description: w.description, tags: w.tags, score, workflow: w });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    const matches = scored.map(({ id, name, description, tags, score, workflow }) => ({
      id,
      name,
      description,
      tags,
      score,
      instructions: this.buildSingleWorkflowMarkdown(workflow),
    }));

    return { matches };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  private buildSearchCorpus(w: Workflow): string {
    const parts: string[] = [
      w.name,
      w.description ?? '',
      ...w.tags,
    ];

    for (const node of w.nodes) {
      parts.push(node.label);
      const config = node.config as any;
      if (config.triggerType) parts.push(config.triggerType);
      if (config.gitEvent) parts.push(config.gitEvent);
      if (config.operation) parts.push(config.operation);
      if (config.instructions) parts.push(config.instructions);
      if (config.command) parts.push(config.command);
    }

    return parts.join(' ').toLowerCase();
  }

  private scoreMatch(tokens: string[], corpus: string): number {
    let score = 0;
    for (const token of tokens) {
      if (corpus.includes(token)) score++;
    }
    return score;
  }

  private buildSingleWorkflowMarkdown(workflow: Workflow): string {
    const lines: string[] = [`## ${workflow.name}`];
    if (workflow.description) lines.push('', workflow.description);

    const steps = this.compileWorkflowSteps(workflow);
    for (const step of steps) {
      lines.push('', `### Step ${step.stepNumber}: ${step.label}`);
      if (step.instructions) lines.push(step.instructions);
      else if (step.instructionFile) lines.push(`See: ${step.instructionFile}`);
    }

    return lines.join('\n');
  }

  private async buildInstructionsMarkdown(projectId?: string): Promise<string> {
    const workflows = await this.listFull(projectId);
    const filtered = workflows.filter((w) => w.enabled !== false);

    const lines: string[] = [
      '# DevGlide Workflow Instructions',
      '',
      '> Auto-generated. Do not edit manually.',
      `> Last updated: ${new Date().toISOString()}`,
    ];

    for (const workflow of filtered) {
      lines.push('', `## ${workflow.name}`);
      if (workflow.description) {
        lines.push('', workflow.description);
      }

      const steps = this.compileWorkflowSteps(workflow);
      for (const step of steps) {
        lines.push('', `### Step ${step.stepNumber}: ${step.label}`);
        if (step.instructions) {
          lines.push(step.instructions);
        } else if (step.instructionFile) {
          lines.push(`See: ${step.instructionFile}`);
        }
      }

      lines.push('', '---');
    }

    return lines.join('\n') + '\n';
  }

  private compileWorkflowSteps(workflow: Workflow): Array<{ stepNumber: number; label: string; instructions?: string; instructionFile?: string }> {
    const adjacency = new Map<string, string[]>();
    const incomingCount = new Map<string, number>();

    for (const node of workflow.nodes) {
      adjacency.set(node.id, []);
      incomingCount.set(node.id, 0);
    }

    for (const edge of workflow.edges) {
      adjacency.get(edge.source)?.push(edge.target);
      incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    }

    // Start nodes: no incoming edges
    const queue: string[] = [];
    for (const node of workflow.nodes) {
      if ((incomingCount.get(node.id) ?? 0) === 0) {
        queue.push(node.id);
      }
    }

    const ordered: string[] = [];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      ordered.push(nodeId);

      for (const neighbor of adjacency.get(nodeId) ?? []) {
        const count = (incomingCount.get(neighbor) ?? 1) - 1;
        incomingCount.set(neighbor, count);
        if (count === 0) {
          queue.push(neighbor);
        }
      }
    }

    const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));
    const steps: Array<{ stepNumber: number; label: string; instructions?: string; instructionFile?: string }> = [];
    let stepNumber = 1;

    for (const nodeId of ordered) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      const config = node.config as any;
      steps.push({
        stepNumber: stepNumber++,
        label: node.label,
        instructions: config.instructions,
        instructionFile: config.instructionFile,
      });
    }

    return steps;
  }

  private async scanDir(dir: string, scope: 'project' | 'global'): Promise<WorkflowSummary[]> {
    const summaries: WorkflowSummary[] = [];
    const workflows = await this.scanDirFull(dir);

    for (const workflow of workflows) {
      summaries.push({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        projectId: workflow.projectId,
        tags: workflow.tags,
        nodeCount: workflow.nodes.length,
        edgeCount: workflow.edges.length,
        updatedAt: workflow.updatedAt,
        scope,
        enabled: workflow.enabled,
        global: workflow.global,
      });
    }

    return summaries;
  }
}
