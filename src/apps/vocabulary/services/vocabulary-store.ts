import fs from 'fs/promises';
import path from 'path';
import type { VocabularyEntry, VocabularyEntrySummary } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { PROJECTS_DIR, VOCABULARY_DIR } from '../../../packages/paths.js';
import { JsonFileStore } from '../../../packages/json-file-store.js';

/**
 * Per-project and global vocabulary storage.
 * One JSON file per entry for git-friendly diffs.
 * Global: ~/.devglide/vocabulary/
 * Per-project: ~/.devglide/projects/{projectId}/vocabulary/
 */
export class VocabularyStore extends JsonFileStore<VocabularyEntry> {
  private static instance: VocabularyStore;
  protected readonly baseDir = VOCABULARY_DIR;

  static getInstance(): VocabularyStore {
    if (!VocabularyStore.instance) {
      VocabularyStore.instance = new VocabularyStore();
    }
    return VocabularyStore.instance;
  }

  async list(filter?: { category?: string; tag?: string }): Promise<VocabularyEntrySummary[]> {
    const seen = new Map<string, VocabularyEntrySummary>();

    const projectDir = this.getProjectDir();
    if (projectDir) {
      // Active project set — scan project dir (priority) then global
      for (const s of await this.scanDir(projectDir, 'project')) {
        seen.set(s.id, s);
      }
      for (const s of await this.scanDir(this.getGlobalDir(), 'global')) {
        if (!seen.has(s.id)) seen.set(s.id, s);
      }
    } else {
      // No active project — show global entries only
      for (const s of await this.scanDir(this.getGlobalDir(), 'global')) {
        if (!seen.has(s.id)) seen.set(s.id, s);
      }
    }

    let results = [...seen.values()];

    if (filter?.category) {
      results = results.filter((e) => e.category === filter.category);
    }
    if (filter?.tag) {
      results = results.filter((e) => Array.isArray(e.tags) && e.tags.includes(filter.tag!));
    }

    return results;
  }

  async lookup(term: string): Promise<VocabularyEntry | null> {
    const all = await this.listFull();
    const normalized = term.toLowerCase();

    for (const entry of all) {
      if (entry.term.toLowerCase() === normalized) return entry;
      // Array.isArray guard: a legacy bad entry (e.g. aliases persisted as a
      // string) must not break every lookup.
      if (Array.isArray(entry.aliases) && entry.aliases.some((a) => a.toLowerCase() === normalized)) return entry;
    }

    return null;
  }

  async save(
    input: Omit<VocabularyEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; scope?: 'project' | 'global' },
  ): Promise<VocabularyEntry> {
    const lockKey = input.id ?? this.generateId();
    return this.withLock(lockKey, async () => {
      const now = new Date().toISOString();
      const isUpdate = !!input.id;

      let existing: VocabularyEntry | null = null;
      if (isUpdate) {
        existing = await this.get(input.id!);
      }

      const entry: VocabularyEntry = {
        id: input.id ?? lockKey,
        term: input.term,
        definition: input.definition,
        aliases: input.aliases,
        category: input.category,
        tags: input.tags ?? [],
        projectId: input.projectId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      let scope = input.scope;
      let scopeProjectId = getActiveProject()?.id;
      if (!scope && isUpdate) {
        const located = await this.locateExisting(input.id!);
        if (located) {
          scope = located.scope;
          scopeProjectId = located.projectId ?? scopeProjectId;
        }
      }
      scope = scope ?? (getActiveProject() ? 'project' : 'global');

      await this.writeEntity(entry, scope, scopeProjectId);
      return entry;
    });
  }

  /**
   * Locate the scope (and owning project) an existing entity lives in.
   * Unlike resolveExistingScope, this also searches all project dirs when
   * no active project is set (stdio MCP mode) so updates write in place
   * instead of creating a shadowed global duplicate.
   */
  private async locateExisting(id: string): Promise<{ scope: 'project' | 'global'; projectId?: string } | undefined> {
    const scope = await this.resolveExistingScope(id);
    if (scope) return { scope, projectId: scope === 'project' ? getActiveProject()?.id : undefined };

    const featureName = path.basename(this.baseDir);
    // New project dirs: ~/.devglide/projects/{projectId}/{feature}/
    let projectIds: string[] = [];
    try { projectIds = await fs.readdir(PROJECTS_DIR); } catch { /* none */ }
    for (const projectId of projectIds) {
      try {
        await fs.access(path.join(PROJECTS_DIR, projectId, featureName, `${id}.json`));
        return { scope: 'project', projectId };
      } catch { /* keep looking */ }
    }
    // Legacy project dirs: baseDir/{projectId}/
    let names: string[] = [];
    try { names = await fs.readdir(this.baseDir); } catch { /* none */ }
    for (const name of names) {
      if (name.endsWith('.json')) continue;
      try {
        await fs.access(path.join(this.baseDir, name, `${id}.json`));
        return { scope: 'project', projectId: name };
      } catch { /* keep looking */ }
    }
    return undefined;
  }

  async getCompiledContext(projectId?: string): Promise<string> {
    const all = await this.listFull();

    const filtered = all.filter((e) => {
      if (projectId && e.projectId && e.projectId !== projectId) return false;
      return true;
    });

    if (filtered.length === 0) return '';

    const lines: string[] = [
      '# Domain Vocabulary',
      '',
      '> Use the following domain-specific terms when interpreting user requests.',
      '',
    ];

    const byCategory = new Map<string, VocabularyEntry[]>();
    for (const entry of filtered) {
      const cat = entry.category ?? 'General';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(entry);
    }

    for (const [category, entries] of byCategory) {
      lines.push(`## ${category}`, '');
      for (const entry of entries) {
        const aliases = entry.aliases?.length ? ` (also: ${entry.aliases.join(', ')})` : '';
        lines.push(`- **${entry.term}**${aliases}: ${entry.definition}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private async listFull(): Promise<VocabularyEntry[]> {
    const seen = new Map<string, VocabularyEntry>();

    const projectDir = this.getProjectDir();
    if (projectDir) {
      // Active project set — scan project dir (priority) then global
      for (const e of await this.scanDirFull(projectDir)) {
        seen.set(e.id, e);
      }
      for (const e of await this.scanDirFull(this.getGlobalDir())) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
    } else {
      // No active project — show global entries only
      for (const e of await this.scanDirFull(this.getGlobalDir())) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
    }

    return [...seen.values()];
  }

  private toSummary(entry: VocabularyEntry, scope: 'project' | 'global'): VocabularyEntrySummary {
    return {
      id: entry.id,
      term: entry.term,
      definition: entry.definition,
      aliases: entry.aliases,
      category: entry.category,
      tags: entry.tags,
      scope,
      updatedAt: entry.updatedAt,
    };
  }

  private async scanDir(dir: string, scope: 'project' | 'global'): Promise<VocabularyEntrySummary[]> {
    const entries = await this.scanDirFull(dir);
    return entries.map((e) => this.toSummary(e, scope));
  }
}
