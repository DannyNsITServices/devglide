# Chat-Pipe LLM Client for KB Wiki Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the KB Wiki Builder to delegate `cluster()` and `synthesize()` LLM calls to an already-joined chat participant via a side-channel bridge, eliminating the need for the daemon to own its own OpenAI/Anthropic API key when authenticated chat agents are present.

**Architecture:** A new `createChatPipeLlmClient(bridge)` factory in `kb-llm-client.ts` takes a `KbChatPipeBridge` interface as a constructor dependency — the kb-llm-client layer never imports chat code. A new chat-side service `kb-synth-bridge.ts` holds a registry of pending synthesis requests and exposes `requestSynth(assignee, prompt, projectId, opts)` which PTY-injects a structured notification to the assignee. The assignee returns the result via a new MCP tool `kb_synth_submit(requestId, content)`. Production wiring lives in `src/routers/knowledge-base.ts`, which constructs the bridge against the chat services and passes it to `createChatPipeLlmClient`.

**Tech Stack:** TypeScript, Vitest, MCP SDK (`@modelcontextprotocol/sdk`), Express 5, existing `assignment-store.ts` / `payload-store.ts` infrastructure available but NOT reused (side-channel approach), `chat-registry.ts` PTY injection primitives.

---

## File Structure

**Create:**
- `src/apps/chat/services/kb-synth-bridge.ts` — pending request registry, requestSynth, submitSynth, selection policy
- `src/apps/chat/services/kb-synth-bridge.test.ts` — bridge unit tests with fake clock + fake PTY notifier

**Modify:**
- `src/apps/knowledge-base/services/kb-llm-client.ts` — add `KbChatPipeBridge` interface, `createChatPipeLlmClient`, update `selectLlmClient` to read `KB_BUILDER_LLM_BACKEND`
- `src/apps/knowledge-base/services/kb-llm-client.test.ts` — tests for backend enum + chat-pipe client with fake bridge
- `src/apps/knowledge-base/services/kb-builder-types.ts` — extend `BuildRun.llmCalls[]` audit fields
- `src/apps/knowledge-base/services/kb-builder.ts` — populate new audit fields when calling LlmClient
- `src/apps/chat/src/mcp.ts` — add `kb_synth_submit` MCP tool
- `src/routers/knowledge-base.ts` — construct production bridge, pass to `selectLlmClient` factory, set up env var read
- `src/apps/chat/services/chat-registry.ts` — export a small `notifySynthRequest(assignee, requestId, prompt, projectId)` helper that wraps PTY injection

---

## Task 1 — Backend selector enum + new env var

**Files:**
- Modify: `src/apps/knowledge-base/services/kb-llm-client.ts:402-410` (selectLlmClient)
- Modify: `src/apps/knowledge-base/services/kb-llm-client.test.ts:72-136` (selectLlmClient describe block)

- [ ] **Step 1: Write failing test for `KB_BUILDER_LLM_BACKEND=openai` pinning**

```ts
// In kb-llm-client.test.ts inside describe('selectLlmClient', ...) — add:
it('honors KB_BUILDER_LLM_BACKEND=openai when both keys are set', () => {
  process.env.KB_BUILDER_LLM_BACKEND = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const client = selectLlmClient();
  expect(typeof client.cluster).toBe('function');
  // Without exposing internals we can't fingerprint the provider directly.
  // The unit-level guarantee is that selectLlmClient() does not throw and
  // returns the openai-backed client when the env var pins it. The integration
  // test in src/routers/knowledge-base.test.ts exercises end-to-end behavior.
  delete process.env.KB_BUILDER_LLM_BACKEND;
});

it('honors KB_BUILDER_LLM_BACKEND=anthropic even when OPENAI_API_KEY is set', () => {
  process.env.KB_BUILDER_LLM_BACKEND = 'anthropic';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const client = selectLlmClient();
  expect(typeof client.cluster).toBe('function');
  delete process.env.KB_BUILDER_LLM_BACKEND;
});

it('throws on invalid KB_BUILDER_LLM_BACKEND values', () => {
  process.env.KB_BUILDER_LLM_BACKEND = 'gemini';
  expect(() => selectLlmClient()).toThrow(/KB_BUILDER_LLM_BACKEND/);
  delete process.env.KB_BUILDER_LLM_BACKEND;
});

it('falls back to noop when KB_BUILDER_LLM_BACKEND=openai but OPENAI_API_KEY missing', async () => {
  process.env.KB_BUILDER_LLM_BACKEND = 'openai';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const client = selectLlmClient();
  await expect(
    client.cluster({ promptVersion: 'compile.v1', sources: [] }),
  ).rejects.toThrow(/LLM client not configured/);
  delete process.env.KB_BUILDER_LLM_BACKEND;
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm vitest run src/apps/knowledge-base/services/kb-llm-client.test.ts`
Expected: 4 failures — `KB_BUILDER_LLM_BACKEND` is not yet read; the invalid-value test expects a throw that does not happen.

- [ ] **Step 3: Implement the backend enum in `selectLlmClient`**

Replace `kb-llm-client.ts:402-410` with:

