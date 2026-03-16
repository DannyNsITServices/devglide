import type { ProviderConfig, TranscriptionProvider } from "./types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { configStore } from "../services/config-store.js";

export type { TranscriptionProvider, ProviderConfig };

interface ProviderMeta {
  displayName: string;
  requiresApiKey: boolean;
  defaultBaseURL?: string;
  defaultModel: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
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

export function invalidateProvider(): void {
  cachedProvider = null;
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

export function getProvider(): TranscriptionProvider {
  if (cachedProvider) return cachedProvider;
  const name = configStore.get().provider;
  cachedProvider = new OpenAICompatibleProvider(buildConfig(name));
  return cachedProvider;
}

export function getProviderConfig(): ProviderConfig {
  return buildConfig(configStore.get().provider);
}
