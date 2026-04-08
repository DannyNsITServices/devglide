/**
 * Knowledge Base v2 — Wiki Builder types.
 *
 * Shared type surface for the 6-stage build pipeline:
 *   1. scan         — pure code  (builder)
 *   2. cluster      — LLM stage  (builder → LlmClient)
 *   3. match        — pure code  (builder)
 *   4. synthesize   — LLM stage  (builder → LlmClient)
 *   5. review       — human gate (Phase 3)
 *   6. commit       — pure code  (Phase 3)
 *
 * Phase 2 delivers stages 1-4 (dry-run pipeline) plus the build-run audit log
 * and the MCP planning surface. Phase 3 adds 5-6 (review + commit).
 *
 * Design invariants (enforced by code structure, not runtime checks):
 *   - Pure-code stages have NO llm imports and are trivially testable
 *   - LLM stages take an injectable `LlmClient` for testability
 *   - Every stage's input/output is JSON-serializable for build-run auditing
 */

import type { KbNote, KbNoteSummary } from '../types.js';

// ── Scan stage ──────────────────────────────────────────────────────────────

/**
 * Output of Stage 1 (scan). Pure code; no LLM involved.
 *
 * Partitions all notes discovered in scope into three buckets:
 *   - `eligibleSources` — raw notes not yet cited by any wiki (never built)
 *                         or updated since the last wiki that cited them was built
 *   - `staleWikis`      — wiki pages whose `lastSourceHashes` no longer match
 *                         the current body hash of at least one cited source
 *                         (from `isWikiStale()`)
 *   - `freshWikis`      — wiki pages where all cited sources are unchanged
 */
export interface ScanResult {
  eligibleSources: KbNoteSummary[];
  staleWikis: KbNoteSummary[];
  freshWikis: KbNoteSummary[];
}

/** Scope narrowing for the scan stage. All optional. */
export interface ScanOptions {
  /** Limit scan to raw notes under a specific path prefix (e.g. 'inbox'). */
  path?: string;
  /** Include wiki pages whose sources were updated since this ISO timestamp. */
  sinceISO?: string;
}

// ── Cluster stage ───────────────────────────────────────────────────────────

/**
 * Output of Stage 2 (cluster). LLM stage.
 *
 * One `ClusterPlan` per proposed topic group. The constraint
 * `every raw id appears in at most one cluster` is enforced by the builder
 * after the LLM returns. Uncertain items go into a `needs-review` cluster.
 */
export interface ClusterPlan {
  /** Short descriptive name; e.g. 'authentication-flow'. Not a slug. */
  clusterName: string;
  /** Raw note ids in this cluster. Never empty. */
  rawIds: string[];
  /** LLM self-reported confidence. Pure-code match stage uses this as a hint. */
  confidence: 'high' | 'medium' | 'low';
}

// ── Match / Plan stage ──────────────────────────────────────────────────────

/**
 * Output of Stage 3 (match-or-create). Pure code.
 *
 * For each cluster, decide whether to create a new wiki page or merge into
 * an existing one. Ambiguous clusters are skipped with a reason and surfaced
 * in the review panel (Phase 4) as disambiguation questions.
 */
export type ActionPlan =
  | { type: 'create'; cluster: ClusterPlan; targetPath: string; targetSlug: string }
  | { type: 'merge'; cluster: ClusterPlan; existingWikiId: string; existingWikiPath: string; existingWikiSlug: string }
  | { type: 'skip'; cluster: ClusterPlan; reason: string };

// ── Synthesize stage ────────────────────────────────────────────────────────

/**
 * Output of Stage 4 (synthesize). LLM stage.
 *
 * A `ProposedPage` is the builder's draft — NOT committed to disk. Phase 3's
 * review + commit stages turn an approved proposal into a real wiki note.
 *
 * Citation format: markdown footnotes `[^kb_id]` inside the body. The validator
 * enforces that every citation resolves to a `sourceRefs` id and that every
 * `sourceRefs` id was in the synthesize input plan.
 */