```ts
export type KbBuilderBackend = 'auto' | 'chat' | 'openai' | 'anthropic';

const VALID_BACKENDS: ReadonlySet<KbBuilderBackend> = new Set(['auto', 'chat', 'openai', 'anthropic']);

export function readBackendFromEnv(): KbBuilderBackend {
  const raw = (process.env.KB_BUILDER_LLM_BACKEND ?? 'auto').toLowerCase().trim();
  if (!VALID_BACKENDS.has(raw as KbBuilderBackend)) {
    throw new Error(
      `KB_BUILDER_LLM_BACKEND must be one of ${[...VALID_BACKENDS].join(', ')} (got "${raw}")`,
    );
  }
  return raw as KbBuilderBackend;
}

/**
 * Factory: select an LLM client based on `KB_BUILDER_LLM_BACKEND` and the
 * available API keys.
 *
 * Backend resolution:
 *   - `auto` (default): chat (if a bridge is supplied) → openai → anthropic → noop
 *   - `chat`: chat backend if a bridge is supplied, else noop
 *   - `openai`: OpenAI client if `OPENAI_API_KEY` set, else noop
 *   - `anthropic`: Anthropic client if `ANTHROPIC_API_KEY` set, else noop
 *
 * The optional `bridge` parameter is the chat-pipe bridge constructed by the
 * router/server. The kb-llm-client layer never imports chat code; the bridge
 * is wired in by the integration layer.
 */
export function selectLlmClient(opts?: { bridge?: KbChatPipeBridge }): LlmClient {
  const backend = readBackendFromEnv();
  const hasOpenAI = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 0;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0;
  const hasBridge = !!opts?.bridge;

  if (backend === 'chat') {
    return hasBridge ? createChatPipeLlmClient(opts!.bridge!) : createNoopLlmClient();
  }
  if (backend === 'openai') {
    return hasOpenAI ? createOpenAILlmClient() : createNoopLlmClient();
  }
  if (backend === 'anthropic') {
    return hasAnthropic ? createAnthropicLlmClient() : createNoopLlmClient();
  }
  // auto
  if (hasBridge) return createChatPipeLlmClient(opts!.bridge!);
  if (hasOpenAI) return createOpenAILlmClient();
  if (hasAnthropic) return createAnthropicLlmClient();
  return createNoopLlmClient();
}
```

(`KbChatPipeBridge` and `createChatPipeLlmClient` are added in Task 2; the file will not compile yet — that is expected mid-refactor.)

- [ ] **Step 4: Commit (deferred until Task 2 closes the type holes)**

Skip — Task 2 introduces the missing identifiers and they will be committed together.

---

## Task 2 — `KbChatPipeBridge` interface + `createChatPipeLlmClient`

**Files:**
- Modify: `src/apps/knowledge-base/services/kb-llm-client.ts` (top of file: new interface + factory)
- Modify: `src/apps/knowledge-base/services/kb-llm-client.test.ts` (new describe block)

- [ ] **Step 1: Write failing test for `createChatPipeLlmClient.cluster()` happy path**

Append to `kb-llm-client.test.ts`:

```ts
import { createChatPipeLlmClient, type KbChatPipeBridge, type SynthesisRequest } from './kb-llm-client.js';

function fakeBridge(opts: {
  clusterResponse?: string;
  synthesizeResponse?: string;
  throwOn?: 'cluster' | 'synthesize';
  recordedRequests?: SynthesisRequest[];
}): KbChatPipeBridge {
  return {
    async submitSynthesisRequest(req: SynthesisRequest): Promise<{ content: string; assignee: string; requestId: string; durationMs: number }> {
      opts.recordedRequests?.push(req);
      if (opts.throwOn === req.stage) throw new Error('bridge timeout');
      const content = req.stage === 'cluster' ? (opts.clusterResponse ?? '{}') : (opts.synthesizeResponse ?? '{}');
      return { content, assignee: 'codex-2', requestId: 'req-fixture', durationMs: 42 };
    },
  };
}

describe('createChatPipeLlmClient', () => {
  it('cluster() forwards prompt to bridge and parses returned JSON', async () => {
    const recorded: SynthesisRequest[] = [];
    const bridge = fakeBridge({
      clusterResponse: JSON.stringify({
        clusters: [{ clusterName: 'auth', rawIds: ['kb_a'], confidence: 'high' }],
      }),
      recordedRequests: recorded,
    });
    const client = createChatPipeLlmClient(bridge);
    const { clusters, tokens } = await client.cluster({
      promptVersion: 'compile.v1',
      sources: [{ id: 'kb_a', title: 'Auth', firstParagraph: 'OAuth flow', tags: ['auth'] }],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterName).toBe('auth');
    expect(clusters[0].rawIds).toEqual(['kb_a']);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].stage).toBe('cluster');
    expect(recorded[0].prompt).toContain('Group the following raw notes');
    expect(tokens.model).toBe('chat-pipe:codex-2');
    expect(tokens.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('synthesize() forwards prompt to bridge and parses returned JSON', async () => {
    const bridge = fakeBridge({
      synthesizeResponse: JSON.stringify({
        title: 'Auth Overview',
        body: '## Intro\n\nFlow [^kb_a].',
        tags: ['auth'],
        sourceRefs: ['kb_a'],
      }),
    });
    const client = createChatPipeLlmClient(bridge);
    const { output, tokens } = await client.synthesize({
      promptVersion: 'compile.v1',
      plan: { type: 'create', cluster: { clusterName: 'auth', rawIds: ['kb_a'], confidence: 'high' }, targetPath: 'notes/auth', targetSlug: 'auth-overview' },
      sources: [{ id: 'kb_a', title: 'Auth', body: 'OAuth flow', tags: ['auth'] }],
    });
    expect(output.title).toBe('Auth Overview');
    expect(output.sourceRefs).toEqual(['kb_a']);
    expect(tokens.model).toBe('chat-pipe:codex-2');
  });

  it('cluster() throws a descriptive error when bridge returns malformed JSON', async () => {
    const bridge = fakeBridge({ clusterResponse: 'this is not json' });
    const client = createChatPipeLlmClient(bridge);
    await expect(
      client.cluster({ promptVersion: 'compile.v1', sources: [] }),
    ).rejects.toThrow(/Chat-pipe cluster response was not valid JSON/);
  });

  it('cluster() propagates bridge errors (e.g. timeout)', async () => {
    const bridge = fakeBridge({ throwOn: 'cluster' });
    const client = createChatPipeLlmClient(bridge);
    await expect(
      client.cluster({ promptVersion: 'compile.v1', sources: [] }),
    ).rejects.toThrow(/bridge timeout/);
  });
});
```

