/**
 * AI text cleanup — transforms raw transcription into polished text via LLM.
 */

import type OpenAI from "openai";
import { configStore } from "./config-store.js";

type OpenAIConstructor = typeof OpenAI;
type OpenAILikeClient = InstanceType<OpenAIConstructor>;

function isOpenAIConstructor(value: unknown): value is OpenAIConstructor {
  return typeof value === "function";
}

async function loadOpenAIConstructor(): Promise<OpenAIConstructor> {
  const mod = await import("openai");
  if (!isOpenAIConstructor(mod.default)) {
    throw new Error("The installed openai package does not expose the expected default constructor");
  }
  return mod.default;
}

let _OpenAI: OpenAIConstructor | null = null;
let _cleanupClient: OpenAILikeClient | null = null;
let _lastClientKey = "";

const SYSTEM_PROMPT = `You are a text cleanup assistant for developer voice input. Your job is to transform raw speech-to-text transcription into clean, professional text.

Rules:
- Remove filler words (um, uh, like, you know, basically, actually, sort of, kind of, I mean)
- Fix grammar and punctuation
- Preserve ALL technical terms exactly as spoken (API names, package names, code references)
- Keep the original meaning and intent — do not add information
- Structure clearly: use paragraphs for distinct thoughts
- If the input is a command or instruction, keep it concise and actionable
- Return ONLY the cleaned text — no explanations or commentary`;

function getClient(provider: string, apiKey?: string, baseURL?: string): OpenAILikeClient {
  const key = `${provider}::${apiKey ?? ""}::${baseURL ?? ""}`;
  if (_cleanupClient && _lastClientKey === key) return _cleanupClient;

  if (!_OpenAI) {
    throw new Error("OpenAI SDK not loaded");
  }

  const opts: ConstructorParameters<OpenAIConstructor>[0] = {
    apiKey: apiKey || "not-needed",
  };
  if (baseURL) opts.baseURL = baseURL;
  _cleanupClient = new _OpenAI(opts);
  _lastClientKey = key;
  return _cleanupClient;
}

export async function cleanupText(rawText: string): Promise<string> {
  const cfg = configStore.get();
  const cleanup = cfg.cleanup;
  if (!cleanup?.enabled) return rawText;

  // Lazy-load OpenAI SDK
  if (!_OpenAI) {
    try {
      _OpenAI = await loadOpenAIConstructor();
    } catch {
      throw new Error(
        "AI text cleanup requires the 'openai' package. Install it with: pnpm add openai"
      );
    }
  }

  const client = getClient(
    cleanup.provider ?? "openai",
    cleanup.apiKey,
    cleanup.baseURL
  );

  const response = await client.chat.completions.create({
    model: cleanup.model ?? "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: rawText },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  });

  const cleaned = response.choices?.[0]?.message?.content?.trim();
  if (!cleaned) return rawText;
  return cleaned;
}
