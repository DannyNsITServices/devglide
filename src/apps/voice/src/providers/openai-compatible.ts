import type {
  TranscriptionProvider,
  ProviderConfig,
  TranscribeOptions,
  TranscriptionResult,
} from "./types.js";
import type OpenAI from "openai";

// Cached OpenAI constructor and client instances keyed by config signature
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
const _clientCache = new Map<string, OpenAILikeClient>();
const CLIENT_CACHE_MAX = 8;

function getClientCacheKey(apiKey: string, baseURL?: string): string {
  return `${apiKey}::${baseURL || ""}`;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (value != null && typeof value === "object" && key in value) {
    const field = Reflect.get(value, key);
    return typeof field === "string" ? field : undefined;
  }
  return undefined;
}

function readOptionalNumber(value: unknown, key: string): number | undefined {
  if (value != null && typeof value === "object" && key in value) {
    const field = Reflect.get(value, key);
    return typeof field === "number" ? field : undefined;
  }
  return undefined;
}

export class OpenAICompatibleProvider implements TranscriptionProvider {
  readonly name: string;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.displayName = config.displayName;
    this.requiresApiKey = config.requiresApiKey;
  }

  async transcribe(
    audio: File,
    options: TranscribeOptions = {}
  ): Promise<TranscriptionResult> {
    if (!_OpenAI) {
      try {
        _OpenAI = await loadOpenAIConstructor();
      } catch {
        throw new Error(
          "@devglide/voice server transcription requires the 'openai' package. Install it with: pnpm add openai"
        );
      }
    }

    const apiKey = this.config.apiKey || "not-needed";
    const cacheKey = getClientCacheKey(apiKey, this.config.baseURL);
    let client = _clientCache.get(cacheKey);
    if (!client) {
      const clientOptions: ConstructorParameters<OpenAIConstructor>[0] = { apiKey };
      if (this.config.baseURL) {
        clientOptions.baseURL = this.config.baseURL;
      }
      client = new _OpenAI!(clientOptions);
      if (_clientCache.size >= CLIENT_CACHE_MAX) {
        const oldestKey = _clientCache.keys().next().value!;
        _clientCache.delete(oldestKey);
      }
      _clientCache.set(cacheKey, client);
    }

    let response;
    try {
      response = await client.audio.transcriptions.create({
        file: audio,
        model: this.config.model,
        language: options.language,
        response_format: options.responseFormat || "verbose_json",
        ...(options.prompt ? { prompt: options.prompt } : {}),
      });
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) {
        throw new Error(
          `Model "${this.config.model}" not found on ${this.displayName} (${this.config.baseURL || "api.openai.com"}). Check available models or update the voice config.`
        );
      }
      throw err;
    }

    if (typeof response === "string") {
      return { text: response };
    }

    return {
      text: response.text,
      language: readOptionalString(response, "language"),
      duration: readOptionalNumber(response, "duration"),
    };
  }

  isConfigured(): boolean {
    if (this.requiresApiKey) {
      return !!this.config.apiKey;
    }
    return !!this.config.baseURL;
  }
}