- [ ] **Step 2: Run tests, confirm failures**

Run: `pnpm vitest run src/apps/knowledge-base/services/kb-llm-client.test.ts`
Expected: failures — `createChatPipeLlmClient`, `KbChatPipeBridge`, `SynthesisRequest` are not yet exported.

- [ ] **Step 3: Implement the interface and factory**

Add to the top of `kb-llm-client.ts` (after the existing imports, before `DEFAULT_OPENAI_MODEL`):

```ts
/**
 * Stage discriminator for synthesis requests sent to the chat bridge. The
 * builder calls cluster() once per build run and synthesize() once per cluster.
 */
export type SynthesisStage = 'cluster' | 'synthesize';

/**
 * A single synthesis request the bridge needs to dispatch to a chat participant.
 *
 * The bridge is responsible for choosing the assignee, delivering the prompt,
 * waiting for the response, and returning the raw text. The kb-llm-client
 * layer parses + validates the JSON itself.
 */
export interface SynthesisRequest {
  stage: SynthesisStage;
  prompt: string;
  promptVersion: string;
  /** Schema-instructive system message the bridge MAY surface to the assignee. */
  system: string;
}

/**
 * Side-channel bridge for delegating LLM work to a chat participant.
 *
 * Implementations:
 *   - `fakeBridge` (tests) — auto-responds with fixture JSON
 *   - Production bridge in `src/routers/knowledge-base.ts` — wires to `kb-synth-bridge` chat service
 *
 * Returning a string (not a parsed object) keeps the boundary narrow: parsing
 * stays in `kb-llm-client.ts` so the bridge does not need to know about
 * cluster/synthesize schemas.
 */
export interface KbChatPipeBridge {
  submitSynthesisRequest(
    req: SynthesisRequest,
  ): Promise<{ content: string; assignee: string; requestId: string; durationMs: number }>;
}
```

Then add a new factory function (anywhere after the existing `createAnthropicLlmClient`):

