import path from 'path';
import type { VocabularyEntry, VocabularyEntrySummary } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { VOCABULARY_DIR } from '../../../packages/paths.js';
import { JsonFileStore } from '../../../packages/json-file-store.js';

/**
 * Per-project and global vocabulary storage.
 * One JSON file per entry for git-friendly diffs.
 * Storage: ~/.devglide/vocabulary/{projectId}/ and ~/.devglide/vocabulary/
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
      // No active project (e.g. stdio MCP mode) — scan all dirs
      for (const entry of await this.scanAllDirs()) {
        if (!seen.has(entry.id)) {
          seen.set(entry.id, this.toSummary(entry, 'project'));
        }
      }
    }

    let results = [...seen.values()];

    if (filter?.category) {
      results = results.filter((e) => e.category === filter.category);
    }
    if (filter?.tag) {
      results = results.filter((e) => e.tags.includes(filter.tag!));
    }

    return results;
  }

  async lookup(term: string): Promise<VocabularyEntry | null> {
    const all = await this.listFull();
    const normalized = term.toLowerCase();

    for (const entry of all) {
      if (entry.term.toLowerCase() === normalized) return entry;
      if (entry.aliases?.some((a) => a.toLowerCase() === normalized)) return entry;
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
      if (!scope && isUpdate) {
        scope = await this.resolveExistingScope(input.id!);
      }
      scope = scope ?? (getActiveProject() ? 'project' : 'global');

      await this.writeEntity(entry, scope, getActiveProject()?.id);
      return entry;
    });
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
      // No active project (e.g. stdio MCP mode) — scan all dirs
      for (const e of await this.scanAllDirs()) {
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