export interface ProposedPage {
  /** Unique per-build-run proposal id so reviewer actions can reference it. */
  proposalId: string;
  /** Reference back to the originating action so we know create vs merge. */
  actionPlan: ActionPlan;
  title: string;
  /** Markdown body with inline `[^kb_id]` citations. */
  body: string;
  tags: string[];
  /** Raw note ids cited by this page. Must exactly match the `[^kb_id]` set in body. */
  sourceRefs: string[];
  targetPath: string;
  targetSlug: string;
  /** Always 'wiki' — kept explicit so Phase 3 commit can write the field directly. */
  kind: 'wiki';
  /**
   * Unified diff against the existing wiki body, when the action is `merge`.
   * Undefined for `create`.
   */
  diff?: string;
  /**
   * Set to true by Stage 4 validation when the proposal failed a safety check
   * (e.g. schema validation, citation mismatch, hallucinated id). The proposal
   * is retained so reviewers see it but is NOT auto-committable.
   */
  needsReview?: boolean;
  /** Human-readable reason when `needsReview` is true. */
  needsReviewReason?: string;
}

// ── Review stage (Phase 3) ──────────────────────────────────────────────────

/**
 * Phase 3 review decisions. Declared in Phase 2 so the BuildRun type is
 * forward-compatible without a later schema migration.
 */
export interface ReviewDecision {
  proposalId: string;
  action: 'approve' | 'approveWithEdit' | 'reject';
  editedBody?: string;
  editedTitle?: string;
  editedTags?: string[];
  editedTargetPath?: string;
  editedTargetSlug?: string;
  /** Optional free-text reason, especially for `reject`. */
  reason?: string;
}

// ── Commit stage (Phase 3) ──────────────────────────────────────────────────

/**
 * Phase 3 commit output. A `CommitResult` is recorded on the `BuildRun` so
 * that `revert(runId)` can reproduce the exact state prior to commit:
 *
 *   - `written` — wiki ids written or updated by this run
 *   - `created` — subset of `written` that did not exist before the commit
 *                 (revert deletes these)
 *   - `previousBodies` — for merge commits, the pre-commit full KbNote of
 *                        each affected wiki (revert rewrites the file
 *                        verbatim from this snapshot)
 *   - `updatedConsumedBy` — raw source ids whose `consumedBy[]` was appended
 *                           to (revert removes the wiki id from each)
 *   - `activityEntries` — count of activity.jsonl entries appended
 */
export interface CommitResult {
  written: string[];
  created: string[];
  previousBodies: Record<string, PreviousWikiSnapshot>;
  updatedConsumedBy: string[];
  /**
   * Sources that the commit relocated from `inbox/` to a wiki's
   * `_sources/` subfolder. Optional for back-compat with pre-source-move
   * committed runs (revert tolerates missing entries). Each record carries
   * enough state for `revert` to put the source back exactly where it was.
   */
  sourceMoves?: SourceMoveRecord[];
  activityEntries: number;
}

/**
 * Audit record for a single inbox-source → wiki-folder relocation that
 * happened during a commit. Persisted on the BuildRun so `revert` can put
 * the source back without re-deriving its original inbox path.
 */
export interface SourceMoveRecord {
  sourceId: string;
  fromPath: string;
  fromSlug: string;
  toPath: string;
  toSlug: string;
  /** The wiki that triggered this move (for audit + multi-wiki disambiguation). */
  wikiId: string;
}

/**
 * A pre-commit snapshot of a wiki page, stored on the BuildRun so revert can
 * restore the exact bytes that existed before the merge commit overwrote them.
 * Stores the full set of fields we need to reconstruct the file atomically.
 */
export interface PreviousWikiSnapshot {
  wikiId: string;
  path: string;
  slug: string;
  /** Full frontmatter + body state of the wiki before the commit overwrote it. */
  frontmatter: {
    title: string;
    tags: string[];
    source?: string;
    createdAt: string;
    updatedAt: string;
    kind?: string;
    sourceRefs?: string[];
    consumedBy?: string[];
    compiledAt?: string;
    compiledBy?: string;
    promptVersion?: string;
    buildStatus?: string;
    lastSourceHashes?: Record<string, string>;
    manualEditsAfter?: string;
  };
  body: string;
}

// ── Build run audit log ─────────────────────────────────────────────────────

/**
 * An immutable record of one build run, written to
 * `~/.devglide/knowledge-base/build-runs/<runId>.json`.
 *
 * This is the single source of truth for:
 *   - `knowledge_base_build_history`
 *   - `knowledge_base_build_revert` (Phase 3)
 *   - determinism regression tests (same input + pinned prompt → same output hash)
 *   - cost tracking (sum `llmCalls[].{inputTokens, outputTokens}`)
 *
 * Fields populated incrementally as the pipeline progresses:
 *   Phase 2: runId, startedAt, completedAt, trigger, promptVersion, scope,
 *            scan, clusters, actions, proposals, llmCalls
 *   Phase 3: decisions, committed, reverted
 */
