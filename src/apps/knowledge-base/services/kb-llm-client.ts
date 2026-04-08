/**
 * KB v2 — production LlmClient implementations.
 *
 * Four flavors:
 *   1. `createOpenAILlmClient(opts?)` — calls the OpenAI Chat Completions API
 *      via the `openai` SDK already installed in the repo. Reads model + base
 *      URL from env vars (KB_BUILDER_MODEL, OPENAI_BASE_URL) so the same code
 *      works against OpenAI proper, an OpenAI-compatible local llama.cpp
 *      server, or any compatible proxy.
 *   2. `createAnthropicLlmClient(opts?)` — calls the Anthropic Messages API
 *      directly via `fetch` (no SDK dependency added). Reads model + base URL
 *      from env vars (KB_BUILDER_MODEL, ANTHROPIC_BASE_URL). Used as the
 *      fallback when `OPENAI_API_KEY` is unset but `ANTHROPIC_API_KEY` is set
 *      — natural for Claude Code users who already have Anthropic creds.
 *   3. `createNoopLlmClient()` — fail-fast placeholder used when neither key
 *      is configured. Throws a clear error directing the operator at the env
 *      var set-up. The MCP server and the REST router fall back to this so
 *      accidental misconfiguration is loud, not silent.
 *   4. `selectLlmClient()` — factory that picks the first available provider
 *      in order: OpenAI → Anthropic → Noop. Used by the router and MCP server.
 *
 * Why fetch instead of `@anthropic-ai/sdk`: adding a second SDK doubles the
 * dependency surface. The Messages API is small enough (one POST endpoint, one
 * response shape) that a ~80 line fetch wrapper is cheaper than a 150KB
 * transitive dep. The shape is locked by Anthropic's stable API contract.
 */

import OpenAI from 'openai';
import type {
  ClusterPlan,
  LlmClient,
  LlmClusterInput,
  LlmSynthesizeInput,
  LlmTokenUsage,
} from './kb-builder-types.js';

/**
 * Default model for each provider. Both defaults are cheap, fast, and good
 * at structured JSON output. `KB_BUILDER_MODEL` overrides whichever provider
 * is active — set it to a model name the active provider understands.
 */
const DEFAULT_OPENAI_MODEL = process.env.KB_BUILDER_MODEL ?? 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = process.env.KB_BUILDER_MODEL ?? 'claude-haiku-4-5-20251001';

/**
 * Production LlmClient backed by the OpenAI Chat Completions API.
 *
 * Both stages (cluster + synthesize) use temperature 0 for deterministic
 * regression testing. The LLM is asked to return strict JSON; we parse it
 * with try/catch and fall back to throwing if the JSON is malformed (the
 * builder's stage validators handle the validation logic on top of that).
 *
 * Token / latency stats are returned in `LlmTokenUsage` and recorded on
 * the BuildRun for audit + cost tracking.
 */