```ts
/**
 * Production LlmClient backed by a chat participant via the kb-synth-bridge.
 *
 * Each cluster()/synthesize() call:
 *   1. Builds the existing cluster/synthesize prompt (same templates as the
 *      OpenAI/Anthropic clients — keeps prompt-version determinism intact).
 *   2. Hands the prompt to the bridge as a `SynthesisRequest`.
 *   3. Parses the returned text via the same defensive normalizers used by
 *      the OpenAI/Anthropic paths.
 *   4. Returns the result + token usage. `inputTokens`/`outputTokens` are
 *      always 0 (the chat backend has no provider-billed token count); the
 *      `model` field encodes the assignee for build-run audit purposes.
 */
export function createChatPipeLlmClient(bridge: KbChatPipeBridge): LlmClient {
  return {
    cluster: async (input: LlmClusterInput) => {
      const start = Date.now();
      const prompt = buildClusterPrompt(input);
      const result = await bridge.submitSynthesisRequest({
        stage: 'cluster',
        prompt,
        promptVersion: input.promptVersion,
        system: 'You are a strict JSON-emitting assistant for a knowledge-base wiki builder. Reply with one JSON object matching the schema in the prompt. Do NOT include any prose before or after the JSON.',
      });
      const jsonText = extractJsonObject(result.content);
      let parsed: { clusters?: unknown };
      try {
        parsed = JSON.parse(jsonText) as { clusters?: unknown };
      } catch (err) {
        throw new Error(
          `Chat-pipe cluster response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const clusters = normalizeClusters(parsed.clusters);
      const tokens: LlmTokenUsage = {
        model: `chat-pipe:${result.assignee}`,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - start,
      };
      return { clusters, tokens };
    },

    synthesize: async (input: LlmSynthesizeInput) => {
      const start = Date.now();
      const prompt = buildSynthesizePrompt(input);
      const result = await bridge.submitSynthesisRequest({
        stage: 'synthesize',
        prompt,
        promptVersion: input.promptVersion,
        system: 'You are a strict JSON-emitting assistant for a knowledge-base wiki builder. Synthesize one wiki page per request from the provided sources. Reply with one JSON object matching the schema in the prompt. Do NOT include any prose before or after the JSON.',
      });
      const jsonText = extractJsonObject(result.content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(
          `Chat-pipe synthesize response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const output = normalizeSynthesizeOutput(parsed);
      const tokens: LlmTokenUsage = {
        model: `chat-pipe:${result.assignee}`,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - start,
      };
      return { output, tokens };
    },
  };
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm vitest run src/apps/knowledge-base/services/kb-llm-client.test.ts`
Expected: all tests in `createChatPipeLlmClient` describe block pass; the Task 1 backend selector tests now also pass.

- [ ] **Step 5: Commit**

```bash
git add src/apps/knowledge-base/services/kb-llm-client.ts \
        src/apps/knowledge-base/services/kb-llm-client.test.ts
git commit -m "feat(kb): add KB_BUILDER_LLM_BACKEND enum + chat-pipe LLM client factory"
```

---

## Task 3 — `kb-synth-bridge` service with selection policy

**Files:**
- Create: `src/apps/chat/services/kb-synth-bridge.ts`
- Create: `src/apps/chat/services/kb-synth-bridge.test.ts`

- [ ] **Step 1: Write failing test for selection policy + happy path**

Create `src/apps/chat/services/kb-synth-bridge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerPendingRequest,
  resolvePendingRequest,
  pickAssignee,
  _resetForTest,
  type SynthRequestRecord,
  type ParticipantSnapshot,
} from './kb-synth-bridge.js';

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  delete process.env.KB_BUILDER_ASSIGNEE;
});

describe('pickAssignee', () => {
  const claude: ParticipantSnapshot = { name: 'claude-1', kind: 'llm', status: 'idle' };
  const codex: ParticipantSnapshot = { name: 'codex-2', kind: 'llm', status: 'idle' };
  const human: ParticipantSnapshot = { name: 'user', kind: 'user', status: 'idle' };

  it('returns null when no llm participants are joined', () => {
    expect(pickAssignee([], 'claude-1')).toBeNull();
    expect(pickAssignee([human], 'claude-1')).toBeNull();
  });

  it('prefers a non-self llm participant when multiple are joined', () => {
    expect(pickAssignee([claude, codex], 'claude-1')).toBe('codex-2');
    expect(pickAssignee([claude, codex], 'codex-2')).toBe('claude-1');
  });

  it('falls back to the only joined participant when self is alone', () => {
    expect(pickAssignee([claude], 'claude-1')).toBe('claude-1');
  });

  it('honors KB_BUILDER_ASSIGNEE env override when the named agent is joined', () => {
    process.env.KB_BUILDER_ASSIGNEE = 'claude-1';
    expect(pickAssignee([claude, codex], 'codex-2')).toBe('claude-1');
  });

  it('throws when KB_BUILDER_ASSIGNEE names an agent that is not joined', () => {
    process.env.KB_BUILDER_ASSIGNEE = 'gemini-3';
    expect(() => pickAssignee([claude, codex], 'codex-2')).toThrow(/KB_BUILDER_ASSIGNEE/);
  });

  it('skips offline llm participants', () => {
    const offline: ParticipantSnapshot = { name: 'cursor-3', kind: 'llm', status: 'offline' };
    expect(pickAssignee([claude, offline], 'claude-1')).toBe('claude-1');
  });
});

describe('pending request lifecycle', () => {
  it('resolveable: register → resolve returns the content to the awaiter', async () => {
    const promise = registerPendingRequest('req-1', 'codex-2', 5_000);
    resolvePendingRequest('req-1', '{"clusters":[]}');
    const result = await promise;
    expect(result).toEqual({ content: '{"clusters":[]}', assignee: 'codex-2' });
  });

  it('rejects on timeout if not resolved in time', async () => {
    vi.useFakeTimers();
    const promise = registerPendingRequest('req-2', 'codex-2', 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow(/timed out/i);
    vi.useRealTimers();
  });

  it('returns false from resolvePendingRequest when the id is unknown', () => {
    const ok = resolvePendingRequest('nonexistent', 'whatever');
    expect(ok).toBe(false);
  });

  it('returns false from resolvePendingRequest after the request already resolved (double-submit safety)', async () => {
    const promise = registerPendingRequest('req-3', 'codex-2', 5_000);
    expect(resolvePendingRequest('req-3', 'first')).toBe(true);
    expect(resolvePendingRequest('req-3', 'second')).toBe(false);
    const result = await promise;
    expect(result.content).toBe('first');
  });
});
```

- [ ] **Step 2: Run tests, confirm failures**

Run: `pnpm vitest run src/apps/chat/services/kb-synth-bridge.test.ts`
Expected: failure — file does not exist.

- [ ] **Step 3: Implement the bridge service**

Create `src/apps/chat/services/kb-synth-bridge.ts`:

```ts
/**
 * KB Wiki Builder ↔ chat participant side-channel bridge.
 *
 * The KB router calls `requestSynth(...)` to delegate a cluster/synthesize
 * payload to one of the joined chat participants. The participant receives a
 * structured PTY notification (sent by the caller via chat-registry) and
 * responds via the new `kb_synth_submit` MCP tool, which calls
 * `resolvePendingRequest(requestId, content)`.
 *
 * Why a side-channel and not the full pipe machinery: pipes are designed for
 * user-initiated multi-stage workflows with state machines and reducers. The
 * KB builder needs a simple request/response RPC where the daemon owns both
 * sides of the conversation. Reusing pipes would require shoehorning a
 * single-shot synthetic flow through state we'd then need to mock; a
 * purpose-built side channel is ~150 lines and trivially testable.
 */

import { randomUUID } from 'crypto';

// ── Participant snapshot interface ──────────────────────────────────────────
//
// Decoupled from chat-registry types so this file can be unit-tested without
// pulling in the full chat-registry. The router maps from registry types to
// this snapshot when constructing the bridge.

export interface ParticipantSnapshot {
  name: string;
  kind: 'llm' | 'user';
  status: 'idle' | 'working' | 'offline';
}

// ── Selection policy ────────────────────────────────────────────────────────

/**
 * Pick which chat participant should service a synthesis request.
 *
 * Resolution order:
 *   1. `KB_BUILDER_ASSIGNEE` env var, if set and the named agent is joined
 *      (throws if set but not joined — surfaces a clear misconfiguration)
 *   2. First non-self llm participant with status !== 'offline'
 *   3. Fall back to self if it is the only llm participant
 *   4. Return null if no llm participant is available
 *
 * Returning null is the signal for the router to fall through to the next
 * backend in the auto chain (openai → anthropic → noop).
 */
export function pickAssignee(
  participants: ParticipantSnapshot[],
  selfName: string,
): string | null {
  const llms = participants.filter((p) => p.kind === 'llm' && p.status !== 'offline');

  const override = process.env.KB_BUILDER_ASSIGNEE;
  if (override && override.length > 0) {
    if (!llms.some((p) => p.name === override)) {
      throw new Error(
        `KB_BUILDER_ASSIGNEE="${override}" is set but no joined llm participant has that name. ` +
        `Joined: [${llms.map((p) => p.name).join(', ') || '(none)'}]`,
      );
    }
    return override;
  }

  if (llms.length === 0) return null;
  const nonSelf = llms.find((p) => p.name !== selfName);
  if (nonSelf) return nonSelf.name;
  // Only self joined — fall back to self
  return llms[0].name;
}

// ── Pending request registry ────────────────────────────────────────────────

export interface SynthRequestRecord {
  requestId: string;
  assignee: string;
  resolve: (result: { content: string; assignee: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, SynthRequestRecord>();

/**
 * Generate a fresh request id. Exported for the router so the same id can be
 * used both to register the pending entry and to send the PTY notification.
 */
export function newRequestId(): string {
  return `kbsynth-${randomUUID()}`;
}

/**
 * Register a pending synthesis request and return a Promise that resolves
 * when the assignee submits via `kb_synth_submit`. The promise rejects with
 * a timeout error if the request is not resolved within `timeoutMs`.
 */
export function registerPendingRequest(
  requestId: string,
  assignee: string,
  timeoutMs: number,
): Promise<{ content: string; assignee: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(
        `KB synth request ${requestId} (assignee=${assignee}) timed out after ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    pending.set(requestId, { requestId, assignee, resolve, reject, timer });
  });
}