export interface BuildRun {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  trigger: 'manual' | 'scheduled' | 'rebuild' | 'test';
  promptVersion: string;
  scope: {
    path?: string;
    targetRoom?: string;
    wikiId?: string;
  };
  scan: ScanResult;
  clusters: ClusterPlan[];
  actions: ActionPlan[];
  proposals: ProposedPage[];
  /** Phase 3. Empty in Phase 2 dry-run records. */
  decisions: ReviewDecision[];
  /** Phase 3. Null in Phase 2 dry-run records. */
  committed: CommitResult | null;
  /** Phase 3. False in Phase 2 dry-run records. */
  reverted: boolean;
  /** Per-LLM-call audit trail for cost tracking and replay regression testing. */
  llmCalls: Array<{
    stage: 'cluster' | 'synthesize';
    promptHash: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }>;
}

/** Summary projection for `knowledge_base_build_history` listings. */
export interface BuildRunSummary {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  trigger: BuildRun['trigger'];
  promptVersion: string;
  proposalCount: number;
  committedCount: number;
  reverted: boolean;
  /**
   * v2 Phase 4: list of wiki ids written by this run, surfaced on the
   * summary so the dashboard's per-wiki History tab can filter without
   * fetching every full BuildRun. Empty for runs that never committed.
   */
  committedWikis: string[];
}

// ── LlmClient — injectable interface for LLM stages ─────────────────────────

/**
 * Minimal interface for the LLM stages of the builder pipeline.
 *
 * Implementations:
 *   - `FixtureLlmClient` (tests) — returns pre-recorded outputs for pinned inputs
 *   - Production client (later phase) — calls Anthropic / OpenAI with schema-constrained output
 *
 * The builder accepts an `LlmClient` as a constructor dependency so tests can
 * pass a fake without any network / API key / token budget concerns. All Phase 2
 * tests use `FixtureLlmClient` so CI is deterministic.
 */
export interface LlmClient {
  /**
   * Stage 2 — group raw notes by topic.
   *
   * Input: summaries of eligible raw sources (already bounded in size).
   * Output: ClusterPlan[] with the constraint that every id in the input
   *         appears in exactly one cluster (the builder validates this).
   */
  cluster(
    input: LlmClusterInput,
  ): Promise<{ clusters: ClusterPlan[]; tokens: LlmTokenUsage }>;

  /**
   * Stage 4 — synthesize a wiki page from one cluster's raw bodies.
   *
   * Input: the plan + full source bodies + existing wiki body (for merges).
   * Output: a draft markdown body + suggested title/tags + resolved sourceRefs.
   *         The builder validates citations and may flag the proposal
   *         `needsReview` if validation fails.
   */
  synthesize(
    input: LlmSynthesizeInput,
  ): Promise<{ output: LlmSynthesizeOutput; tokens: LlmTokenUsage }>;
}

/** Input to the cluster stage — minimal fields per source to keep tokens bounded. */
export interface LlmClusterInput {
  promptVersion: string;
  sources: Array<{
    id: string;
    title: string;
    firstParagraph: string;
    tags: string[];
    source?: string;
  }>;
}

/** Input to the synthesize stage. Full source bodies are included. */
export interface LlmSynthesizeInput {
  promptVersion: string;
  plan: ActionPlan;
  sources: Array<{
    id: string;
    title: string;
    body: string;
    tags: string[];
  }>;
  /** Present only for `merge` actions — the current wiki body to integrate into. */
  existingWikiBody?: string;
}

/** Output of the synthesize stage. The builder adds `proposalId`, `actionPlan`, `kind: 'wiki'`. */
export interface LlmSynthesizeOutput {
  title: string;
  body: string;
  tags: string[];
  sourceRefs: string[];
}

/** Per-LLM-call usage metadata recorded on the BuildRun. */
export interface LlmTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// ── Builder options ─────────────────────────────────────────────────────────

/** Options passed to `buildDryRun()`. */
export interface BuildDryRunOptions {
  scope?: ScanOptions;
  /** Optional explicit target room for all `create` proposals. Overrides cluster-tag-derived paths. */
  targetRoom?: string;
  /** Trigger type recorded in the BuildRun for audit purposes. */
  trigger?: BuildRun['trigger'];
}

/** The pinned prompt version constant. Bumped when prompts change. */
export const BUILDER_PROMPT_VERSION = 'compile.v1';
