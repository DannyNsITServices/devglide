import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KnowledgeBaseStore, KbError } from '../services/knowledge-base-store.js';
import { KbBuilder } from '../services/kb-builder.js';
import { KbBuildRunStore } from '../services/kb-build-run-store.js';
import { selectLlmClient } from '../services/kb-llm-client.js';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../../packages/mcp-utils/src/index.js';

/**
 * Knowledge Base MCP server.
 *
 * Surface:
 *  - knowledge_base_list / get / add / update / remove / search / walk
 *  - knowledge_base_ingest / import_pipe / promote
 *
 * Storage is global (`~/.devglide/knowledge-base/`), file-first markdown
 * with YAML frontmatter. The folder hierarchy is the memory palace.
 */
export function createKnowledgeBaseMcpServer(): McpServer {
  const server = createDevglideMcpServer(
    'devglide-knowledge-base',
    '0.1.0',
    'Global markdown-first knowledge base with inbox-to-notes workflow',
    {
      instructions: [
        '## Knowledge Base — Usage Conventions',
        '',
        '### Purpose',
        '- A global, file-first knowledge base shared across all projects.',
        '- Stores notes as markdown files with YAML frontmatter on disk.',
        '- The folder hierarchy is the memory palace: rooms → loci.',
        '',
        '### Workflow',
        '- Drop raw material into `inbox/` via `knowledge_base_ingest`.',
        '- Curate it into folders under `notes/` via `knowledge_base_promote`.',
        '- Read with `knowledge_base_walk(path)` (folder traversal) or',
        '  `knowledge_base_search(query)` (scored substring search).',
        '',
        '### Provenance',
        '- The `source` field uses a fixed taxonomy: `pipe:<id>`, `chat:<msgId>`,',
        '  `manual`, `import`. Always supply it on ingest so future tools can trace.',
        '',
        '### Naming',
        '- IDs are immutable (`kb_*`).',
        '- Slugs are mutable filename stems.',
        '- Paths are folders relative to the KB root, e.g. `notes/mempalace/architecture`.',
        '',
        '### Promotion',
        '- Promotion is explicit and manual via `knowledge_base_promote`. Do not',
        '  invent autonomous compilation loops in v1.',
      ],
    },
  );

  const store = KnowledgeBaseStore.getInstance();

  // ── 1. knowledge_base_list ────────────────────────────────────────────────

  server.tool(
    'knowledge_base_list',
    'List notes. Filter by path prefix, tag, free-text title query, or limit. Notes flagged hidden (e.g. wiki source provenance under _sources/) are filtered by default; pass includeHidden: true to surface them.',
    {
      path: z.string().optional().describe('Folder path prefix, e.g. "notes/mempalace"'),
      tag: z.string().optional().describe('Single tag to filter by'),
      q: z.string().optional().describe('Free-text title substring filter (case-insensitive)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default unlimited)'),
      includeHidden: z.boolean().optional().describe('Include notes flagged hidden in results (default: false)'),
    },
    async ({ path, tag, q, limit, includeHidden }) => {
      try {
        const notes = await store.list({ path, tag, q, limit, includeHidden });
        return jsonResult({ notes });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 2. knowledge_base_get ─────────────────────────────────────────────────

  server.tool(
    'knowledge_base_get',
    'Fetch a note by id (kb_*) or by relative path (e.g. "notes/mempalace/architecture/storage-model").',
    {
      idOrPath: z.string().describe('Note id (starts with kb_) or relative path/slug'),
    },
    async ({ idOrPath }) => {
      try {
        const note = await store.get(idOrPath);
        if (!note) return errorResult(`Note "${idOrPath}" not found`);
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 3. knowledge_base_add ─────────────────────────────────────────────────

  server.tool(
    'knowledge_base_add',
    'Create a new note. Defaults to inbox/ if path is omitted.',
    {
      title: z.string().min(1).describe('Note title'),
      content: z.string().describe('Markdown body'),
      path: z.string().optional().describe('Target folder relative to KB root (default: inbox)'),
      tags: z.array(z.string()).optional().describe('Tag list'),
      source: z.string().optional().describe('Provenance: pipe:<id> | chat:<msgId> | manual | import'),
      slug: z.string().optional().describe('Explicit filename stem (auto-derived from title if omitted)'),
    },
    async ({ title, content, path, tags, source, slug }) => {
      try {
        const note = await store.add({ title, content, path, tags, source, slug });
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 4. knowledge_base_update ──────────────────────────────────────────────

  server.tool(
    'knowledge_base_update',
    'Update an existing note in place, optionally renaming the slug or moving to a new folder.',
    {
      idOrPath: z.string().describe('Note id or relative path'),
      title: z.string().optional().describe('New title (must not be empty/whitespace)'),
      content: z.string().optional().describe('New markdown body'),
      tags: z.array(z.string()).optional().describe('Replacement tag list'),
      path: z.string().optional().describe('New folder (triggers a move on disk)'),
      slug: z.string().optional().describe('New slug (triggers a rename on disk)'),
    },
    async ({ idOrPath, title, content, tags, path, slug }) => {
      try {
        const note = await store.update(idOrPath, { title, content, tags, path, slug });
        if (!note) return errorResult(`Note "${idOrPath}" not found`);
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 5. knowledge_base_remove ──────────────────────────────────────────────

  server.tool(
    'knowledge_base_remove',
    'Delete a note by id or path. Permanent — there is no undo in v1. KB v2: raw sources with non-empty consumedBy[] require cascade: true to delete; this strips the citations from dependent wikis and marks them stale.',
    {
      idOrPath: z.string().describe('Note id or relative path'),
      cascade: z.boolean().optional().describe('KB v2: delete a raw source even if wiki pages cite it — citations are stripped and dependent wikis marked stale'),
    },
    async ({ idOrPath, cascade }) => {
      try {
        const ok = await store.remove(idOrPath, { cascade });
        if (!ok) return errorResult(`Note "${idOrPath}" not found`);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 5b. knowledge_base_remove_folder ──────────────────────────────────────

  server.tool(
    'knowledge_base_remove_folder',
    'Delete a folder under the KB root. Default rejects non-empty folders. Pass recursive: true to force-delete a populated folder and all its contents. The recursive path is cascade-aware: if any raw source inside the tree is cited by a wiki page outside the tree, the call rejects with cascade_required (HTTP 409) unless cascade: true is also passed. With cascade: true the dependent external wikis have their sourceRefs stripped and are marked stale, mirroring the single-note remove cascade. External sources cited by wikis being deleted always have their consumedBy[] cleaned up (no flag needed). Protected paths (root, inbox, notes) always reject.',
    {
      path: z.string().min(1).describe('Folder path relative to the KB root, e.g. "notes/devglide-usage-2"'),
      recursive: z.boolean().optional().describe('If true, delete a non-empty folder and all its contents.'),
      cascade: z.boolean().optional().describe('If true, allow recursive removal even when raw sources inside the tree are cited by external wiki pages. Strips the citations and marks the dependent wikis stale (mirrors the single-note remove cascade behavior).'),
    },
    async ({ path: p, recursive, cascade }) => {
      try {
        const ok = await store.removeFolder(p, { recursive, cascade });
        if (!ok) return errorResult(`Folder "${p}" not found`);
        return jsonResult({ ok: true, path: p, recursive: recursive === true, cascade: cascade === true });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 6. knowledge_base_search ──────────────────────────────────────────────

  server.tool(
    'knowledge_base_search',
    'Naive scored substring search over titles, tags, paths, and bodies. Returns ranked hits. Notes flagged hidden are filtered by default; pass includeHidden: true to surface them.',
    {
      query: z.string().min(1).describe('Search query (case-insensitive)'),
      path: z.string().optional().describe('Restrict the search to a folder prefix'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
      includeHidden: z.boolean().optional().describe('Include hidden notes in the result set (default: false)'),
    },
    async ({ query, path, limit, includeHidden }) => {
      try {
        const hits = await store.search(query, { path, limit, includeHidden });
        return jsonResult({ hits });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 7. knowledge_base_walk ────────────────────────────────────────────────

  server.tool(
    'knowledge_base_walk',
    'Memory-palace navigation: list a folder\'s _index.md, direct child notes, and direct subfolders. Notes flagged hidden (e.g. wiki source provenance) and the `_sources/` subfolder are filtered by default; pass includeHidden: true to surface them.',
    {
      path: z.string().describe('Folder path relative to the KB root (use "" for the root)'),
      includeHidden: z.boolean().optional().describe('Include hidden notes and the `_sources/` subfolder in the result (default: false)'),
    },
    async ({ path, includeHidden }) => {
      try {
        const result = await store.walk(path, { includeHidden });
        return jsonResult(result);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 8. knowledge_base_ingest ──────────────────────────────────────────────

  server.tool(
    'knowledge_base_ingest',
    'Drop a blob of text into inbox/ with a date-prefixed, source-tagged filename. The brainstorm-input shortcut.',
    {
      content: z.string().min(1).describe('Markdown body to capture'),
      title: z.string().optional().describe('Optional title (derived from first line if omitted)'),
      source: z.string().optional().describe('Provenance tag (default: manual)'),
    },
    async ({ content, title, source }) => {
      try {
        const note = await store.ingest(content, { title, source });
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 9. knowledge_base_import_pipe ─────────────────────────────────────────

  server.tool(
    'knowledge_base_import_pipe',
    'Import a chat pipe transcript as a markdown digest. Reads ~/.devglide/projects/*/chat/pipes/{id}.jsonl across all projects.',
    {
      pipeId: z.string().min(1).describe('Pipe id; accepts "#pipe-abc", "pipe-abc", or "abc"'),
      title: z.string().optional().describe('Optional title for the digest'),
      path: z.string().optional().describe('Target folder (default: inbox/)'),
    },
    async ({ pipeId, title, path }) => {
      try {
        const note = await store.importPipe(pipeId, { title, path });
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 10. knowledge_base_promote ────────────────────────────────────────────

  server.tool(
    'knowledge_base_promote',
    'Move a note from inbox/ into the curated tree. Preserves the id; optionally renames the slug.',
    {
      idOrPath: z.string().describe('Note id or relative path'),
      targetPath: z.string().min(1).describe('Destination folder, e.g. "notes/curated/topic"'),
      newSlug: z.string().optional().describe('Optional fresh slug'),
    },
    async ({ idOrPath, targetPath, newSlug }) => {
      try {
        const note = await store.promote(idOrPath, targetPath, { newSlug });
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── KB compose lane (zero-key, deterministic) ─────────────────────────────
  //
  // Parallel zero-LLM path beside the v2 build pipeline. The store handles
  // deterministic composition + `lastComposedBodyHash` bookkeeping; this MCP
  // surface just maps tool input to the store call and surfaces errors.

  // ── 10a. knowledge_base_compose ───────────────────────────────────────────
  server.tool(
    'knowledge_base_compose',
    'KB simple lane: deterministically compose a wiki page from selected raw source notes. Zero LLM dependency. The store snapshots `lastComposedBodyHash` so future `knowledge_base_compose_rebuild` calls can detect manual edits.',
    {
      pagePath: z.string().min(1).describe('Full target wiki note path under notes/, e.g. "notes/auth/overview" (no .md). Must live under notes/.'),
      sourceIds: z.array(z.string().min(1)).min(1).describe('Ordered list of raw source note ids to compose from. Order is preserved in the composed body.'),
      title: z.string().optional().describe('Optional explicit wiki title (defaults to a title derived from the page path / sources).'),
    },
    async ({ pagePath, sourceIds, title }) => {
      try {
        const note = await store.composeWiki({ pagePath, sourceIds, title });
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 10b. knowledge_base_compose_rebuild ───────────────────────────────────
  server.tool(
    'knowledge_base_compose_rebuild',
    'KB simple lane: re-run the deterministic composition over a wiki page\'s current sourceRefs[]. Refuses to overwrite a wiki body that has diverged from `lastComposedBodyHash` (or a wiki with no hash at all) unless `force: true`. Without force, divergence is surfaced as an error with code `manual_edits_present`.',
    {
      pageId: z.string().min(1).describe('Wiki note id (kb_*) to rebuild.'),
      force: z.boolean().optional().describe('Pass true to overwrite a wiki whose body has diverged from lastComposedBodyHash since the last compose/rebuild. Default false.'),
    },
    async ({ pageId, force }) => {
      try {
        const note = await store.rebuildComposedWiki(pageId, { force });
        return jsonResult({ note });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── KB v2 — Wiki Builder tools (Phase 2) ──────────────────────────────────
  //
  // Phase 2 ships the dry-run pipeline only — scan + plan + dry-run + trace +
  // history. Phase 3 adds build_run / approve / reject / revert (commit path).
  // Phase 4 wires the UI.
  //
  // The tools that don't need LLM calls (scan, plan, trace, history) work
  // immediately. `build_dry_run` requires a runtime LLM client, which this
  // MCP server does not provide yet — it uses a NoopLlmClient that throws a
  // clear error directing the caller to use the fixture client in tests or
  // wait for Phase 4's real LLM wiring.

  // KB v2 builder wiring. Defaults to the production OpenAI-backed client
  // when OPENAI_API_KEY is set, else a fail-fast Noop client that throws
  // a clear error directing the operator at the env var. Tests at the REST
  // layer can swap this via the router's setBuilderLlmClient(); the MCP
  // server doesn't expose a swap because MCP runs as its own process.
  const runStore = new KbBuildRunStore(store.getRootDir());
  const builder = new KbBuilder({ store, runStore, llm: selectLlmClient() });

  // ── 11. knowledge_base_build_scan ─────────────────────────────────────────
  server.tool(
    'knowledge_base_build_scan',
    'KB v2: scan the KB for build-eligible raw sources + stale/fresh wikis. Pure code, no LLM.',
    {
      path: z.string().optional().describe('Limit scan to a folder prefix, e.g. "inbox"'),
      sinceISO: z.string().optional().describe('Include raw notes updated after this ISO timestamp'),
    },
    async ({ path: p, sinceISO }) => {
      try {
        const result = await builder.scan({ path: p, sinceISO });
        return jsonResult(result);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 12. knowledge_base_build_plan ─────────────────────────────────────────
  server.tool(
    'knowledge_base_build_plan',
    'KB v2: run scan + cluster + match-or-create stages, returning the ActionPlan[] without synthesizing proposals. Uses the same source-selection bridge as build_dry_run so both surfaces agree on the same KB state.',
    {
      path: z.string().optional().describe('Scope prefix for scan stage'),
      targetRoom: z.string().optional().describe('Override target room for all create actions'),
    },
    async ({ path: p, targetRoom }) => {
      try {
        const scan = await builder.scan({ path: p });
        // Use the shared stage-1 → stage-2 bridge so build_plan and
        // build_dry_run cluster the SAME set (eligible sources + sources
        // cited by stale wikis).
        const allSources = await builder.collectSourcesForBuild(scan);
        if (allSources.length === 0) {
          return jsonResult({ scan, clusters: [], actions: [] });
        }
        const { clusters } = await builder.cluster(allSources);
        const actions = await builder.planActions(clusters, { targetRoom });
        return jsonResult({ scan, clusters, actions });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 13. knowledge_base_build_dry_run ──────────────────────────────────────
  server.tool(
    'knowledge_base_build_dry_run',
    'KB v2: run the full dry-run pipeline (scan → cluster → plan → synthesize). Writes ONE audit file under build-runs/, nothing else. Requires an LLM client to be configured.',
    {
      path: z.string().optional().describe('Scope prefix for scan stage'),
      targetRoom: z.string().optional().describe('Override target room for all create actions'),
      trigger: z
        .enum(['manual', 'scheduled', 'rebuild', 'test'])
        .optional()
        .describe('Trigger type recorded in the build run audit file'),
    },
    async ({ path: p, targetRoom, trigger }) => {
      try {
        const run = await builder.buildDryRun({
          scope: p ? { path: p } : undefined,
          targetRoom,
          trigger,
        });
        return jsonResult({ runId: run.runId, proposals: run.proposals, scan: run.scan, clusters: run.clusters, actions: run.actions });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 14. knowledge_base_trace_sources ──────────────────────────────────────
  server.tool(
    'knowledge_base_trace_sources',
    'KB v2: return the raw source notes cited by a wiki page (via its sourceRefs).',
    {
      wikiId: z.string().describe('Wiki note id (kb_*)'),
    },
    async ({ wikiId }) => {
      try {
        const sources = await store.traceSources(wikiId);
        return jsonResult({ sources });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 15. knowledge_base_trace_derivatives ──────────────────────────────────
  server.tool(
    'knowledge_base_trace_derivatives',
    'KB v2: return the wiki pages that cite a raw source note (via the consumedBy reverse index, with a disk-walk fallback).',
    {
      sourceId: z.string().describe('Raw source note id (kb_*)'),
    },
    async ({ sourceId }) => {
      try {
        const derivatives = await store.traceDerivatives(sourceId);
        return jsonResult({ derivatives });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 16. knowledge_base_build_history ──────────────────────────────────────
  server.tool(
    'knowledge_base_build_history',
    'KB v2: list recent build run summaries from the build-runs/ audit directory, most recent first.',
    {
      limit: z.number().int().min(0).max(500).optional().describe('Max results (default 50, 0 = all)'),
    },
    async ({ limit }) => {
      try {
        const runs = await runStore.list(limit ?? 50);
        return jsonResult({ runs });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 17. knowledge_base_build_run ──────────────────────────────────────────
  // Phase 3: run the pipeline and queue proposals for human review (no auto-commit).
  server.tool(
    'knowledge_base_build_run',
    'KB v2: run the full pipeline and queue proposals for human review. Proposals are NOT committed until knowledge_base_build_approve is called.',
    {
      path: z.string().optional().describe('Scope prefix for scan stage'),
      targetRoom: z.string().optional().describe('Override target room for all create actions'),
      trigger: z.enum(['manual', 'scheduled', 'rebuild', 'test']).optional(),
    },
    async ({ path: p, targetRoom, trigger }) => {
      try {
        const run = await builder.buildRun({
          scope: p ? { path: p } : undefined,
          targetRoom,
          trigger,
        });
        const awaitingReview = run.proposals.filter((p) => !p.needsReview).length;
        return jsonResult({ runId: run.runId, proposals: run.proposals, awaitingReview });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 18. knowledge_base_build_approve ──────────────────────────────────────
  server.tool(
    'knowledge_base_build_approve',
    'KB v2: commit the specified approved proposals from a build run. Writes wiki pages atomically via staging directory, updates consumedBy reverse index on cited sources, appends build_commit activity entries.',
    {
      runId: z.string().describe('Build run id from knowledge_base_build_run'),
      proposalIds: z.array(z.string()).min(1).describe('Proposal ids to approve'),
      edits: z.record(z.string(), z.record(z.string(), z.any())).optional().describe('Per-proposal field overrides (title, body, tags, targetPath, targetSlug)'),
    },
    async ({ runId, proposalIds, edits }) => {
      try {
        const result = await builder.approve(runId, proposalIds, edits as Record<string, Partial<import('../services/kb-builder-types.js').ProposedPage>> | undefined);
        return jsonResult(result);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 19. knowledge_base_build_reject ───────────────────────────────────────
  server.tool(
    'knowledge_base_build_reject',
    'KB v2: record a reject decision on the specified proposals from a build run. No wiki pages are written; the proposals stay in run.proposals for audit.',
    {
      runId: z.string().describe('Build run id'),
      proposalIds: z.array(z.string()).min(1).describe('Proposal ids to reject'),
      reason: z.string().optional().describe('Free-text reason for the rejection'),
    },
    async ({ runId, proposalIds, reason }) => {
      try {
        const result = await builder.reject(runId, proposalIds, reason);
        return jsonResult(result);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 20. knowledge_base_build_revert ───────────────────────────────────────
  server.tool(
    'knowledge_base_build_revert',
    'KB v2: reverse a previously committed build run. Deletes wikis that were created, restores merged wikis from their previous-body snapshots, and strips the reverted wiki ids from each cited source\'s consumedBy[] reverse index.',
    {
      runId: z.string().describe('Committed build run id to revert'),
    },
    async ({ runId }) => {
      try {
        const result = await builder.revert(runId);
        return jsonResult(result);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  // ── 21. knowledge_base_rebuild ────────────────────────────────────────────
  server.tool(
    'knowledge_base_rebuild',
    'KB v2: re-run the pipeline for a single wiki page, scoped to its current sourceRefs. Produces a merge proposal awaiting review via the normal review gate (does NOT auto-commit). Use when a wiki is flagged stale or the reviewer wants to regenerate a specific page.',
    {
      wikiId: z.string().describe('Wiki note id (kb_*) to rebuild'),
    },
    async ({ wikiId }) => {
      try {
        const run = await builder.rebuild(wikiId);
        const awaitingReview = run.proposals.filter((p) => !p.needsReview).length;
        return jsonResult({ runId: run.runId, proposals: run.proposals, awaitingReview });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  return server;
}


function errorMessage(err: unknown): string {
  if (err instanceof KbError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