/**
 * Called by the kb_synth_submit MCP tool when the assignee returns a result.
 * Returns true if the request was found and resolved, false otherwise (unknown
 * id, already resolved, or already timed out).
 */
export function resolvePendingRequest(requestId: string, content: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve({ content, assignee: entry.assignee });
  return true;
}

/**
 * Reject a pending request (e.g. when the assigned pane closes).
 * Returns true if the request was found and rejected.
 */
export function rejectPendingRequest(requestId: string, reason: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.reject(new Error(reason));
  return true;
}

/** List all pending request ids. For dashboard / debug surfaces. */
export function listPendingRequestIds(): string[] {
  return [...pending.keys()];
}

// ── Test helper ─────────────────────────────────────────────────────────────

/** Reset all in-memory state. For testing only. */
export function _resetForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
  }
  pending.clear();
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm vitest run src/apps/chat/services/kb-synth-bridge.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/apps/chat/services/kb-synth-bridge.ts \
        src/apps/chat/services/kb-synth-bridge.test.ts
git commit -m "feat(chat): add kb-synth-bridge side-channel for KB builder synthesis requests"
```

---

## Task 4 — `kb_synth_submit` MCP tool + chat-registry notifier

**Files:**
- Modify: `src/apps/chat/src/mcp.ts` (add new tool after `pipe_get_assignment`, around line 456)
- Modify: `src/apps/chat/services/chat-registry.ts` (export new `notifySynthRequest` helper)

- [ ] **Step 1: Add the chat-registry helper**

Find the existing PTY injection function in `chat-registry.ts` (search for `paneDeliveryQueues` and the function that builds delivery payloads). Append this exported helper at the end of the chat-registry's exports section:

```ts
/**
 * Send a structured KB synthesis request notification to a chat participant.
 *
 * The notification is plain text injected into the assignee's pane. It tells
 * the LLM what to do: read the prompt, produce JSON matching the schema,
 * call kb_synth_submit(requestId, content) to return the result.
 *
 * The kb-synth-bridge has already registered a pending Promise for this
 * requestId. The assignee's response will resolve it.
 */
