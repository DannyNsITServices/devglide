/**
 * KB v2 Wiki Builder — dry-run pipeline.
 *
 * Orchestrates the non-destructive half of the wiki compile pipeline:
 *
 *   1. scan         — pure code: list eligible raw sources + stale/fresh wikis
 *   2. cluster      — LLM: group raw sources by topic
 *   3. planActions  — pure code: decide create vs merge vs skip per cluster
 *   4. synthesize   — LLM: draft each wiki page with inline citations
 *   [5. review]     — Phase 3 (not implemented here)
 *   [6. commit]     — Phase 3 (not implemented here)
 *
 * Phase 2 deliverable: `buildDryRun()` runs stages 1-4 and writes an immutable
 * build-run record to `build-runs/<runId>.json`. No writes to `notes/`, no
 * mutation to `consumedBy[]`, no activity log entries. Only the audit file.
 *
 * Architectural invariants enforced by code structure:
 *   - Pure-code stages in this file import ZERO LLM SDKs
 *   - LLM stages only go through the injected `LlmClient` interface
 *   - Every stage output is JSON-serializable and lands in the BuildRun record
 *   - Validation errors isolate individual proposals; they never fail the whole run
 */

import fs from 'fs/promises';
import path from 'path';
import { createId } from '@paralleldrive/cuid2';
import type { KbNote, KbNoteSummary } from '../types.js';
import {
  KnowledgeBaseStore,
  KbError,
  defaultKindForSlug,
  isWikiStale,
} from './knowledge-base-store.js';
import { KbBuildRunStore, generateBuildRunId, KB_BUILD_RUNS_DIR } from './kb-build-run-store.js';
import type {
  ActionPlan,
  BuildDryRunOptions,
  BuildRun,
  ClusterPlan,
  CommitResult,
  LlmClient,
  LlmClusterInput,
  LlmSynthesizeInput,
  LlmTokenUsage,
  PreviousWikiSnapshot,
  ProposedPage,
  ReviewDecision,
  ScanOptions,
  ScanResult,
  SourceMoveRecord,
} from './kb-builder-types.js';
import { BUILDER_PROMPT_VERSION } from './kb-builder-types.js';

/**
 * Top-level builder facade. Constructed with a `KnowledgeBaseStore` and an
 * `LlmClient`. Tests inject a fixture client; production wires a real one
 * (Phase 4+).
 */
export class KbBuilder {
  private readonly store: KnowledgeBaseStore;
  private readonly runStore: KbBuildRunStore;
  private readonly llm: LlmClient;

  constructor(opts: {
    store: KnowledgeBaseStore;
    runStore: KbBuildRunStore;
    llm: LlmClient;
  }) {
    this.store = opts.store;
    this.runStore = opts.runStore;
    this.llm = opts.llm;
  }

  // ── Stage 1 — scan ────────────────────────────────────────────────────────

  /**
   * Pure code. Walks the KB via the store's query helpers and partitions notes
   * into eligible sources / stale wikis / fresh wikis.
   *
   * Eligibility rule for raw sources:
   *   - kind === 'raw'
   *   - and either not yet cited (`consumedBy` empty)
   *     or updated after the most recent wiki that cites it was built
   *
   * Staleness uses `isWikiStale` with an in-memory `getSource` closure so the
   * function is pure and deterministic within a single scan call.
   */
  async scan(opts?: ScanOptions): Promise<ScanResult> {
    const rawSummaries = await this.store.getByKind('raw');
    const wikiSummaries = await this.store.getByKind('wiki');

    // Build a lookup of full notes so the stale check doesn't re-hit disk
    // once per source — one batched walk.
    const sourceMap = new Map<string, KbNote>();
    const eligibleSources: KbNoteSummary[] = [];
    const staleWikis: KbNoteSummary[] = [];
    const freshWikis: KbNoteSummary[] = [];

    // Filter by path prefix up front so we don't read bodies we'll discard.
    const pathPrefix = opts?.path;
    const matchesPath = (note: { path: string }) =>
      !pathPrefix || note.path === pathPrefix || note.path.startsWith(`${pathPrefix}/`);

    for (const summary of rawSummaries) {
      if (!matchesPath(summary)) continue;
      const full = await this.store.get(summary.id);
      if (!full) continue;
      sourceMap.set(full.id, full);
      const neverConsumed = !full.consumedBy || full.consumedBy.length === 0;
      const updatedRecently =
        opts?.sinceISO !== undefined && full.updatedAt >= opts.sinceISO;
      if (neverConsumed || updatedRecently) {
        eligibleSources.push(summary);
      }
    }

    for (const summary of wikiSummaries) {
      if (!matchesPath(summary)) continue;
      const wiki = await this.store.get(summary.id);
      if (!wiki) continue;
      // Ensure the stale-check can find the sources by pre-loading any that
      // aren't already in the map (e.g. a wiki references a source outside
      // the path filter).
      for (const srcId of wiki.sourceRefs ?? []) {
        if (!sourceMap.has(srcId)) {
          const src = await this.store.get(srcId);
          if (src) sourceMap.set(srcId, src);
        }
      }
      const stale = isWikiStale(wiki, (id) => sourceMap.get(id) ?? null);
      if (stale) {
        staleWikis.push(summary);
      } else {
        freshWikis.push(summary);
      }
    }

    return { eligibleSources, staleWikis, freshWikis };
  }

  // ── Stage 2 — cluster ─────────────────────────────────────────────────────