export function createOpenAILlmClient(opts?: { model?: string }): LlmClient {
  const client = new OpenAI();
  const model = opts?.model ?? DEFAULT_OPENAI_MODEL;

  return {
    cluster: async (input: LlmClusterInput) => {
      const start = Date.now();
      const prompt = buildClusterPrompt(input);
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a strict JSON-emitting assistant for a knowledge-base wiki builder. Always reply with one JSON object matching the schema in the user prompt.' },
          { role: 'user', content: prompt },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '{}';
      let parsed: { clusters?: unknown };
      try {
        parsed = JSON.parse(text) as { clusters?: unknown };
      } catch (err) {
        throw new Error(`OpenAI cluster response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const clusters = normalizeClusters(parsed.clusters);
      const tokens: LlmTokenUsage = {
        model,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - start,
      };
      return { clusters, tokens };
    },

    synthesize: async (input: LlmSynthesizeInput) => {
      const start = Date.now();
      const prompt = buildSynthesizePrompt(input);
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a strict JSON-emitting assistant for a knowledge-base wiki builder. Synthesize one wiki page per request from the provided sources. Always reply with one JSON object matching the schema in the user prompt.' },
          { role: 'user', content: prompt },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '{}';
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`OpenAI synthesize response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const output = normalizeSynthesizeOutput(parsed);
      const tokens: LlmTokenUsage = {
        model,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - start,
      };
      return { output, tokens };
    },
  };
}

/**
 * Pinned cluster prompt template. Builder code uses
 * `BUILDER_PROMPT_VERSION = 'compile.v1'` and the prompt content here is
 * what that version maps to. Bumping the version requires changing both.
 */
function buildClusterPrompt(input: LlmClusterInput): string {
  const sourcesJson = JSON.stringify(
    input.sources.map((s) => ({
      id: s.id,
      title: s.title,
      firstParagraph: s.firstParagraph,
      tags: s.tags,
      source: s.source,
    })),
    null,
    2,
  );
  return `Group the following raw notes by topic. Each note id belongs to AT MOST ONE cluster.
Items you are uncertain about go into a cluster named "needs-review".

Constraints:
- Every returned id MUST exist in the input set (no hallucinated ids).
- Cluster names should be short, descriptive, identifier-style (lowercase, hyphenated).
- Confidence is one of "high", "medium", "low".

Reply with JSON matching this schema:
{
  "clusters": [
    { "clusterName": "auth", "rawIds": ["kb_..."], "confidence": "high" }
  ]
}

Input notes:
${sourcesJson}`;
}

/**
 * Pinned synthesize prompt template. Mirrors the rules in the builder spec
 * and validates downstream against `validateSynthesizeOutput`.
 */
function buildSynthesizePrompt(input: LlmSynthesizeInput): string {
  const sourcesBlock = input.sources
    .map((s) => `### Source ${s.id}: ${s.title}\nTags: ${s.tags.join(', ')}\n\n${s.body}`)
    .join('\n\n---\n\n');
  const mergeContext = input.existingWikiBody
    ? `\nThis is a MERGE: integrate new material into the existing wiki body below. Mark new sections with a "(New in this build)" note. Preserve all pre-existing citations.\n\n### Existing wiki body\n${input.existingWikiBody}\n`
    : '';
  return `Compose one refined wiki page from the source notes provided.

Rules:
1. Cite every factual claim with inline footnote references using [^kb_id] syntax. Every claim must be traceable.
2. Use structured markdown sections (## headers) for readability.
3. Do NOT introduce facts that are not present in the sources.
4. If sources conflict, surface the conflict explicitly: "Source A says X; source B says Y."
5. Preserve direct quotes with attribution.
6. Suggest tags drawn from source tags plus topical extraction.

Reply with JSON matching this schema:
{
  "title": "Auth overview",
  "body": "## Section\\n\\nClaim [^kb_abc].",
  "tags": ["auth"],
  "sourceRefs": ["kb_abc"]
}
${mergeContext}

Input sources:
${sourcesBlock}`;
}

/**
 * Defensive normalizer for the LLM cluster response. Drops malformed
 * entries rather than throwing — the builder validator handles the
 * higher-level constraint that every input id ends up somewhere.
 */
function normalizeClusters(raw: unknown): ClusterPlan[] {
  if (!Array.isArray(raw)) return [];
  const out: ClusterPlan[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const clusterName = typeof e.clusterName === 'string' ? e.clusterName : '';
    const rawIds = Array.isArray(e.rawIds) ? e.rawIds.filter((id): id is string => typeof id === 'string') : [];
    const confidenceRaw = typeof e.confidence === 'string' ? e.confidence : 'medium';
    const confidence: ClusterPlan['confidence'] =
      confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
        ? confidenceRaw
        : 'medium';
    if (clusterName === '' || rawIds.length === 0) continue;
    out.push({ clusterName, rawIds, confidence });
  }
  return out;
}

/** Defensive normalizer for the synthesize response. */
function normalizeSynthesizeOutput(raw: unknown): { title: string; body: string; tags: string[]; sourceRefs: string[] } {
  if (!raw || typeof raw !== 'object') {
    return { title: '', body: '', tags: [], sourceRefs: [] };
  }
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title : '';
  const body = typeof r.body === 'string' ? r.body : '';
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
  const sourceRefs = Array.isArray(r.sourceRefs)
    ? r.sourceRefs.filter((id): id is string => typeof id === 'string')
    : [];
  return { title, body, tags, sourceRefs };
}

/**
 * Production LlmClient backed by the Anthropic Messages API.
 *
 * Uses the global `fetch` (Node 18+) directly — no `@anthropic-ai/sdk`
 * dependency added. The Messages API is a single POST endpoint with a stable
 * request/response shape, so the wrapper stays small.
 *
 * Both stages (cluster + synthesize) use temperature 0 for deterministic
 * regression testing. Anthropic does not support a native JSON-mode toggle,
 * so we extract the JSON object from the response text via a balanced-brace
 * scan and parse it. The existing prompts already specify "Reply with JSON
 * matching this schema", so well-behaved models return clean JSON anyway.
 *
 * Token / latency stats are returned in `LlmTokenUsage` and recorded on the
 * BuildRun for audit + cost tracking.
 */
export function createAnthropicLlmClient(opts?: { model?: string }): LlmClient {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = opts?.model ?? DEFAULT_ANTHROPIC_MODEL;
  const apiVersion = '2023-06-01';
  // Generous cap; the synthesize stage may produce a multi-section wiki page.
  // Anthropic charges per output token, so this is a ceiling, not a target.
  const maxTokens = 4096;

  async function callMessages(systemPrompt: string, userPrompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': apiVersion,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic Messages API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
  }

  return {
    cluster: async (input: LlmClusterInput) => {
      const start = Date.now();
      const prompt = buildClusterPrompt(input);
      const { text, inputTokens, outputTokens } = await callMessages(
        'You are a strict JSON-emitting assistant for a knowledge-base wiki builder. Always reply with one JSON object matching the schema in the user prompt. Do NOT include any prose before or after the JSON.',
        prompt,
      );
      const jsonText = extractJsonObject(text);
      let parsed: { clusters?: unknown };
      try {
        parsed = JSON.parse(jsonText) as { clusters?: unknown };
      } catch (err) {
        throw new Error(`Anthropic cluster response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const clusters = normalizeClusters(parsed.clusters);
      const tokens: LlmTokenUsage = {
        model,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - start,
      };
      return { clusters, tokens };
    },

    synthesize: async (input: LlmSynthesizeInput) => {
      const start = Date.now();
      const prompt = buildSynthesizePrompt(input);
      const { text, inputTokens, outputTokens } = await callMessages(
        'You are a strict JSON-emitting assistant for a knowledge-base wiki builder. Synthesize one wiki page per request from the provided sources. Always reply with one JSON object matching the schema in the user prompt. Do NOT include any prose before or after the JSON.',
        prompt,
      );
      const jsonText = extractJsonObject(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(`Anthropic synthesize response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const output = normalizeSynthesizeOutput(parsed);
      const tokens: LlmTokenUsage = {
        model,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - start,
      };
      return { output, tokens };
    },
  };
}

/**
 * Best-effort extractor for the first balanced JSON object inside a text
 * blob. Anthropic responses normally return clean JSON when prompted, but a
 * stray model may wrap the JSON in fenced code blocks or add a trailing line.
 * This walks the text, locates the first `{`, and returns the substring up
 * to the matching closing `}`. Falls through to returning the whole text
 * (which JSON.parse can fail on, surfacing the error to the caller).
 */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return trimmed;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return trimmed.slice(start);
}

/**
 * Fail-fast placeholder LlmClient. Used when no API key is configured.
 * Throws on every cluster/synthesize call with a message directing the
 * operator at one of the supported provider env vars.
 */
export function createNoopLlmClient(): LlmClient {
  // The "LLM client not configured" prefix is matched by REST integration
  // tests that exercise the no-API-key path. Don't change the wording
  // without updating those tests too. The OPENAI_API_KEY mention is also
  // matched by tests that pre-date the Anthropic fallback.
  const err = new Error(
    'LLM client not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in ' +
      'the environment (and optionally KB_BUILDER_MODEL, OPENAI_BASE_URL, ' +
      'ANTHROPIC_BASE_URL) to enable real builds, or use setBuilderLlmClient() ' +
      'with a fixture client in tests.',
  );
  return {
    cluster: async () => { throw err; },
    synthesize: async () => { throw err; },
  };
}

/**
 * Factory: select the first available production client by env-var probe.
 * Order: OpenAI → Anthropic → Noop. OpenAI wins when both keys are set
 * because the OpenAI SDK was the original integration and existing
 * deployments expect it as the default; users who only have an Anthropic key
 * (e.g. Claude Code users) get the Anthropic fallback automatically.
 *
 * Called once per router instance and per MCP server bootstrap.
 */
export function selectLlmClient(): LlmClient {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 0) {
    return createOpenAILlmClient();
  }
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
    return createAnthropicLlmClient();
  }
  return createNoopLlmClient();
}
