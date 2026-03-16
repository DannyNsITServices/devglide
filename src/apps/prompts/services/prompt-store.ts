import type { Prompt, PromptSummary } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { PROMPTS_DIR } from '../../../packages/paths.js';
import { JsonFileStore } from '../../../packages/json-file-store.js';

/** Regex for {{varName}} placeholders — matches word chars, hyphens, and dots. */
const VAR_PATTERN = /\{\{([\w.-]+)\}\}/g;

/** Extract {{varName}} placeholders from prompt content. */
function detectVariables(content: string): string[] {
  const matches = content.matchAll(VAR_PATTERN);
  const vars = new Set<string>();
  for (const m of matches) vars.add(m[1]);
  return [...vars];
}

export class PromptStore extends JsonFileStore<Prompt> {
  private static instance: PromptStore;
  protected readonly baseDir = PROMPTS_DIR;

  static getInstance(): PromptStore {
    if (!PromptStore.instance) {
      PromptStore.instance = new PromptStore();
    }
    return PromptStore.instance;
  }

  async list(filter?: { category?: string; tags?: string[]; search?: string }): Promise<PromptSummary[]> {
    const seen = new Map<string, PromptSummary>();

    const projectDir = this.getProjectDir();
    if (projectDir) {
      for (const s of await this.scanDir(projectDir, 'project')) {
        seen.set(s.id, s);
      }
      for (const s of await this.scanDir(this.getGlobalDir(), 'global')) {
        if (!seen.has(s.id)) seen.set(s.id, s);
      }
    } else {
      // No active project — show global entries only
      for (const s of await this.scanDir(this.getGlobalDir(), 'global')) {
        seen.set(s.id, s);
      }
    }

    let results = [...seen.values()];

    if (filter?.category) {
      results = results.filter((p) => p.category === filter.category);
    }
    if (filter?.tags?.length) {
      results = results.filter((p) => filter.tags!.every((t) => p.tags.includes(t)));
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      results = results.filter((p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return results;
  }

  async save(
    input: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; scope?: 'project' | 'global' },
  ): Promise<Prompt> {
    const lockKey = input.id ?? this.generateId();
    return this.withLock(lockKey, async () => {
      const now = new Date().toISOString();
      const isUpdate = !!input.id;

      let existing: Prompt | null = null;
      if (isUpdate) {
        existing = await this.get(input.id!);
      }

      const prompt: Prompt = {
        id: input.id ?? lockKey,
        title: input.title,
        content: input.content,
        description: input.description,
        category: input.category,
        tags: input.tags ?? [],
        variables: detectVariables(input.content),
        model: input.model,
        temperature: input.temperature,
        rating: input.rating,
        notes: input.notes,
        projectId: input.projectId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      let scope = input.scope;
      if (!scope && isUpdate) {
        scope = await this.resolveExistingScope(input.id!);
      }
      scope = scope ?? (getActiveProject() ? 'project' : 'global');

      await this.writeEntity(prompt, scope, getActiveProject()?.id);
      return prompt;
    });
  }

  /**
   * Atomically fetch, merge, and write — eliminates TOCTOU race in callers.
   * undefined = keep existing, null = clear field, value = update.
   */
  async update(
    id: string,
    fields: { [K in keyof Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'variables'>]?: Prompt[K] | null },
  ): Promise<Prompt | null> {
    return this.withLock(id, async () => {
      const existing = await this.get(id);
      if (!existing) return null;

      const merged: Prompt = { ...existing, updatedAt: new Date().toISOString() };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        (merged as unknown as Record<string, unknown>)[key] = value === null ? undefined : value;
      }
      merged.variables = detectVariables(merged.content);

      const scope = await this.resolveExistingScope(id) ?? (getActiveProject() ? 'project' : 'global');
      await this.writeEntity(merged, scope, getActiveProject()?.id);
      return merged;
    });
  }

  /** Return all prompts as compiled markdown for LLM context injection. */
  async getCompiledContext(): Promise<string> {
    const summaries = await this.list();
    if (summaries.length === 0) return '';

    const lines: string[] = [
      '# Available Prompts',
      '',
      '> Reusable prompt templates. Use `prompts_render` with the ID to expand variables.',
      '',
    ];

    const byCategory = new Map<string, PromptSummary[]>();
    for (const s of summaries) {
      const cat = s.category ?? 'General';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(s);
    }

    for (const [category, entries] of byCategory) {
      lines.push(`## ${category}`, '');
      for (const e of entries) {
        const stars = e.rating ? ' ' + '\u2605'.repeat(e.rating) : '';
        const tags = e.tags.length ? ` [${e.tags.join(', ')}]` : '';
        lines.push(`- **${e.title}** (id: \`${e.id}\`)${stars}${tags}`);
        if (e.description) lines.push(`  ${e.description}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async render(id: string, vars: Record<string, string>): Promise<string | null> {
    const prompt = await this.get(id);
    if (!prompt) return null;
    return prompt.content.replace(VAR_PATTERN, (_, name) => vars[name] ?? `{{${name}}}`);
  }

  private toSummary(entry: Prompt, scope: 'project' | 'global'): PromptSummary {
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      tags: entry.tags,
      rating: entry.rating,
      scope,
      updatedAt: entry.updatedAt,
    };
  }

  private async scanDir(dir: string, scope: 'project' | 'global'): Promise<PromptSummary[]> {
    const entries = await this.scanDirFull(dir);
    return entries.map((e) => this.toSummary(e, scope));
  }

}
