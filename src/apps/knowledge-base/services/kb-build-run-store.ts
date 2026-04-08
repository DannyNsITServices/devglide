/**
 * KB v2 Wiki Builder — build-run audit log store.
 *
 * Persists one immutable JSON file per build run under
 * `~/.devglide/knowledge-base/build-runs/<runId>.json`. These files are the
 * single source of truth for build history, revert (Phase 3), determinism
 * regression testing, and cost tracking.
 *
 * Design notes:
 *   - One file per run — cheap to list, cheap to replay, easy to diff
 *   - Atomic write (tmp + rename) so partial writes never corrupt history
 *   - Read API exposes both full records (`get`) and summaries (`list`)
 *   - Never mutate an existing run record; updates = rewrite the whole file
 *     with a new file tag so the previous bytes would still be recoverable
 *     from git if ever needed (we don't rely on this today, but the pattern
 *     matches the "disk is canonical" KB v1 invariant)
 */

import fs from 'fs/promises';
import path from 'path';
import { createId } from '@paralleldrive/cuid2';
import { KNOWLEDGE_BASE_DIR } from '../../../packages/paths.js';
import type { BuildRun, BuildRunSummary } from './kb-builder-types.js';

export const KB_BUILD_RUNS_DIR = 'build-runs';

/**
 * Generate a fresh build-run id.
 *
 * Format: `run_<iso-slug>_<cuid8>`. The timestamp slug gives human-readable
 * lexicographic ordering when the directory is listed; the cuid8 suffix
 * guarantees uniqueness when multiple runs start in the same second.
 */
export function generateBuildRunId(nowISO?: string): string {
  const ts = (nowISO ?? new Date().toISOString())
    .replace(/[-:.]/g, '')
    .replace(/T/, '_')
    .slice(0, 15); // YYYYMMDD_HHMMSS
  const suffix = createId().slice(0, 8);
  return `run_${ts}_${suffix}`;
}

export class KbBuildRunStore {
  private readonly rootDir: string;

  constructor(rootDir: string = KNOWLEDGE_BASE_DIR) {
    this.rootDir = rootDir;
  }

  /** Absolute path to the `build-runs/` directory. */
  getDir(): string {
    return path.join(this.rootDir, KB_BUILD_RUNS_DIR);
  }

  /** Ensure `build-runs/` exists. Idempotent. */
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.getDir(), { recursive: true });
  }

  /**
   * Write a build run to disk.
   *
   * Atomic: writes to a temp file in the same directory, then renames.
   * Overwrites any existing file with the same `runId` — safe because
   * `runId` is unique per run and the overwrite only happens when we're
   * updating an in-flight record (stage-by-stage writes during a single run).
   */
  async write(run: BuildRun): Promise<void> {
    await this.ensureDir();
    const target = this.pathFor(run.runId);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${createId().slice(0, 6)}`;
    const content = JSON.stringify(run, null, 2);
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, target);
  }

  /** Read a build run by id. Returns null if the file does not exist or is malformed. */
  async get(runId: string): Promise<BuildRun | null> {
    try {
      const raw = await fs.readFile(this.pathFor(runId), 'utf-8');
      const parsed = JSON.parse(raw) as BuildRun;
      if (!parsed || typeof parsed !== 'object' || parsed.runId !== runId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * List build run summaries, most recent first.
   *
   * `limit` caps the response size (default 50, 0 = no limit). Reads one file
   * per run to build the summary; cheap at solo scale but worth revisiting if
   * a user has > 1000 runs.
   */
  async list(limit = 50): Promise<BuildRunSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.getDir());
    } catch {
      return [];
    }
    // Filename format is `run_<ts>_<suffix>.json`. Sort desc by filename so
    // the most recent runs come first without reading every file just to sort.
    const runFiles = entries
      .filter((e) => e.startsWith('run_') && e.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));

    const summaries: BuildRunSummary[] = [];
    const slice = limit > 0 ? runFiles.slice(0, limit) : runFiles;
    for (const file of slice) {
      try {
        const raw = await fs.readFile(path.join(this.getDir(), file), 'utf-8');
        const run = JSON.parse(raw) as BuildRun;
        summaries.push(toSummary(run));
      } catch {
        // Skip malformed files — never let one bad file hide the rest
        continue;
      }
    }
    return summaries;
  }

  /**
   * Delete a build run file. Used by Phase 3 revert (to clean up reverted runs)
   * and by tests. v2 does not expose this via MCP — it's a store-internal call.
   */
  async remove(runId: string): Promise<boolean> {
    try {
      await fs.unlink(this.pathFor(runId));
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path for a given run id. */
  private pathFor(runId: string): string {
    if (!/^run_[A-Za-z0-9_]+$/.test(runId)) {
      throw new Error(`Invalid build run id: ${runId}`);
    }
    return path.join(this.getDir(), `${runId}.json`);
  }
}

/** Project a BuildRun into its summary projection for history listings. */
function toSummary(run: BuildRun): BuildRunSummary {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    trigger: run.trigger,
    promptVersion: run.promptVersion,
    proposalCount: run.proposals?.length ?? 0,
    committedCount: run.committed?.written?.length ?? 0,
    reverted: run.reverted ?? false,
    // v2 Phase 4: surface the wiki ids written by this run so the dashboard
    // History tab can filter per-wiki without fetching every full BuildRun.
    committedWikis: run.committed?.written ?? [],
  };
}