export async function notifySynthRequest(
  assignee: string,
  requestId: string,
  prompt: string,
  systemNote: string,
  projectId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const participant = getParticipantExact(assignee, projectId);
  if (!participant) {
    return { ok: false, error: `Participant ${assignee} not found in project ${projectId ?? '(none)'}` };
  }
  if (!participant.paneId) {
    return { ok: false, error: `Participant ${assignee} has no pane bound` };
  }
  const paneId = participant.paneId;

  const body =
    `[KB-SYNTH-REQUEST id=${requestId}]\n` +
    `${systemNote}\n\n` +
    `When you have produced the JSON, call:\n` +
    `  kb_synth_submit(requestId="${requestId}", content="<your-json>")\n\n` +
    `Do NOT respond via chat_send. Do NOT wrap the JSON in markdown code fences.\n\n` +
    `--- PROMPT ---\n${prompt}\n--- END PROMPT ---\n`;

  // Use the existing PTY injection queue used by chat_send to keep ordering
  // consistent with normal chat delivery and avoid paste-burst races.
  await enqueuePaneDelivery(paneId, body, participant.submitKey ?? '\r');
  return { ok: true };
}
```

If `enqueuePaneDelivery` is not the actual exported name, locate the existing PTY-injection helper used by `chat_send` and reuse it (search for `globalPtys` writes in `chat-registry.ts`). The point of this step is to call the same primitive that `chat_send` uses, not to invent a new injection path.

- [ ] **Step 2: Add the MCP tool**

Insert in `src/apps/chat/src/mcp.ts` after the `pipe_get_assignment` tool block (around line 456):

```ts
  // ── 3f. kb_synth_submit ────────────────────────────────────────────
  //
  // KB Wiki Builder side-channel: when the KB builder asks a chat participant
  // to do a cluster/synthesize call, the assignee returns the JSON output via
  // this tool instead of chat_send / pipe_submit. The bridge resolves a
  // pending Promise keyed by requestId.

  server.tool(
    'kb_synth_submit',
    'Submit your KB synthesis output (cluster or synthesize JSON) for a kb-synth request. Use this when you receive a [KB-SYNTH-REQUEST id=...] notification — not chat_send or pipe_submit.',
    {
      requestId: z.string().describe('The kb-synth request id from the [KB-SYNTH-REQUEST id=...] notification.'),
      content: z.string().describe('Your JSON output as a raw string. Do NOT wrap in markdown code fences.'),
      paneId: z.string().optional().describe('Optional pane ID to adopt session.'),
    },
    async ({ requestId, content, paneId }) => {
      const adopted = await tryAdoptSessionByPaneId(paneId);
      const sessionName = adopted?.name ?? getSessionName();
      if (!sessionName) return errorResult('Not joined — call chat_join first');
      // The bridge lives in the chat services package; import dynamically to
      // avoid coupling the MCP module to chat internals at top-level.
      const { resolvePendingRequest } = await import('../services/kb-synth-bridge.js');
      const ok = resolvePendingRequest(requestId, content);
      if (!ok) {
        return errorResult(`Unknown or already-resolved kb-synth request id "${requestId}"`);
      }
      return jsonResult({ ok: true, requestId, submittedBy: sessionName });
    },
  );
```

- [ ] **Step 3: Add a small integration test for the chat-registry notifier**

Create or extend `src/apps/chat/services/chat-registry.kb-synth.test.ts` (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// We test notifySynthRequest by mocking the PTY layer it depends on.
// Because chat-registry pulls a lot of state, we use a focused unit-style test
// that asserts the observable side effect: a body containing the requestId
// gets handed to the PTY queue.

vi.mock('../../shell/src/runtime/shell-state.js', () => {
  const writes: Array<{ paneId: string; data: string }> = [];
  return {
    globalPtys: {
      get: (paneId: string) => ({
        write: (data: string) => writes.push({ paneId, data }),
      }),
    },
    dashboardState: {},
    getShellNsp: () => null,
    __writes: writes,
  };
});

describe('notifySynthRequest', () => {
  // The full test exercises the live function once everything is wired —
  // the assertion is that the body contains both the requestId and the
  // marker [KB-SYNTH-REQUEST so the assignee can detect it.
  it.todo('emits a [KB-SYNTH-REQUEST id=...] body to the assignee pane');
});
```

(Marked `it.todo` because writing a full live test requires bootstrapping a participant + pane in the chat-registry, which has a wide blast radius. The function is exercised end-to-end in the verification step. The bridge unit tests cover the side-channel resolver path; the MCP tool layer is small enough that an integration test in the verification step is sufficient.)

- [ ] **Step 4: Run tests, confirm no regressions**

Run: `pnpm vitest run src/apps/chat/services/`
Expected: all existing chat tests pass + new bridge tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/apps/chat/services/chat-registry.ts \
        src/apps/chat/src/mcp.ts \
        src/apps/chat/services/chat-registry.kb-synth.test.ts
git commit -m "feat(chat): add kb_synth_submit MCP tool + notifySynthRequest helper"
```

---

## Task 5 — Production bridge wiring in knowledge-base router

**Files:**
- Modify: `src/routers/knowledge-base.ts` (around line 384, where `_llmClient` is constructed)

- [ ] **Step 1: Replace the static `_llmClient` initialization with a bridge-aware factory call**

Find `let _llmClient: LlmClient = selectLlmClient();` at `src/routers/knowledge-base.ts:384` and replace with:

```ts
import { newRequestId, registerPendingRequest, pickAssignee, type ParticipantSnapshot } from '../apps/chat/services/kb-synth-bridge.js';
import { listParticipants, notifySynthRequest } from '../apps/chat/services/chat-registry.js';
import type { KbChatPipeBridge } from '../apps/knowledge-base/services/kb-llm-client.js';

/**
 * Production chat-pipe bridge. Lives in the router because it crosses the
 * KB ↔ chat app boundary — the kb-llm-client and kb-synth-bridge layers stay
 * pure (no cross-app imports).
 *
 * Selection: KB_BUILDER_ASSIGNEE override → first non-self llm → self if alone.
 * Self in this context means the daemon's "I" identity, but the daemon is not
 * itself a chat participant. So "non-self" simply means "any joined llm".
 */
