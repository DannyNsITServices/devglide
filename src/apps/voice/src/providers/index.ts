import type { ProviderConfig, TranscriptionProvider } from "./types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { LocalWhisperProvider } from "./local-whisper.js";
import { configStore } from "../services/config-store.js";

export type { TranscriptionProvider, ProviderConfig };

interface ProviderMeta {
  displayName: string;
  requiresApiKey: boolean;
  defaultBaseURL?: string;
  defaultModel: string;
  models?: string[];
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  local: {
    displayName: "Local (whisper.cpp)",
    requiresApiKey: false,
    defaultModel: "base",
    models: [
      "tiny", "tiny.en", "base", "base.en",
      "small", "small.en", "medium", "medium.en",
      "large-v3-turbo",
    ],
  },
  openai: {
    displayName: "OpenAI Whisper",
    requiresApiKey: true,
    defaultModel: "whisper-1",
  },
  groq: {
    displayName: "Groq",
    requiresApiKey: true,
    defaultBaseURL: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
  },
  "whisper-cpp": {
    displayName: "whisper.cpp",
    requiresApiKey: false,
    defaultBaseURL: "http://localhost:8080",
    defaultModel: "default",
  },
  "faster-whisper": {
    displayName: "Faster Whisper",
    requiresApiKey: false,
    defaultBaseURL: "http://localhost:8000/v1",
    defaultModel: "Systran/faster-whisper-small",
  },
  vllm: {
    displayName: "vLLM",
    requiresApiKey: false,
    defaultBaseURL: "http://localhost:8000/v1",
    defaultModel: "default",
  },
  "local-ai": {
    displayName: "LocalAI",
    requiresApiKey: false,
    defaultBaseURL: "http://localhost:8080",
    defaultModel: "whisper-1",
  },
};

let cachedProvider: TranscriptionProvider | null = null;
let cachedSignature: string | null = null;

export function invalidateProvider(): void {
  cachedProvider = null;
  cachedSignature = null;
}

/** Cheap signature of the settings that affect provider construction. */
function providerSignature(name: string): string {
  const settings = configStore.getProviderSettings(name);
  return JSON.stringify([
    name,
    settings.apiKey ?? "",
    settings.baseURL ?? "",
    settings.model ?? "",
  ]);
}

function buildConfig(providerName: string): ProviderConfig {
  const meta = PROVIDER_META[providerName];
  if (!meta) {
    throw new Error(
      `Unknown provider "${providerName}". Supported: ${Object.keys(PROVIDER_META).join(", ")}`
    );
  }
  const settings = configStore.getProviderSettings(providerName);
  return {
    name: providerName,
    displayName: meta.displayName,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL ?? meta.defaultBaseURL,
    model: settings.model || meta.defaultModel,
    requiresApiKey: meta.requiresApiKey,
  };
}

export interface ProviderOverrides {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/**
 * Build a fresh provider instance for `name`, with optional setting overrides
 * on top of the saved configuration (used by the config test endpoint).
 */
export function createProvider(
  name: string,
  overrides: ProviderOverrides = {}
): TranscriptionProvider {
  if (name === "local") {
    const settings = configStore.getProviderSettings("local");
    return new LocalWhisperProvider(
      overrides.model || settings.model || PROVIDER_META.local.defaultModel
    );
  }
  const config = buildConfig(name);
  return new OpenAICompatibleProvider({
    ...config,
    apiKey: overrides.apiKey ?? config.apiKey,
    baseURL: overrides.baseURL ?? config.baseURL,
    model: overrides.model || config.model,
  });
}

export function getProvider(): TranscriptionProvider {
  // configStore.get() re-reads config.json, so config changes made by another
  // process (e.g. the dashboard while this is a stdio MCP process) are
  // detected via the signature and rebuild the cached provider.
  const name = configStore.get().provider;
  const signature = providerSignature(name);
  if (cachedProvider && signature === cachedSignature) return cachedProvider;
  cachedProvider = createProvider(name);
  cachedSignature = signature;
  return cachedProvider;
}

export function getProviderConfig(): ProviderConfig {
  return buildConfig(configStore.get().provider);
}
