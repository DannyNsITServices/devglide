import fs from 'fs/promises';
import path from 'path';
import type { DocEntry, DocSummary, DocType } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { DOCUMENTATION_DIR, PROJECTS_DIR } from '../../../packages/paths.js';
import { JsonFileStore } from '../../../packages/json-file-store.js';
import { SEED_ENTRIES } from './seed-data.js';

/**
 * Per-project and global documentation storage.
 * One JSON file per entry for git-friendly diffs.
 * Global: ~/.devglide/documentation/
 * Per-project: ~/.devglide/projects/{projectId}/documentation/
 */
export class DocumentationStore extends JsonFileStore<DocEntry> {
  private static instance: DocumentationStore;
  protected readonly baseDir = DOCUMENTATION_DIR;

  private seedDone = false;

  static getInstance(): DocumentationStore {
    if (!DocumentationStore.instance) {
      DocumentationStore.instance = new DocumentationStore();
    }
    return DocumentationStore.instance;
  }

  /**
   * Write embedded seed entries into the global documentation directory
   * if they do not already exist. Uses in-memory seed data so it works
   * in both source mode (tsx) and bundled mode (dist/mcp/*.mjs).
   */
  private async ensureSeeded(): Promise<void> {
    if (this.seedDone) return;
    this.seedDone = true;

    const globalDir = this.getGlobalDir();
    await this.ensureDir(globalDir);

    for (const entry of SEED_ENTRIES) {
      const targetPath = path.join(globalDir, `${entry.id}.json`);
      try {
        await fs.access(targetPath);
        // Already exists — skip
      } catch {
        await fs.writeFile(targetPath, JSON.stringify(entry, null, 2));
      }
    }
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async list(filter?: { type?: DocType; toolName?: string; tag?: string }): Promise<DocSummary[]> {
    await this.ensureSeeded();
    const seen = new Map<string, DocSummary>();

    const projectDir = this.getProjectDir();
    if (projectDir) {
      for (const s of await this.scanDir(projectDir, 'project')) {
        seen.set(s.id, s);
      }
      for (const s of await this.scanDir(this.getGlobalDir(), 'global')) {
        if (!seen.has(s.id)) seen.set(s.id, s);
      }
    } else {
      for (const s of await this.scanDir(this.getGlobalDir(), 'global')) {
        if (!seen.has(s.id)) seen.set(s.id, s);
      }
    }

    let results = [...seen.values()];

    if (filter?.type) {
      results = results.filter((e) => e.type === filter.type);
    }
    if (filter?.toolName) {
      const name = filter.toolName.toLowerCase();
      results = results.filter((e) => e.title.toLowerCase().includes(name) || e.summary.toLowerCase().includes(name));
    }
    if (filter?.tag) {
      results = results.filter((e) => e.tags.includes(filter.tag!));
    }

    return results;
  }

  // ── Match (keyword search) ────────────────────────────────────────────────

  async match(query: string): Promise<DocSummary[]> {
    const all = await this.list();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all;

    const scored: Array<{ entry: DocSummary; score: number }> = [];

    for (const entry of all) {
      const haystack = [entry.title, entry.summary, ...entry.tags, entry.type].join(' ').toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.entry);
  }

  // ── Save (with validation) ────────────────────────────────────────────────

  async save(
    input: Omit<DocEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; scope?: 'project' | 'global' },
  ): Promise<DocEntry> {
    // Validate required fields per type
    this.validateEntry(input);

    const lockKey = input.id ?? this.generateId();
    return this.withLock(lockKey, async () => {
      const now = new Date().toISOString();
      const isUpdate = !!input.id;

      let existing: DocEntry | null = null;
      if (isUpdate) {
        existing = await this.get(input.id!);
      }

      // Strip the transient routing-only `scope` field so it is never
      // persisted — a stale persisted scope re-fed by docs_update would
      // short-circuit scope resolution and write to the wrong dir.
      const { scope: inputScope, ...fields } = input;

      const entry = {
        ...fields,
        id: input.id ?? lockKey,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as DocEntry;

      let scope = inputScope;
      if (!scope && isUpdate) {
        scope = await this.resolveExistingScope(input.id!);
      }
      scope = scope ?? (getActiveProject() ? 'project' : 'global');

      const activeProjectId = getActiveProject()?.id;
      // Record the owning project on project-scoped entries so
      // getCompiledContext can filter out other projects' overrides.
      entry.projectId = scope === 'project' && activeProjectId ? activeProjectId : undefined;

      await this.writeEntity(entry, scope, activeProjectId);
      return entry;
    });
  }

  // ── Compiled context ──────────────────────────────────────────────────────

  async getCompiledContext(query?: string, projectId?: string): Promise<string> {
    await this.ensureSeeded();
    let entries: DocEntry[];

    if (query) {
      // match() calls list() which uses active project context.
      // If projectId is specified, also scan that project dir explicitly.
      const summaries = await this.match(query);
      const fullEntries: DocEntry[] = [];
      for (const s of summaries.slice(0, 10)) {
        const full = await this.get(s.id);
        if (full) fullEntries.push(full);
      }

      // Merge in entries from the specified project dir if it differs from active
      if (projectId) {
        const projectOverrides = await this.listFullForProject(projectId);
        for (const e of projectOverrides) {
          if (!fullEntries.some((f) => f.id === e.id)) {
            fullEntries.push(e);
          }
        }
      }

      entries = fullEntries;
    } else {
      entries = await this.listFull();
      // Merge in entries from the specified project dir if it differs from active
      if (projectId) {
        const projectOverrides = await this.listFullForProject(projectId);
        for (const e of projectOverrides) {
          if (!entries.some((f) => f.id === e.id)) {
            entries.push(e);
          }
        }
      }
    }

    if (projectId) {
      // Filter out entries from other projects, keep global + target project
      entries = entries.filter((e) => !e.projectId || e.projectId === projectId);
    }

    if (entries.length === 0) return '';

    const lines: string[] = ['# DevGlide Documentation Context', ''];

    const byType = new Map<string, DocEntry[]>();
    for (const entry of entries) {
      if (!byType.has(entry.type)) byType.set(entry.type, []);
      byType.get(entry.type)!.push(entry);
    }

    const typeLabels: Record<string, string> = {
      'tool-guide': 'Tool Guides',
      'workflow': 'Workflows',
      'example': 'Examples',
      'troubleshooting': 'Troubleshooting',
      'project-override': 'Project Overrides',
    };

    for (const [type, typeEntries] of byType) {
      lines.push(`## ${typeLabels[type] ?? type}`, '');
      for (const entry of typeEntries) {
        lines.push(this.renderEntry(entry), '');
      }
    }

    return lines.join('\n');
  }

  // ── Specific getters ──────────────────────────────────────────────────────

  async getToolGuide(toolName: string): Promise<DocEntry | null> {
    await this.ensureSeeded();
    const all = await this.listFull();
    const normalized = toolName.toLowerCase();
    return all.find((e) => e.type === 'tool-guide' && (e as any).toolName.toLowerCase() === normalized) ?? null;
  }

  async getWorkflow(name: string): Promise<DocEntry | null> {
    await this.ensureSeeded();
    const all = await this.listFull();
    const normalized = name.toLowerCase();
    return all.find((e) => e.type === 'workflow' && (e as any).name.toLowerCase() === normalized) ?? null;
  }

  async getTroubleshooting(toolName: string, symptom: string): Promise<DocEntry[]> {
    await this.ensureSeeded();
    const all = await this.listFull();
    const normalizedTool = toolName.toLowerCase();
    const normalizedSymptom = symptom.toLowerCase();

    return all.filter((e) => {
      if (e.type !== 'troubleshooting') return false;
      const ts = e as any;
      const toolMatch = ts.toolName.toLowerCase() === normalizedTool;
      const symptomMatch = ts.symptom.toLowerCase().includes(normalizedSymptom);
      return toolMatch && symptomMatch;
    });
  }

  // ── Validation ────────────────────────────────────────────────────────────

  private validateEntry(input: Record<string, unknown>): void {
    const type = input.type as string;
    if (!type) throw new Error('type is required');

    // Ensure tags is an array
    if (!Array.isArray(input.tags)) input.tags = [];

    switch (type) {
      case 'tool-guide':
        this.requireStrings(input, ['toolName', 'summary', 'executionModel']);
        this.requireArrays(input, ['prerequisites', 'preferredPatterns', 'antiPatterns', 'followUpChecks', 'commonFailures', 'seeAlso']);
        if (!input.resultSemantics || typeof input.resultSemantics !== 'object') input.resultSemantics = {};
        if (!input.inputsExplained || typeof input.inputsExplained !== 'object') input.inputsExplained = {};
        break;
      case 'workflow':
        this.requireStrings(input, ['name', 'goal']);
        this.requireArrays(input, ['toolsInvolved', 'preflight', 'stepSequence', 'successCriteria', 'failureBranches', 'expectedOutputs', 'expectedNoise']);
        break;
      case 'example':
        this.requireStrings(input, ['toolName', 'scenario']);
        this.requireArrays(input, ['startingAssumptions', 'toolSequence', 'whatGoodLooksLike', 'whatBadLooksLike', 'whatToDoNext']);
        break;
      case 'troubleshooting':
        this.requireStrings(input, ['toolName', 'symptom']);
        this.requireArrays(input, ['likelyCauses', 'howToDiagnose', 'howToFix']);
        if (typeof input.whenToRetry !== 'string') input.whenToRetry = '';
        break;
      case 'project-override':
        this.requireStrings(input, ['targetToolName', 'notes']);
        if (!input.overrides || typeof input.overrides !== 'object') input.overrides = {};
        break;
      default:
        throw new Error(`Unknown document type: ${type}`);
    }
  }

  private requireStrings(input: Record<string, unknown>, fields: string[]): void {
    for (const field of fields) {
      if (typeof input[field] !== 'string') {
        throw new Error(`${field} is required and must be a string`);
      }
    }
  }

  private requireArrays(input: Record<string, unknown>, fields: string[]): void {
    for (const field of fields) {
      if (!Array.isArray(input[field])) input[field] = [];
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async listFull(): Promise<DocEntry[]> {
    const seen = new Map<string, DocEntry>();

    const projectDir = this.getProjectDir();
    if (projectDir) {
      for (const e of await this.scanDirFull(projectDir)) {
        seen.set(e.id, e);
      }
      for (const e of await this.scanDirFull(this.getGlobalDir())) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
    } else {
      for (const e of await this.scanDirFull(this.getGlobalDir())) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
    }

    return [...seen.values()];
  }

  /**
   * Scan a specific project's documentation directory by projectId,
   * regardless of which project is currently active.
   */
  private async listFullForProject(projectId: string): Promise<DocEntry[]> {
    // Guard against path traversal via a crafted projectId
    if (/[\\/]/.test(projectId) || projectId === '.' || projectId === '..') return [];
    const featureName = path.basename(this.baseDir);
    const projectDir = path.join(PROJECTS_DIR, projectId, featureName);
    return this.scanDirFull(projectDir);
  }

  private toSummary(entry: DocEntry, scope: 'project' | 'global'): DocSummary {
    return {
      id: entry.id,
      type: entry.type,
      title: this.getTitle(entry),
      summary: this.getSummary(entry),
      tags: entry.tags ?? [],
      scope,
      updatedAt: entry.updatedAt,
    };
  }

  private getTitle(entry: DocEntry): string {
    switch (entry.type) {
      case 'tool-guide': return entry.toolName;
      case 'workflow': return entry.name;
      case 'example': return `${entry.toolName}: ${entry.scenario}`;
      case 'troubleshooting': return `${entry.toolName}: ${entry.symptom}`;
      case 'project-override': return `Override: ${entry.targetToolName}`;
    }
  }

  private getSummary(entry: DocEntry): string {
    switch (entry.type) {
      case 'tool-guide': return entry.summary;
      case 'workflow': return entry.goal;
      case 'example': return entry.scenario;
      case 'troubleshooting': return entry.symptom;
      case 'project-override': return entry.notes;
    }
  }

  private renderEntry(entry: DocEntry): string {
    switch (entry.type) {
      case 'tool-guide':
        return [
          `### ${entry.toolName}`,
          entry.summary,
          '',
          `**Execution model:** ${entry.executionModel}`,
          '',
          '**Prerequisites:**',
          ...(entry.prerequisites ?? []).map((p) => `- ${p}`),
          '',
          '**Result semantics:**',
          ...Object.entries(entry.resultSemantics ?? {}).map(([k, v]) => `- \`${k}\`: ${v}`),
          '',
          '**Preferred patterns:**',
          ...(entry.preferredPatterns ?? []).map((p) => `- ${p}`),
          '',
          '**Anti-patterns:**',
          ...(entry.antiPatterns ?? []).map((p) => `- ${p}`),
          '',
          '**Follow-up checks:**',
          ...(entry.followUpChecks ?? []).map((c) => `- ${c}`),
        ].join('\n');

      case 'workflow':
        return [
          `### ${entry.name}`,
          entry.goal,
          '',
          `**Tools:** ${(entry.toolsInvolved ?? []).join(', ')}`,
          '',
          '**Steps:**',
          ...(entry.stepSequence ?? []).map((s, i) => `${i + 1}. ${s}`),
          '',
          '**Success criteria:**',
          ...(entry.successCriteria ?? []).map((c) => `- ${c}`),
          '',
          '**Failure branches:**',
          ...(entry.failureBranches ?? []).map((f) => `- ${f}`),
        ].join('\n');

      case 'example':
        return [
          `### ${entry.toolName}: ${entry.scenario}`,
          '',
          '**Starting assumptions:**',
          ...(entry.startingAssumptions ?? []).map((a) => `- ${a}`),
          '',
          '**Tool sequence:**',
          ...(entry.toolSequence ?? []).map((s, i) => `${i + 1}. ${s}`),
          '',
          '**Good outcome:**',
          ...(entry.whatGoodLooksLike ?? []).map((g) => `- ${g}`),
          '',
          '**Bad outcome:**',
          ...(entry.whatBadLooksLike ?? []).map((b) => `- ${b}`),
          '',
          '**Next steps if bad:**',
          ...(entry.whatToDoNext ?? []).map((n) => `- ${n}`),
        ].join('\n');

      case 'troubleshooting':
        return [
          `### ${entry.toolName}: ${entry.symptom}`,
          '',
          '**Likely causes:**',
          ...(entry.likelyCauses ?? []).map((c) => `- ${c}`),
          '',
          '**How to diagnose:**',
          ...(entry.howToDiagnose ?? []).map((d) => `- ${d}`),
          '',
          '**How to fix:**',
          ...(entry.howToFix ?? []).map((f) => `- ${f}`),
          '',
          `**When to retry:** ${entry.whenToRetry ?? ''}`,
        ].join('\n');

      case 'project-override':
        return [
          `### Override: ${entry.targetToolName}`,
          entry.notes,
          '',
          '**Overrides:**',
          '```json',
          JSON.stringify(entry.overrides ?? {}, null, 2),
          '```',
        ].join('\n');
    }
  }

  private async scanDir(dir: string, scope: 'project' | 'global'): Promise<DocSummary[]> {
    const entries = await this.scanDirFull(dir);
    return entries.map((e) => this.toSummary(e, scope));
  }
}