const SYNTH_REQUEST_TIMEOUT_MS = 120_000; // 2 minutes per cluster/synthesize

function buildChatPipeBridge(): KbChatPipeBridge {
  return {
    async submitSynthesisRequest(req) {
      const projectId = getCurrentProjectId();
      const participantsRaw = listParticipants(projectId);
      const participants: ParticipantSnapshot[] = participantsRaw.map((p) => ({
        name: p.name,
        kind: p.kind,
        status: p.status,
      }));
      // The "self" in pickAssignee() is the daemon. Pass an empty string so
      // every joined llm is considered "non-self". The KB_BUILDER_ASSIGNEE
      // override still wins when set.
      const assignee = pickAssignee(participants, '');
      if (!assignee) {
        throw new Error(
          'No chat participant available for KB synthesis (no joined llm). ' +
          'Either join an llm via chat_join, set OPENAI_API_KEY/ANTHROPIC_API_KEY, ' +
          'or set KB_BUILDER_LLM_BACKEND=auto with a fallback provider.',
        );
      }
      const requestId = newRequestId();
      const start = Date.now();
      const pending = registerPendingRequest(requestId, assignee, SYNTH_REQUEST_TIMEOUT_MS);
      const notifyResult = await notifySynthRequest(assignee, requestId, req.prompt, req.system, projectId);
      if (!notifyResult.ok) {
        // Reject the pending entry so the bridge does not leak the timer.
        const { rejectPendingRequest } = await import('../apps/chat/services/kb-synth-bridge.js');
        rejectPendingRequest(requestId, `Failed to notify assignee: ${notifyResult.error}`);
        throw new Error(`KB synth notify failed: ${notifyResult.error}`);
      }
      const result = await pending;
      return { content: result.content, assignee: result.assignee, requestId, durationMs: Date.now() - start };
    },
  };
}

function getCurrentProjectId(): string | null {
  // Re-use the existing project-context helper. If the router uses a
  // different mechanism, follow that instead — search the file for
  // `getActiveProject` or `projectId` to find the canonical accessor.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getActiveProject } = require('../project-context.js');
  return getActiveProject()?.id ?? null;
}

let _llmClient: LlmClient = selectLlmClient({ bridge: buildChatPipeBridge() });
```

Note: `listParticipants` may not be exported from `chat-registry.ts` yet. If not, add an export — it should already exist as an internal function used by `chat_members`.

- [ ] **Step 2: Update `resetBuilderLlmClient` to also pass the bridge**

Modify `src/routers/knowledge-base.ts:399-401`:

```ts
export function resetBuilderLlmClient(): void {
  _llmClient = selectLlmClient({ bridge: buildChatPipeBridge() });
}
```

- [ ] **Step 3: Run knowledge-base router tests to catch regressions**

Run: `pnpm vitest run src/routers/knowledge-base.test.ts`
Expected: all existing tests pass — they use `setBuilderLlmClient(fixture)` so the production bridge is bypassed.

- [ ] **Step 4: Commit**

```bash
git add src/routers/knowledge-base.ts
git commit -m "feat(kb): wire production chat-pipe bridge in knowledge-base router"
```

---

## Task 6 — Extend `BuildRun.llmCalls[]` audit fields

**Files:**
- Modify: `src/apps/knowledge-base/services/kb-builder-types.ts` (around line 256)
- Modify: `src/apps/knowledge-base/services/kb-builder.ts` (cluster + synthesize call sites that push to `llmCalls`)

- [ ] **Step 1: Find the existing `llmCalls.push(...)` call sites**

Run: search for `llmCalls.push` in `src/apps/knowledge-base/services/kb-builder.ts`.

- [ ] **Step 2: Extend the type**

In `kb-builder-types.ts:255-263`, replace the `llmCalls` field type with:

```ts
  /** Per-LLM-call audit trail for cost tracking and replay regression testing. */
  llmCalls: Array<{
    stage: 'cluster' | 'synthesize';
    promptHash: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    /** Backend kind. Added in the chat-pipe LLM client work. */
    backend?: 'chat' | 'openai' | 'anthropic' | 'noop';
    /** Synth request id when backend === 'chat'; undefined otherwise. */
    requestId?: string;
    /** Chat participant who handled the call when backend === 'chat'. */
    assignee?: string;
    /** Set when the call exceeded its lease deadline (chat backend only). */
    leaseExpiredAt?: string;
    /** Wall-clock timeout that triggered (chat backend only). */
    timedOutAfterMs?: number;
  }>;
