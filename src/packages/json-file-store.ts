/**
 * Generic base class for project-scoped + global JSON-per-entity file stores.
 * Extracts the common CRUD, scope resolution, locking, and directory patterns
 * shared by VocabularyStore and WorkflowStore.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getActiveProject } from '../project-context.js';
import { PROJECTS_DIR } from './paths.js';

/** Minimal shape every entity must have. */
export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export abstract class JsonFileStore<T extends BaseEntity> {
  private writeLocks = new Map<string, Promise<void>>();

  /** The root directory for this entity type (e.g. WORKFLOWS_DIR). */
  protected abstract readonly baseDir: string;

  /**
   * Read and parse a single JSON file into an entity.
   * Subclasses can add validation (e.g. Zod) here.
   */
  protected async readEntityFile(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // ── Locking ─────────────────────────────────────────────────────────────

  protected async withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.writeLocks.get(key) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.writeLocks.set(key, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  // ── Directory helpers ──────────────────────────────────────────────────

  /** ~/.devglide/projects/{projectId}/{featureName}/ */
  protected getDirForProject(projectId: string): string {
    return path.join(PROJECTS_DIR, projectId, path.basename(this.baseDir));
  }

  protected getProjectDir(): string | null {
    const ap = getActiveProject();
    if (!ap) return null;
    return this.getDirForProject(ap.id);
  }

  protected getGlobalDir(): string {
    return this.baseDir;
  }

  /** Old path before project-dir reorganization: baseDir/{projectId}/ */
  private getLegacyProjectDir(projectId: string): string {
    return path.join(this.baseDir, projectId);
  }

  /**
   * Move entity files from the legacy baseDir/{projectId}/ layout to
   * ~/.devglide/projects/{projectId}/{feature}/ on first write per project.
   */
  protected async migrateProjectDir(projectId: string): Promise<void> {
    const legacyDir = this.getLegacyProjectDir(projectId);
    const newDir = this.getDirForProject(projectId);
    let entries: string[];
    try {
      entries = await fs.readdir(legacyDir);
    } catch {
      return; // nothing to migrate
    }
    await this.ensureDir(newDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const src = path.join(legacyDir, entry);
      const dest = path.join(newDir, entry);
      try {
        await fs.access(dest);
        // dest already exists — skip
      } catch {
        await fs.rename(src, dest);
      }
    }
    // Remove legacy dir if now empty
    try {
      const remaining = await fs.readdir(legacyDir);
      if (remaining.length === 0) await fs.rmdir(legacyDir);
    } catch { /* ignore */ }
  }

  protected async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────

  async get(id: string): Promise<T | null> {
    const projectDir = this.getProjectDir();
    if (projectDir) {
      const entity = await this.readEntityFile(path.join(projectDir, `${id}.json`));
      if (entity) return entity;
    }
    // Try global dir
    const global = await this.readEntityFile(path.join(this.getGlobalDir(), `${id}.json`));
    if (global) return global;

    // No active project — search all project subdirectories
    if (!projectDir) {
      return this.findInAllDirs(id);
    }
    return null;
  }

  async delete(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      const projectDir = this.getProjectDir();
      if (projectDir) {
        try {
          await fs.unlink(path.join(projectDir, `${id}.json`));
          return true;
        } catch {
          // Not in project dir, try global
        }
      }
      try {
        await fs.unlink(path.join(this.getGlobalDir(), `${id}.json`));
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Search all project subdirectories for an entity by ID. */
  private async findInAllDirs(id: string): Promise<T | null> {
    const featureName = path.basename(this.baseDir);

    // New project dirs: ~/.devglide/projects/{projectId}/{feature}/
    let projectIds: string[];
    try { projectIds = await fs.readdir(PROJECTS_DIR); } catch { projectIds = []; }
    for (const projectId of projectIds) {
      const entity = await this.readEntityFile(path.join(PROJECTS_DIR, projectId, featureName, `${id}.json`));
      if (entity) return entity;
    }

    // Legacy project dirs: baseDir/{projectId}/
    let names: string[];
    try { names = await fs.readdir(this.baseDir); } catch { return null; }
    for (const name of names) {
      if (name.endsWith('.json')) continue;
      const entity = await this.readEntityFile(path.join(this.baseDir, name, `${id}.json`));
      if (entity) return entity;
    }
    return null;
  }

  // ── Scope resolution ──────────────────────────────────────────────────

  protected async resolveExistingScope(id: string): Promise<'project' | 'global' | undefined> {
    const projectDir = this.getProjectDir();
    if (projectDir) {
      try {
        await fs.access(path.join(projectDir, `${id}.json`));
        return 'project';
      } catch { /* not in project dir */ }
    }
    try {
      await fs.access(path.join(this.getGlobalDir(), `${id}.json`));
      return 'global';
    } catch { /* not found */ }
    return undefined;
  }

  /** Determine target dir and write the entity JSON file. */
  protected async writeEntity(entity: T, scope: 'project' | 'global', projectId?: string): Promise<void> {
    if (scope === 'project' && projectId) {
      await this.migrateProjectDir(projectId);
    }
    const targetDir = scope === 'project' && projectId
      ? this.getDirForProject(projectId)
      : this.getGlobalDir();
    await this.ensureDir(targetDir);
    await fs.writeFile(
      path.join(targetDir, `${entity.id}.json`),
      JSON.stringify(entity, null, 2),
    );
  }

  /** Remove entity file from a specific scope (used when scope changes). */
  protected async removeFromScope(id: string, scope: 'project' | 'global', projectId?: string): Promise<void> {
    const dir = scope === 'project' && projectId
      ? this.getDirForProject(projectId)
      : this.getGlobalDir();
    try { await fs.unlink(path.join(dir, `${id}.json`)); } catch { /* not found */ }
  }

  // ── Directory scanning ────────────────────────────────────────────────

  /** Scan a directory and return all valid entities. */
  protected async scanDirFull(dir: string): Promise<T[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }

    const results: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const entity = await this.readEntityFile(path.join(dir, entry));
      if (entity) results.push(entity);
    }
    return results;
  }

  /**
   * Scan the global dir AND all project subdirs under PROJECTS_DIR.
   * Used when no active project is set (e.g. stdio MCP mode) to ensure
   * all entries are discoverable regardless of which project created them.
   */
  protected async scanAllDirs(): Promise<T[]> {
    const results: T[] = [];
    const seen = new Set<string>();
    const featureName = path.basename(this.baseDir);

    const addAll = async (dir: string) => {
      for (const e of await this.scanDirFull(dir)) {
        if (!seen.has(e.id)) { seen.add(e.id); results.push(e); }
      }
    };

    // Global entries (JSON files directly in baseDir)
    await addAll(this.baseDir);

    // New project entries: ~/.devglide/projects/{projectId}/{feature}/
    let projectIds: string[];
    try { projectIds = await fs.readdir(PROJECTS_DIR); } catch { projectIds = []; }
    for (const id of projectIds) {
      await addAll(path.join(PROJECTS_DIR, id, featureName));
    }

    // Legacy project entries: baseDir/{projectId}/ (pre-migration)
    let legacyNames: string[];
    try { legacyNames = await fs.readdir(this.baseDir); } catch { legacyNames = []; }
    for (const name of legacyNames) {
      if (name.endsWith('.json')) continue; // already scanned above
      await addAll(path.join(this.baseDir, name));
    }

    return results;
  }

  // ── ID generation ─────────────────────────────────────────────────────

  protected generateId(): string {
    return randomUUID();
  }
}