  /**
   * LLM stage. Sends minimal per-source context (id + title + first paragraph
   * + tags + source) to the `LlmClient.cluster` method and validates the
   * returned `ClusterPlan[]`:
   *
   *   - every returned id must be in the input set (no hallucinations)
   *   - every input id must appear in exactly one cluster (no drops, no dupes)
   *
   * On validation failure we drop invalid ids (never throw the whole stage)
   * and push any orphaned input ids into a synthetic `needs-review` cluster
   * so the pipeline keeps going.
   */
  async cluster(
    sources: KbNoteSummary[],
  ): Promise<{ clusters: ClusterPlan[]; tokens: LlmTokenUsage }> {
    if (sources.length === 0) {
      return { clusters: [], tokens: { model: 'none', inputTokens: 0, outputTokens: 0, durationMs: 0 } };
    }
    // Build LLM input with bounded token budget per source (first paragraph only).
    const input: LlmClusterInput = {
      promptVersion: BUILDER_PROMPT_VERSION,
      sources: await Promise.all(
        sources.map(async (s) => {
          const full = await this.store.get(s.id);
          const body = full?.body ?? '';
          const firstParagraph = body.split(/\n\s*\n/, 1)[0]?.slice(0, 500) ?? '';
          return {
            id: s.id,
            title: s.title,
            firstParagraph,
            tags: s.tags,
            source: s.source,
          };
        }),
      ),
    };

    const inputIds = new Set(sources.map((s) => s.id));
    const { clusters: rawClusters, tokens } = await this.llm.cluster(input);

    // Validate and deduplicate. Track which input ids have been placed.
    const placedIds = new Set<string>();
    const validClusters: ClusterPlan[] = [];
    for (const cluster of rawClusters) {
      const validIds: string[] = [];
      for (const id of cluster.rawIds) {
        if (!inputIds.has(id)) continue; // hallucinated — drop
        if (placedIds.has(id)) continue; // duplicate — drop
        placedIds.add(id);
        validIds.push(id);
      }
      if (validIds.length > 0) {
        validClusters.push({
          clusterName: cluster.clusterName || 'unnamed',
          rawIds: validIds,
          confidence: cluster.confidence ?? 'medium',
        });
      }
    }

    // Any input id the LLM forgot to place goes into a needs-review bucket.
    const orphanIds = sources.map((s) => s.id).filter((id) => !placedIds.has(id));
    if (orphanIds.length > 0) {
      validClusters.push({
        clusterName: 'needs-review',
        rawIds: orphanIds,
        confidence: 'low',
      });
    }

    return { clusters: validClusters, tokens };
  }

  // ── Stage 3 — planActions (match-or-create) ──────────────────────────────

  /**
   * Pure code. For each cluster, decide whether to create a new wiki page or
   * merge into an existing one. Match heuristic (highest confidence wins):
   *
   *   - `sourceRefs` overlap ≥ 50% with cluster's raw ids → merge
   *   - title Jaccard similarity ≥ 0.6 → merge
   *   - tag overlap ≥ 2 shared tags → merge
   *   - otherwise → create
   *
   * Clusters named `needs-review` are always skipped so their contents are
   * surfaced in the review panel (Phase 4) for human disambiguation.
   *
   * `opts.targetRoom`: when set, forces every `create` action's `targetPath`
   * to be that room (slug is still derived from the cluster name). This lets
   * the `build_plan` / `build_dry_run` callers override the default
   * `deriveCreateTarget` heuristic when they already know the target scope.
   */
  async planActions(
    clusters: ClusterPlan[],
    opts?: { targetRoom?: string },
  ): Promise<ActionPlan[]> {
    const existingWikis = await this.store.getByKind('wiki');
    const wikiFullCache = new Map<string, KbNote>();
    for (const summary of existingWikis) {
      const w = await this.store.get(summary.id);
      if (w) wikiFullCache.set(w.id, w);
    }

    const plans: ActionPlan[] = [];
    for (const cluster of clusters) {
      if (cluster.clusterName === 'needs-review') {
        plans.push({
          type: 'skip',
          cluster,
          reason: 'cluster tagged needs-review by the cluster stage; requires human disambiguation',
        });
        continue;
      }

      const match = findBestMatch(cluster, existingWikis, wikiFullCache);
      if (match) {
        const full = wikiFullCache.get(match.id);
        if (full) {
          plans.push({
            type: 'merge',
            cluster,
            existingWikiId: full.id,
            existingWikiPath: full.path,
            existingWikiSlug: full.slug,
          });
          continue;
        }
      }

      // No match — create a new wiki. Apply targetRoom override if present,
      // otherwise use `deriveCreateTarget` to derive a path from the cluster name.
      let targetPath: string;
      let targetSlug: string;
      if (opts?.targetRoom) {
        targetPath = opts.targetRoom;
        const derived = deriveCreateTarget(cluster);
        targetSlug = derived.targetSlug;
      } else {
        const derived = deriveCreateTarget(cluster);
        targetPath = derived.targetPath;
        targetSlug = derived.targetSlug;
      }
      plans.push({
        type: 'create',
        cluster,
        targetPath,
        targetSlug,
      });
    }
    return plans;
  }

  // ── Shared stage-1 → stage-2 source selection bridge ─────────────────────

  /**
   * Combine `scan.eligibleSources` with the raw sources cited by every
   * `scan.staleWikis` entry, so both the `build_plan` MCP/REST tool and the
   * `buildDryRun` orchestrator cluster the SAME set of sources for the same
   * KB state.
   *
   * Without this, `build_plan` would only see never-built raw sources while
   * `build_dry_run` would additionally consider sources that need a rebuild
   * because their wiki is stale — the two surfaces would disagree on the
   * same input.
   */
  async collectSourcesForBuild(scan: ScanResult): Promise<KbNoteSummary[]> {
    const staleSourceIds = new Set<string>();
    for (const w of scan.staleWikis) {
      const wiki = await this.store.get(w.id);
      for (const srcId of wiki?.sourceRefs ?? []) staleSourceIds.add(srcId);
    }
    const extras: KbNoteSummary[] = [];
    for (const id of staleSourceIds) {
      if (scan.eligibleSources.some((s) => s.id === id)) continue;
      const src = await this.store.get(id);
      if (src) {
        extras.push({
          id: src.id,
          title: src.title,
          slug: src.slug,
          path: src.path,
          tags: src.tags,
          source: src.source,
          updatedAt: src.updatedAt,
          kind: src.kind ?? defaultKindForSlug(src.slug),
        });
      }
    }
    return [...scan.eligibleSources, ...extras];
  }

  // ── Stage 4 — synthesize ──────────────────────────────────────────────────