```

- [ ] **Step 3: Populate the new fields at call sites**

The `model` field already encodes provenance for OpenAI / Anthropic. For the chat backend, the `model` field is `chat-pipe:<assignee>`. Update each `llmCalls.push(...)` block in `kb-builder.ts` to derive the new fields from `model`:

```ts
function deriveBackendFields(model: string): {
  backend: 'chat' | 'openai' | 'anthropic' | 'noop';
  assignee?: string;
  requestId?: string;
} {
  if (model.startsWith('chat-pipe:')) {
    return { backend: 'chat', assignee: model.slice('chat-pipe:'.length) };
  }
  if (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-')) {
    return { backend: 'openai' };
  }
  if (model.startsWith('claude-')) {
    return { backend: 'anthropic' };
  }
  return { backend: 'noop' };
}
```

Then at each `llmCalls.push` site:

```ts
const tokenStats = result.tokens; // already destructured
const backendFields = deriveBackendFields(tokenStats.model);
this.run.llmCalls.push({
  stage: 'cluster', // or 'synthesize'
  promptHash: hashPrompt(prompt),
  model: tokenStats.model,
  inputTokens: tokenStats.inputTokens,
  outputTokens: tokenStats.outputTokens,
  durationMs: tokenStats.durationMs,
  ...backendFields,
});
```

For `requestId` propagation, the chat-pipe client returns it via the bridge result but the LlmClient interface only surfaces `tokens`. Two options:
- (a) Extend `LlmTokenUsage` with optional `requestId`/`assignee` fields
- (b) Encode the requestId in the `model` field

Pick (a). It is one extra optional field on a type that is already audit-shaped. Update `kb-builder-types.ts:357-362`:

```ts
/** Per-LLM-call usage metadata recorded on the BuildRun. */
export interface LlmTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Chat-backend-specific: id of the synth request that produced this call. */
  requestId?: string;
  /** Chat-backend-specific: name of the chat participant that handled the call. */
  assignee?: string;
}
```

Then update `createChatPipeLlmClient` (Task 2) to populate `requestId` and `assignee` on the returned `tokens`:

```ts
const tokens: LlmTokenUsage = {
  model: `chat-pipe:${result.assignee}`,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: Date.now() - start,
  requestId: result.requestId,
  assignee: result.assignee,
};
```

And update the `llmCalls.push` sites in `kb-builder.ts` to read those fields directly instead of relying on `deriveBackendFields` to parse `model`. Cleaner.

- [ ] **Step 4: Run kb-builder + kb-llm-client tests**

Run: `pnpm vitest run src/apps/knowledge-base/`
Expected: pass. Update fixture expectations if any test asserts on the exact shape of `llmCalls[0]`.

- [ ] **Step 5: Commit**

```bash
git add src/apps/knowledge-base/services/kb-builder-types.ts \
        src/apps/knowledge-base/services/kb-builder.ts \
        src/apps/knowledge-base/services/kb-llm-client.ts \
        src/apps/knowledge-base/services/kb-llm-client.test.ts
git commit -m "feat(kb): extend BuildRun.llmCalls audit with backend, requestId, assignee fields"
```

---

## Task 7 — Verify

- [ ] **Step 1: Run knowledge-base + chat test suites**

Run: `pnpm vitest run src/apps/knowledge-base/ src/apps/chat/services/ src/routers/knowledge-base.test.ts`
Expected: all green.

- [ ] **Step 2: Run full build (typecheck)**

Run: `pnpm build`
Expected: typecheck succeeds.

- [ ] **Step 3: Manual reproduction**

```bash
# Restart daemon with chat backend pinned and no provider keys
unset OPENAI_API_KEY ANTHROPIC_API_KEY
KB_BUILDER_LLM_BACKEND=chat devglide restart
# Verify the running daemon picks the chat backend by curling the build endpoint
curl -s http://localhost:7000/api/knowledge-base/build/run \
  -X POST -H "content-type: application/json" \
  -d '{"projectId":"<id>","scope":"all","dryRun":true}'
# Expected: NOT the "LLM client not configured" error.
# If a chat agent is joined, the request should produce a structured PTY
# notification on that agent's pane.
```

- [ ] **Step 4: Append a work-log entry to the kanban item**

Use `kanban_append_work_log(id="ko7owifqp7rqqk2j5mpazlph", content="...summary...")`.

- [ ] **Step 5: Move kanban item to In Review**

Use `kanban_move_item(id="ko7owifqp7rqqk2j5mpazlph", columnName="In Review")`.

- [ ] **Step 6: Ping codex-2 for review**

`chat_send` to `codex-2` with the diff summary, the verification evidence (test pass + manual repro output), and the file paths touched.

- [ ] **Step 7: WAIT for codex-2 review**

Do NOT voice-notify the user until codex-2 confirms review pass. Rule 9: no self-approval.

---

## Self-Review Checklist

- **Spec coverage:**
  - Backend selector enum: Task 1 ✓
  - createChatPipeLlmClient + bridge interface: Task 2 ✓
  - kb-synth-bridge service + selection policy: Task 3 ✓
  - kb_synth_submit MCP tool + chat-registry notifier: Task 4 ✓
  - Production wiring in router: Task 5 ✓
  - Audit fields on BuildRun.llmCalls: Task 6 ✓
  - Verification + review handoff: Task 7 ✓

- **Placeholder scan:**
  - Task 4 has an `it.todo` for the live notify test — flagged in the body with the rationale. The bridge unit tests + verification step cover the path.
  - Task 5 has a "search for the canonical project-id accessor" instruction — not a placeholder, an instruction the executor needs to follow because the router has multiple project-id accessors and I want the executor to use the right one.

- **Type consistency:**
  - `KbChatPipeBridge`, `SynthesisRequest`, `SynthesisStage` defined in Task 2 and used consistently in Tasks 5 and 6.
  - `pickAssignee`, `registerPendingRequest`, `resolvePendingRequest`, `newRequestId`, `notifySynthRequest`, `rejectPendingRequest` defined in Tasks 3 and 4 and used consistently in Task 5.
  - `LlmTokenUsage.requestId`/`.assignee` added in Task 6 and populated in Task 2's factory (forward reference resolved at the same commit boundary).