  /**
   * LLM stage. Runs one LLM call per non-skip action plan to produce a
   * `ProposedPage`. Skip plans are flattened into `ProposedPage` records with
   * `needsReview: true` so reviewers see them in the panel.
   *
   * Validation (post-LLM):
   *   - `title` is non-empty
   *   - `sourceRefs` is a subset of the plan's input source ids
   *   - every `[^kb_id]` in `body` resolves to a `sourceRefs` id
   *
   * Any proposal that fails validation is retained with `needsReview: true`
   * and a human-readable `needsReviewReason`, so one bad LLM output never
   * fails the whole run.
   */
  async synthesize(
    plans: ActionPlan[],
  ): Promise<{
    proposals: ProposedPage[];
    llmUsage: Array<{ stage: 'synthesize'; tokens: LlmTokenUsage; promptHash: string }>;
  }> {
    const proposals: ProposedPage[] = [];
    const llmUsage: Array<{
      stage: 'synthesize';
      tokens: LlmTokenUsage;
      promptHash: string;
    }> = [];

    for (const plan of plans) {
      if (plan.type === 'skip') {
        proposals.push({
          proposalId: `prop_${createId().slice(0, 10)}`,
          actionPlan: plan,
          title: `[skipped] ${plan.cluster.clusterName}`,
          body: `This cluster was skipped: ${plan.reason}\n\nSources:\n${plan.cluster.rawIds.map((id) => `- ${id}`).join('\n')}`,
          tags: [],
          sourceRefs: plan.cluster.rawIds,
          targetPath: 'notes/needs-review',
          targetSlug: `needs-review-${createId().slice(0, 6)}`,
          kind: 'wiki',
          needsReview: true,
          needsReviewReason: plan.reason,
        });
        continue;
      }

      // Build the LLM input by loading full source bodies for every raw id
      // in the cluster.
      const sourceNotes: Array<{ id: string; title: string; body: string; tags: string[] }> = [];
      for (const id of plan.cluster.rawIds) {
        const src = await this.store.get(id);
        if (src) {
          sourceNotes.push({ id: src.id, title: src.title, body: src.body, tags: src.tags });
        }
      }
      const inputIdSet = new Set(sourceNotes.map((s) => s.id));
      if (inputIdSet.size === 0) {
        proposals.push(mkNeedsReviewProposal(plan, 'all sources disappeared before synthesize (deleted mid-run)'));
        continue;
      }

      let existingWikiBody: string | undefined;
      let manualEditsDetected = false;
      if (plan.type === 'merge') {
        const existing = await this.store.get(plan.existingWikiId);
        existingWikiBody = existing?.body;
        // 3-way merge detection: if the user hand-edited the wiki after the
        // last build committed, we must not silently overwrite those edits.
        // Flag the proposal for human review routing in Phase 4.
        if (existing?.manualEditsAfter && existing.compiledAt && existing.manualEditsAfter > existing.compiledAt) {
          manualEditsDetected = true;
        }
      }

      const llmInput: LlmSynthesizeInput = {
        promptVersion: BUILDER_PROMPT_VERSION,
        plan,
        sources: sourceNotes,
        existingWikiBody,
      };

      let result;
      try {
        result = await this.llm.synthesize(llmInput);
      } catch (err) {
        proposals.push(
          mkNeedsReviewProposal(
            plan,
            `synthesize LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        continue;
      }

      llmUsage.push({
        stage: 'synthesize',
        tokens: result.tokens,
        promptHash: hashPromptInput(llmInput),
      });

      const output = result.output;

      // Schema + citation validation. Isolated failures per proposal.
      const validationError = validateSynthesizeOutput(output, inputIdSet);

      const targetPath = plan.type === 'create' ? plan.targetPath : plan.existingWikiPath;
      const targetSlug = plan.type === 'create' ? plan.targetSlug : plan.existingWikiSlug;

      const proposal: ProposedPage = {
        proposalId: `prop_${createId().slice(0, 10)}`,
        actionPlan: plan,
        title: (output.title || '').trim().slice(0, 200),
        body: output.body ?? '',
        tags: Array.isArray(output.tags) ? output.tags : [],
        sourceRefs: Array.isArray(output.sourceRefs)
          ? output.sourceRefs.filter((id) => inputIdSet.has(id))
          : [],
        targetPath,
        targetSlug,
        kind: 'wiki',
      };

      if (plan.type === 'merge' && existingWikiBody !== undefined) {
        proposal.diff = computeDiff(existingWikiBody, proposal.body);
      }

      if (validationError) {
        proposal.needsReview = true;
        proposal.needsReviewReason = validationError;
      } else if (manualEditsDetected) {
        // 3-way merge: flag but keep the proposal valid so the reviewer can
        // see the builder's proposal vs the user's manual edits side-by-side
        // in Phase 4. Commit is blocked until a human resolves.
        proposal.needsReview = true;
        proposal.needsReviewReason =
          'wiki has manual edits after the last build (manualEditsAfter > compiledAt); 3-way merge required';
      }

      proposals.push(proposal);
    }

    return { proposals, llmUsage };
  }

  // ── Orchestrator — buildDryRun ────────────────────────────────────────────

  /**
   * Run the full dry-run pipeline end-to-end: scan → cluster → planActions →
   * synthesize. Persist the complete BuildRun record to the build-run store.
   * Does NOT write to `notes/`, does NOT update `consumedBy[]`, does NOT
   * append to activity.jsonl. The only disk side effect is the build-run
   * audit JSON file under `~/.devglide/knowledge-base/build-runs/`.
   *
   * Returns the full BuildRun so callers can render proposals for review.
   */
  async buildDryRun(opts: BuildDryRunOptions = {}): Promise<BuildRun> {
    const runId = generateBuildRunId();
    const startedAt = new Date().toISOString();

    const run: BuildRun = {
      runId,
      startedAt,
      completedAt: null,
      trigger: opts.trigger ?? 'manual',
      promptVersion: BUILDER_PROMPT_VERSION,
      scope: {
        path: opts.scope?.path,
        targetRoom: opts.targetRoom,
      },
      scan: { eligibleSources: [], staleWikis: [], freshWikis: [] },
      clusters: [],
      actions: [],
      proposals: [],
      decisions: [],
      committed: null,
      reverted: false,
      llmCalls: [],
    };

    // Write the shell record before starting so a mid-run crash leaves a
    // discoverable marker in the history.
    await this.runStore.write(run);

    // Stage 1 — scan
    run.scan = await this.scan(opts.scope);

    // Stage 2 — cluster. Use the shared `collectSourcesForBuild` bridge so
    // this surface reflects exactly the same source set as `build_plan`.
    const allSources = await this.collectSourcesForBuild(run.scan);
    if (allSources.length > 0) {
      const { clusters, tokens } = await this.cluster(allSources);
      run.clusters = clusters;
      run.llmCalls.push({
        stage: 'cluster',
        promptHash: hashPromptInput({ sources: allSources.map((s) => s.id) }),
        ...tokens,
      });
    }

    // Stage 3 — planActions (honors `targetRoom` override)
    run.actions = await this.planActions(run.clusters, { targetRoom: opts.targetRoom });

    // Stage 4 — synthesize
    const { proposals, llmUsage } = await this.synthesize(run.actions);
    run.proposals = proposals;
    for (const u of llmUsage) {
      run.llmCalls.push({
        stage: u.stage,
        promptHash: u.promptHash,
        ...u.tokens,
      });
    }

    run.completedAt = new Date().toISOString();
    await this.runStore.write(run);
    return run;
  }

  // ── Phase 3 — Orchestrator: buildRun (review-gated dry-run) ─────────────

  /**
   * Run the full pipeline and write a BuildRun with proposals in "awaiting
   * review" state. No proposals are committed until `approve()` is called.
   *
   * Functionally identical to `buildDryRun()` today (Phase 2) — this method
   * exists so the MCP/REST surface can distinguish "run the pipeline and
   * queue for human review" from "run the pipeline as a pure preview".
   * Phase 4 UI will surface a different code path for each.
   */
  async buildRun(opts: BuildDryRunOptions = {}): Promise<BuildRun> {
    return this.buildDryRun(opts);
  }

  // ── Phase 3 — approve ────────────────────────────────────────────────────

  /**
   * Commit a set of approved proposals from a prior build run.
   *
   * Contract:
   *   - `runId` must refer to an existing run with `completedAt != null`
   *   - `proposalIds` must all belong to that run
   *   - proposals flagged `needsReview: true` are REJECTED (commit must be
   *     preceded by an explicit edit + re-approval that resolves the issue —
   *     Phase 4 UI will expose this)
   *   - `edits` can override per-proposal fields (title, body, tags,
   *     targetPath, targetSlug) so reviewers can fix mistakes without
   *     re-running the pipeline
   *
   * Commit strategy:
   *   - Stage every approved proposal into `build-runs/<runId>/staging/`
   *   - For merges, snapshot the previous wiki into `CommitResult.previousBodies`
   *   - Atomically move each staged file to its final `notes/` path
   *   - Update each cited source's `consumedBy[]` reverse index
   *   - Append activity.jsonl entries with op `build_commit`
   *   - Record `CommitResult` + `ReviewDecision[]` on the BuildRun
   *
   * On mid-commit crash, the staging directory contains the most recent
   * attempt and can be cleaned up manually; the store itself is left in
   * whatever partial state the crash interrupted (per-file atomic writes
   * mean every wiki is either pre-commit or post-commit, never corrupted).
   */
  async approve(
    runId: string,
    proposalIds: string[],
    edits: Record<string, Partial<ProposedPage>> = {},
  ): Promise<CommitResult> {
    const run = await this.runStore.get(runId);
    if (!run) {
      throw new KbError(`Build run not found: ${runId}`, 'not_found');
    }
    if (run.committed) {
      throw new KbError(`Build run ${runId} has already been committed`);
    }
    if (run.completedAt === null) {
      throw new KbError(`Build run ${runId} has not finished its pipeline stages yet`);
    }

    // Validate that every requested proposalId actually exists in this run.
    // Silently ignoring unknown ids let empty runs get marked committed and
    // blocked later valid approvals — the "committed: []" ghost commit bug.
    const runProposalById = new Map(run.proposals.map((p) => [p.proposalId, p]));
    const unknown = proposalIds.filter((id) => !runProposalById.has(id));
    if (unknown.length > 0) {
      throw new KbError(
        `Unknown proposal ids for run ${runId}: ${unknown.join(', ')}`,
      );
    }
    // Also validate every id in `edits` belongs to the run — a typo in
    // edits shouldn't silently ignore the override.
    const editIds = Object.keys(edits);
    const unknownEdits = editIds.filter((id) => !runProposalById.has(id));
    if (unknownEdits.length > 0) {
      throw new KbError(
        `Unknown proposal ids in edits for run ${runId}: ${unknownEdits.join(', ')}`,
      );
    }

    const approvedSet = new Set(proposalIds);
    const proposalsToCommit: ProposedPage[] = [];
    for (const proposal of run.proposals) {
      if (!approvedSet.has(proposal.proposalId)) continue;
      if (proposal.needsReview) {
        throw new KbError(
          `Proposal ${proposal.proposalId} is flagged needsReview: ${proposal.needsReviewReason}. ` +
            'Resolve the issue (edit the proposal or reject it) before approving.',
        );
      }

      // Block path/slug edits on merge proposals. The commit path does not
      // support move semantics (it would leave the old file behind), and
      // the revert path's `previousBodies` snapshot would be incomplete
      // against a new location. Reviewers who want to relocate a wiki
      // should commit the merge as-is and then use `knowledge_base_update`
      // to move the file afterwards — that path handles renames correctly.
      const edit = edits[proposal.proposalId];
      if (edit && proposal.actionPlan.type === 'merge') {
        if (edit.targetPath !== undefined && edit.targetPath !== proposal.actionPlan.existingWikiPath) {
          throw new KbError(
            `Proposal ${proposal.proposalId}: cannot change targetPath on a merge ` +
              `(existing wiki lives at ${proposal.actionPlan.existingWikiPath}). ` +
              `Commit the merge first, then use knowledge_base_update to move the wiki.`,
          );
        }
        if (edit.targetSlug !== undefined && edit.targetSlug !== proposal.actionPlan.existingWikiSlug) {
          throw new KbError(
            `Proposal ${proposal.proposalId}: cannot change targetSlug on a merge ` +
              `(existing wiki slug is ${proposal.actionPlan.existingWikiSlug}). ` +
              `Commit the merge first, then use knowledge_base_update to rename the wiki.`,
          );
        }
      }

      // Apply reviewer edits if present
      const merged: ProposedPage = edit ? { ...proposal, ...edit, kind: 'wiki' } : proposal;
      proposalsToCommit.push(merged);
    }

    // Record the decisions on the BuildRun regardless of whether they
    // committed successfully, so the audit trail shows the reviewer's intent.
    const decisions: ReviewDecision[] = [];
    for (const id of proposalIds) {
      const edit = edits[id];
      decisions.push({
        proposalId: id,
        action: edit ? 'approveWithEdit' : 'approve',
        editedBody: edit?.body,
        editedTitle: edit?.title,
        editedTags: edit?.tags,
        editedTargetPath: edit?.targetPath,
        editedTargetSlug: edit?.targetSlug,
      });
    }
    run.decisions = [...run.decisions, ...decisions];

    // Commit: stage → atomic move → consumedBy update → activity log
    const commitResult = await this.commitProposals(runId, proposalsToCommit);
    run.committed = commitResult;
    await this.runStore.write(run);
    return commitResult;
  }

  // ── Phase 3 — reject ─────────────────────────────────────────────────────

  /**
   * Record reject decisions on a build run without committing anything.
   * Proposals stay in `run.proposals` (the audit trail is preserved) but
   * no wiki pages are written. Multiple calls can add more rejections to
   * the same run.
   */
  async reject(
    runId: string,
    proposalIds: string[],
    reason?: string,
  ): Promise<{ rejected: number }> {
    const run = await this.runStore.get(runId);
    if (!run) {
      throw new KbError(`Build run not found: ${runId}`, 'not_found');
    }
    // Validate that every requested proposalId actually exists in this run.
    // Same class of bug as `approve` — orphan ids would just be recorded
    // as decisions without catching typos.
    const runProposalIds = new Set(run.proposals.map((p) => p.proposalId));
    const unknown = proposalIds.filter((id) => !runProposalIds.has(id));
    if (unknown.length > 0) {
      throw new KbError(
        `Unknown proposal ids for run ${runId}: ${unknown.join(', ')}`,
      );
    }
    const decisions: ReviewDecision[] = proposalIds.map((id) => ({
      proposalId: id,
      action: 'reject',
      reason,
    }));
    run.decisions = [...run.decisions, ...decisions];
    await this.runStore.write(run);
    return { rejected: proposalIds.length };
  }

  // ── Phase 3 — revert ─────────────────────────────────────────────────────

  /**
   * Reverse a previously committed build run.
   *
   * Steps:
   *   - For each wiki in `committed.created`: delete the file from disk
   *   - For each wiki in `committed.previousBodies`: restore the pre-commit
   *     snapshot verbatim (the entire frontmatter + body)
   *   - For each raw source in `committed.updatedConsumedBy`: remove the
   *     reverted wiki ids from the `consumedBy[]` reverse index
   *   - Append activity.jsonl entries with op `build_revert`
   *   - Mark `run.reverted = true` and persist
   *
   * Revert is idempotent-safe: calling it on an already-reverted run throws.
   * Revert refuses if any source has since been deleted (would leave the
   * reverted wiki with dangling sourceRefs).
   */
  async revert(runId: string): Promise<{ reverted: string[] }> {
    const run = await this.runStore.get(runId);
    if (!run) {
      throw new KbError(`Build run not found: ${runId}`, 'not_found');
    }
    if (!run.committed) {
      throw new KbError(`Build run ${runId} has not been committed yet`);
    }
    if (run.reverted) {
      throw new KbError(`Build run ${runId} has already been reverted`);
    }

    // Verify every source referenced in previousBodies still exists. If a
    // source was deleted after commit, we can't safely restore the wiki
    // because its sourceRefs would dangle.
    const missingSources: string[] = [];
    for (const snap of Object.values(run.committed.previousBodies)) {
      for (const srcId of snap.frontmatter.sourceRefs ?? []) {
        const src = await this.store.get(srcId);
        if (!src) missingSources.push(srcId);
      }
    }
    if (missingSources.length > 0) {
      throw new KbError(
        `Cannot revert: sources referenced by merge snapshots have been deleted: ${missingSources.join(', ')}`,
      );
    }

    const reverted: string[] = [];

    // Step 1: delete created wikis
    for (const wikiId of run.committed.created) {
      const wiki = await this.store.get(wikiId);
      if (wiki) {
        await this.store.removeRaw(wikiId);
        reverted.push(wikiId);
      }
    }

    // Step 2: restore previous bodies for merges
    for (const snap of Object.values(run.committed.previousBodies)) {
      await this.restoreWikiSnapshot(snap);
      reverted.push(snap.wikiId);
    }

    // Step 3: remove this run's wiki ids from each cited source's consumedBy
    for (const srcId of run.committed.updatedConsumedBy) {
      const src = await this.store.get(srcId);
      if (!src || !src.consumedBy) continue;
      const filtered = src.consumedBy.filter((id) => !run.committed!.written.includes(id));
      if (filtered.length !== src.consumedBy.length) {
        await this.store.updateConsumedBy(srcId, filtered);
      }
    }

    // Step 3.5: restore any sources this run moved into wiki `_sources/`
    // folders back to their original inbox paths and clear `hidden: true`.
    // Backwards-compatible: pre-source-move committed runs lack this field.
    if (run.committed.sourceMoves) {
      for (const move of run.committed.sourceMoves) {
        await this.store.restoreSourceFromWikiFolder(move.sourceId, move.fromPath, move.fromSlug);
      }
    }

    // Step 4: activity log + run state
    await this.store.appendBuilderActivity({
      ts: new Date().toISOString(),
      op: 'build_revert',
      runId,
      reverted,
    });
    run.reverted = true;
    await this.runStore.write(run);

    return { reverted };
  }

  // ── Phase 3 — rebuild ────────────────────────────────────────────────────

  /**
   * Re-run the pipeline for a single wiki page. Useful when the wiki is
   * flagged stale (sources changed) or the reviewer wants to regenerate
   * a specific page without re-running the entire build.
   *
   * Behavior:
   *   - Loads the wiki and verifies it's `kind: 'wiki'` with non-empty `sourceRefs`
   *   - Resolves the raw sources via the wiki's `sourceRefs[]`
   *   - Builds a single pre-formed `ActionPlan` of type `merge` targeting the
   *     existing wiki
   *   - Runs the synthesize stage for that single plan
   *   - Writes a BuildRun record with `trigger: 'rebuild'` and the single
   *     proposal awaiting review
   *
   * The returned run behaves identically to `buildRun()` — the reviewer can
   * approve / reject / edit via the normal review gate flow. No commit
   * happens automatically; rebuild is strictly a dry-run-with-review until
   * the reviewer approves.
   */
  async rebuild(wikiId: string): Promise<BuildRun> {
    const wiki = await this.store.get(wikiId);
    if (!wiki) {
      throw new KbError(`Wiki not found: ${wikiId}`, 'not_found');
    }
    const effectiveKind = wiki.kind ?? defaultKindForSlug(wiki.slug);
    if (effectiveKind !== 'wiki') {
      throw new KbError(`Cannot rebuild ${wikiId}: not a wiki page (kind=${effectiveKind})`);
    }
    if (!wiki.sourceRefs || wiki.sourceRefs.length === 0) {
      throw new KbError(`Cannot rebuild ${wikiId}: wiki has no sourceRefs to rebuild from`);
    }

    // Verify every cited source still exists. Stripped references would
    // produce a degraded rebuild; better to fail loudly.
    const missingSources: string[] = [];
    for (const srcId of wiki.sourceRefs) {
      const src = await this.store.get(srcId);
      if (!src) missingSources.push(srcId);
    }
    if (missingSources.length > 0) {
      throw new KbError(
        `Cannot rebuild ${wikiId}: cited sources have been deleted: ${missingSources.join(', ')}. ` +
          'Strip the references first (e.g. via cascade delete) or manually edit sourceRefs.',
      );
    }

    // Build a shell BuildRun to hold the rebuild result.
    const runId = generateBuildRunId();
    const startedAt = new Date().toISOString();
    const run: BuildRun = {
      runId,
      startedAt,
      completedAt: null,
      trigger: 'rebuild',
      promptVersion: BUILDER_PROMPT_VERSION,
      scope: { wikiId },
      scan: { eligibleSources: [], staleWikis: [], freshWikis: [] },
      clusters: [],
      actions: [],
      proposals: [],
      decisions: [],
      committed: null,
      reverted: false,
      llmCalls: [],
    };
    await this.runStore.write(run);

    // Skip stages 1-3 and build a pre-formed action plan directly. The
    // cluster name and confidence are fixed because we already know the
    // scope: this single wiki and its sources.
    const cluster: ClusterPlan = {
      clusterName: wiki.title || wiki.slug,
      rawIds: [...wiki.sourceRefs],
      confidence: 'high',
    };
    run.clusters = [cluster];
    const action: ActionPlan = {
      type: 'merge',
      cluster,
      existingWikiId: wiki.id,
      existingWikiPath: wiki.path,
      existingWikiSlug: wiki.slug,
    };
    run.actions = [action];

    // Stage 4 — synthesize (same path as buildRun)
    const { proposals, llmUsage } = await this.synthesize(run.actions);
    run.proposals = proposals;
    for (const u of llmUsage) {
      run.llmCalls.push({
        stage: u.stage,
        promptHash: u.promptHash,
        ...u.tokens,
      });
    }

    // Audit log: rebuild-specific op for traceability
    await this.store.appendBuilderActivity({
      ts: new Date().toISOString(),
      op: 'rebuild',
      runId,
      wikiId,
      sourceRefs: wiki.sourceRefs,
    });

    run.completedAt = new Date().toISOString();
    await this.runStore.write(run);
    return run;
  }

  // ── Commit helper (internal) ─────────────────────────────────────────────

  /**
   * Internal commit helper. Stages proposals into `build-runs/<runId>/staging/`,
   * captures previous-body snapshots for merges, atomically moves each staged
   * file to its final destination, updates reverse indices, and appends
   * activity entries.
   *
   * The staging directory is rooted per-run so two concurrent commits on
   * different runs never collide. Intra-run, staging files use proposal ids
   * as filenames so each proposal has its own temp file.
   */
  private async commitProposals(
    runId: string,
    proposals: ProposedPage[],
  ): Promise<CommitResult> {
    const stagingDir = path.join(this.runStore.getDir(), runId, 'staging');
    await fs.mkdir(stagingDir, { recursive: true });

    const written: string[] = [];
    const created: string[] = [];
    const previousBodies: Record<string, PreviousWikiSnapshot> = {};
    const updatedConsumedBySet = new Set<string>();
    let activityEntries = 0;

    // Phase A — stage + snapshot. Nothing touches `notes/` yet.
    const staged: Array<{
      proposal: ProposedPage;
      stagedPath: string;
      wikiId: string;
      isCreate: boolean;
    }> = [];

    for (const proposal of proposals) {
      const isCreate = proposal.actionPlan.type === 'create';
      const wikiId = isCreate
        ? `kb_wiki_${createId()}`
        : proposal.actionPlan.type === 'merge'
          ? proposal.actionPlan.existingWikiId
          : `kb_wiki_${createId()}`;

      // Capture previous body for merges so revert can restore it.
      if (!isCreate && proposal.actionPlan.type === 'merge') {
        const existing = await this.store.get(proposal.actionPlan.existingWikiId);
        if (existing) {
          previousBodies[wikiId] = {
            wikiId: existing.id,
            path: existing.path,
            slug: existing.slug,
            frontmatter: {
              title: existing.title,
              tags: existing.tags,
              source: existing.source,
              createdAt: existing.createdAt,
              updatedAt: existing.updatedAt,
              kind: existing.kind,
              sourceRefs: existing.sourceRefs,
              consumedBy: existing.consumedBy,
              compiledAt: existing.compiledAt,
              compiledBy: existing.compiledBy,
              promptVersion: existing.promptVersion,
              buildStatus: existing.buildStatus,
              lastSourceHashes: existing.lastSourceHashes,
              manualEditsAfter: existing.manualEditsAfter,
            },
            body: existing.body,
          };
        }
      }

      // Build the KbNote to write
      const now = new Date().toISOString();
      const sourceHashes: Record<string, string> = {};
      for (const srcId of proposal.sourceRefs) {
        const src = await this.store.get(srcId);
        if (src) sourceHashes[srcId] = KnowledgeBaseStore.hashBody(src.body);
      }
      const noteToWrite: KbNote = {
        id: wikiId,
        title: proposal.title,
        slug: proposal.targetSlug,
        path: proposal.targetPath,
        tags: proposal.tags,
        source: 'import',
        createdAt: isCreate ? now : (previousBodies[wikiId]?.frontmatter.createdAt ?? now),
        updatedAt: now,
        body: proposal.body,
        kind: 'wiki',
        sourceRefs: proposal.sourceRefs,
        compiledAt: now,
        compiledBy: 'kb-builder-v1',
        promptVersion: BUILDER_PROMPT_VERSION,
        buildStatus: 'published',
        lastSourceHashes: sourceHashes,
      };

      // Stage to build-runs/<runId>/staging/<proposalId>.md
      const stagedPath = path.join(stagingDir, `${proposal.proposalId}.md`);
      await this.store.writeStagedNote(stagedPath, noteToWrite);
      staged.push({ proposal, stagedPath, wikiId, isCreate });
    }

    // Phase B — atomic move from staging into notes/. Each move is itself
    // atomic (fs.rename); the overall commit is a loop of individual atomic
    // moves so a mid-loop crash leaves some wikis committed and others in
    // staging. Phase 3's integration test verifies that each wiki is either
    // pre-commit or post-commit, never corrupted.
    for (const item of staged) {
      const existing = await this.store.get(item.wikiId);
      const targetDir = path.join(this.store.getRootDir(), item.proposal.targetPath);
      await fs.mkdir(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, `${item.proposal.targetSlug}.md`);
      // If an existing wiki lives at a different path (merge that's being
      // reflled into a new folder), remove the old file after the new one
      // lands. For v1, we assume the targetPath matches the existing path
      // for merges (the planActions stage never rewrites the path today).
      await fs.rename(item.stagedPath, targetFile);
      // Force the store to pick up the written file from disk on the next
      // read. rebuildIndex is overkill for a single note; we just clear the
      // cache and let the next store call reload as needed.
      await this.store.syncNoteFromDisk(item.wikiId, item.proposal.targetPath, item.proposal.targetSlug);

      written.push(item.wikiId);
      if (item.isCreate && !existing) {
        created.push(item.wikiId);
      }
    }

    // Phase C — update reverse index on each cited source. This is a
    // separate pass so the consumedBy updates only happen if every wiki
    // wrote successfully.
    for (const item of staged) {
      for (const srcId of item.proposal.sourceRefs) {
        const src = await this.store.get(srcId);
        if (!src) continue;
        const next = new Set([...(src.consumedBy ?? []), item.wikiId]);
        await this.store.updateConsumedBy(srcId, Array.from(next));
        updatedConsumedBySet.add(srcId);
      }
    }

    // Phase C.5 — relocate single-cited inbox sources to <wikiPath>/_sources/.
    //
    // For each source we just updated: if it's currently sitting in inbox
    // AND is now cited by exactly one wiki AND that wiki belongs to this
    // commit, move the source under that wiki's `_sources/` subfolder and
    // mark `hidden: true`. Multi-cited sources stay in inbox (ambiguous
    // ownership). Sources already in `notes/` stay where they are (manual
    // curation overrides the move). The store helper enforces all three
    // guards and returns null on no-op so we don't need to repeat them here.
    const sourceMoves: SourceMoveRecord[] = [];
    const wikiByCommitItem = new Map<string, { proposal: ProposedPage; wikiId: string }>();
    for (const item of staged) wikiByCommitItem.set(item.wikiId, { proposal: item.proposal, wikiId: item.wikiId });

    for (const item of staged) {
      for (const srcId of item.proposal.sourceRefs) {
        const src = await this.store.get(srcId);
        if (!src) continue;
        // Single-citation guard: only move if THIS wiki is the only
        // consumer. If the source picked up additional consumers in the
        // same run (cited by multiple proposals), it stays in inbox.
        if ((src.consumedBy?.length ?? 0) !== 1) continue;
        if (src.consumedBy?.[0] !== item.wikiId) continue;
        const move = await this.store.moveSourceToWikiFolder(srcId, item.proposal.targetPath);
        if (move) {
          sourceMoves.push({
            sourceId: move.id,
            fromPath: move.fromPath,
            fromSlug: move.fromSlug,
            toPath: move.toPath,
            toSlug: move.toSlug,
            wikiId: item.wikiId,
          });
        }
      }
    }

    // Phase D — activity log
    for (const item of staged) {
      await this.store.appendBuilderActivity({
        ts: new Date().toISOString(),
        op: 'build_commit',
        runId,
        wikiId: item.wikiId,
        sourceRefs: item.proposal.sourceRefs,
        isCreate: item.isCreate,
      });
      activityEntries++;
    }

    // Clean up empty staging dir (best-effort).
    try {
      await fs.rmdir(stagingDir);
      await fs.rmdir(path.dirname(stagingDir));
    } catch { /* non-fatal; next commit will recreate */ }

    return {
      written,
      created,
      previousBodies,
      updatedConsumedBy: Array.from(updatedConsumedBySet),
      sourceMoves,
      activityEntries,
    };
  }

  // ── Revert helper (internal) ─────────────────────────────────────────────

  /** Rewrite a wiki file from a previous-body snapshot, verbatim. */
  private async restoreWikiSnapshot(snap: PreviousWikiSnapshot): Promise<void> {
    const note: KbNote = {
      id: snap.wikiId,
      title: snap.frontmatter.title,
      slug: snap.slug,
      path: snap.path,
      tags: snap.frontmatter.tags,
      source: snap.frontmatter.source,
      createdAt: snap.frontmatter.createdAt,
      updatedAt: snap.frontmatter.updatedAt,
      body: snap.body,
      kind: snap.frontmatter.kind as KbNote['kind'],
      sourceRefs: snap.frontmatter.sourceRefs,
      consumedBy: snap.frontmatter.consumedBy,
      compiledAt: snap.frontmatter.compiledAt,
      compiledBy: snap.frontmatter.compiledBy,
      promptVersion: snap.frontmatter.promptVersion,
      buildStatus: snap.frontmatter.buildStatus as KbNote['buildStatus'],
      lastSourceHashes: snap.frontmatter.lastSourceHashes,
      manualEditsAfter: snap.frontmatter.manualEditsAfter,
    };
    await this.store.writeWikiDirect(note);
  }
}

// ── Pure helpers (exported for unit tests) ────────────────────────────────

/**
 * Find the best-matching existing wiki for a cluster, using the spec's
 * heuristic order: sourceRefs overlap → title Jaccard → tag overlap.
 * Returns the matched wiki summary or null if no match clears the threshold.
 */
export function findBestMatch(
  cluster: ClusterPlan,
  candidates: KbNoteSummary[],
  fullCache: Map<string, KbNote>,
): KbNoteSummary | null {
  let best: { summary: KbNoteSummary; score: number } | null = null;
  for (const candidate of candidates) {
    const full = fullCache.get(candidate.id);
    let score = 0;

    // sourceRefs overlap ≥ 50%
    if (full?.sourceRefs && full.sourceRefs.length > 0) {
      const overlap = full.sourceRefs.filter((id) => cluster.rawIds.includes(id)).length;
      const frac = overlap / Math.max(full.sourceRefs.length, cluster.rawIds.length);
      if (frac >= 0.5) score += 0.6 + frac * 0.3;
    }

    // Title Jaccard similarity ≥ 0.6
    const titleSim = jaccardSimilarity(
      tokenize(candidate.title),
      tokenize(cluster.clusterName),
    );
    if (titleSim >= 0.6) score += 0.3 + titleSim * 0.2;

    // Tag overlap ≥ 2
    const tagOverlap = candidate.tags.filter((t) => cluster.clusterName.includes(t)).length;
    if (tagOverlap >= 2) score += 0.1 + tagOverlap * 0.05;

    if (score >= 0.5 && (!best || score > best.score)) {
      best = { summary: candidate, score };
    }
  }
  return best?.summary ?? null;
}

/**
 * Derive a default `create` target path + slug for a cluster whose topic
 * name is the only input signal.
 *
 * Decision order:
 *   1. Empty cluster name → `notes/drafts/draft`
 *   2. Slash-hinted name (`auth/oauth-flow`) → split into path (`notes/auth`) + slug (`oauth-flow`)
 *   3. Single-word name (`auth`) → own folder under `notes/` with matching slug (`notes/auth/auth`)
 *   4. Multi-word name (`my weird topic`) → fall back to `notes/drafts` with a slugified full name
 *
 * The "multi-word" heuristic uses whitespace in the raw cluster name as the
 * signal, since whitespace indicates the LLM wrote a sentence-like topic name
 * rather than an identifier. The reviewer can re-file from drafts explicitly.
 */
export function deriveCreateTarget(cluster: ClusterPlan): { targetPath: string; targetSlug: string } {
  const rawName = cluster.clusterName.trim();
  if (rawName === '') {
    return { targetPath: 'notes/drafts', targetSlug: 'draft' };
  }

  // Slash-hinted name: split into path + slug on the LAST `/`.
  if (rawName.includes('/')) {
    const parts = rawName.split('/').filter((p) => p.length > 0);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1]!;
      const folderParts = parts.slice(0, -1).map(slugifyClusterName).filter((s) => s.length > 0);
      const folder = folderParts.join('/');
      const slug = slugifyClusterName(last) || 'draft';
      if (folder.length > 0) {
        return { targetPath: `notes/${folder}`, targetSlug: slug };
      }
    }
  }

  // Multi-word name (contains whitespace) → drafts folder, full-name slug.
  if (/\s/.test(rawName)) {
    const slug = slugifyClusterName(rawName) || 'draft';
    return { targetPath: 'notes/drafts', targetSlug: slug };
  }

  // Single-word name → own folder under notes/.
  const slug = slugifyClusterName(rawName);
  if (slug && /^[a-z0-9_-]+$/.test(slug)) {
    return { targetPath: `notes/${slug}`, targetSlug: slug };
  }

  return { targetPath: 'notes/drafts', targetSlug: slug || 'draft' };
}

/** Jaccard similarity between two sets of tokens. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

function slugifyClusterName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Validate a synthesize output against the input id set. Returns a
 * human-readable error string on failure, or null if valid.
 */
export function validateSynthesizeOutput(
  output: { title?: string; body?: string; tags?: string[]; sourceRefs?: string[] },
  inputIds: Set<string>,
): string | null {
  if (typeof output.title !== 'string' || output.title.trim() === '') {
    return 'title is empty or not a string';
  }
  if (typeof output.body !== 'string' || output.body.trim() === '') {
    return 'body is empty or not a string';
  }
  if (!Array.isArray(output.sourceRefs) || output.sourceRefs.length === 0) {
    return 'sourceRefs is empty — every wiki page must cite at least one source';
  }
  for (const id of output.sourceRefs) {
    if (!inputIds.has(id)) {
      return `sourceRefs contains id "${id}" not present in the input plan (possible hallucination)`;
    }
  }
  // Citation extraction: every `[^kb_...]` in the body must resolve to a ref
  const citationRe = /\[\^(kb_[a-z0-9_]+)\]/g;
  const citedIds = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = citationRe.exec(output.body))) {
    if (match[1]) citedIds.add(match[1]);
  }
  const refSet = new Set(output.sourceRefs);
  for (const cited of citedIds) {
    if (!refSet.has(cited)) {
      return `body cites "[^${cited}]" which is not in sourceRefs`;
    }
  }
  return null;
}

/** Compute a minimal unified-diff-style string between two bodies. */
export function computeDiff(before: string, after: string): string {
  if (before === after) return '(no changes)';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) continue;
    if (b !== undefined) lines.push(`- ${b}`);
    if (a !== undefined) lines.push(`+ ${a}`);
  }
  return lines.join('\n');
}

/**
 * Deterministic hash of an LLM prompt input, used for audit trails and
 * determinism regression tests. We don't import node:crypto here so this
 * function stays pure and the builder test suite works without any setup.
 */
export function hashPromptInput(value: unknown): string {
  const json = JSON.stringify(value);
  // Simple FNV-1a hash; good enough as a deterministic fingerprint.
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Build a needs-review proposal for a failed synthesize call. Retained in the
 * proposal list so reviewers can see what went wrong.
 */
function mkNeedsReviewProposal(plan: ActionPlan, reason: string): ProposedPage {
  const targetPath = plan.type === 'create' ? plan.targetPath
    : plan.type === 'merge' ? plan.existingWikiPath
    : 'notes/needs-review';
  const targetSlug = plan.type === 'create' ? plan.targetSlug
    : plan.type === 'merge' ? plan.existingWikiSlug
    : `needs-review-${createId().slice(0, 6)}`;
  return {
    proposalId: `prop_${createId().slice(0, 10)}`,
    actionPlan: plan,
    title: plan.type !== 'skip' ? `[needs review] ${plan.cluster.clusterName}` : `[skipped] ${plan.cluster.clusterName}`,
    body: `_Synthesis failed: ${reason}_\n\nCluster sources:\n${plan.cluster.rawIds.map((id) => `- ${id}`).join('\n')}`,
    tags: [],
    sourceRefs: plan.cluster.rawIds,
    targetPath,
    targetSlug,
    kind: 'wiki',
    needsReview: true,
    needsReviewReason: reason,
  };
}
