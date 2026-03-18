import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { VOICE_DIR } from "../../../../packages/paths.js";

const _dataDir = VOICE_DIR;
function configFile(): string { return join(_dataDir, "config.json"); }

export interface PerProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface CleanupConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export interface TtsConfig {
  enabled: boolean;
  voice?: string;
  edgeRate?: string;
  edgePitch?: string;
  fallbackRate?: number;
  volume?: number;
  /** Texts longer than this (chars) are split into rolling chunks. Default 100. */
  chunkThreshold?: number;
}

export interface PersistentConfig {
  provider: string;
  language: string;
  providers: Record<string, PerProviderConfig>;
  vocabBiasing?: boolean;
  customVocabulary?: string[];
  cleanup?: CleanupConfig;
  tts?: TtsConfig;
}

function loadFile(): Partial<PersistentConfig> {
  const file = configFile();
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      try {
        return JSON.parse(raw) as Partial<PersistentConfig>;
      } catch (parseErr) {
        console.error(`[voice] corrupt config file at ${file} — ignoring and using defaults. Parse error:`, parseErr);
        return {};
      }
    }
  } catch (e) {
    console.error(`[voice] failed to read config file at ${file}:`, e);
  }
  return {};
}

function saveFile(config: PersistentConfig): void {
  mkdirSync(_dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function fromEnv(): PersistentConfig {
  return {
    provider: process.env.VOICE_PROVIDER || "openai",
    language: process.env.WHISPER_LANGUAGE || "auto",
    providers: {
      local: {
        model: process.env.LOCAL_WHISPER_MODEL || "base",
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.WHISPER_MODEL || "whisper-1",
      },
      groq: {
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
        model: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",
      },
      "whisper-cpp": {
        baseURL: process.env.WHISPER_CPP_URL || "http://localhost:8080",
        model: process.env.WHISPER_CPP_MODEL || "default",
      },
      "faster-whisper": {
        baseURL: process.env.FASTER_WHISPER_URL || "http://localhost:8000/v1",
        model: process.env.FASTER_WHISPER_MODEL || "default",
      },
      vllm: {
        baseURL: process.env.VLLM_URL || "http://localhost:8000/v1",
        model: process.env.VLLM_WHISPER_MODEL || "default",
      },
      "local-ai": {
        baseURL: process.env.LOCAL_AI_URL || "http://localhost:8080",
        model: process.env.LOCAL_AI_WHISPER_MODEL || "whisper-1",
      },
    },
    vocabBiasing: false,
    customVocabulary: [],
    cleanup: { enabled: false },
    tts: { enabled: true, voice: "en-GB-RyanNeural", edgeRate: "+5%", edgePitch: "-2Hz", fallbackRate: 200, volume: 80 },
  };
}

class ConfigStore {
  private static _instance: ConfigStore;
  private config: PersistentConfig;

  private constructor() {
    this.config = fromEnv(); // initial default, immediately overwritten by reload()
    this.reload();
  }

  static getInstance(): ConfigStore {
    if (!ConfigStore._instance) {
      ConfigStore._instance = new ConfigStore();
    }
    return ConfigStore._instance;
  }

  get(): PersistentConfig {
    // Re-read file on every get() so external edits (e.g. direct file changes)
    // are picked up without restarting the process.
    this.reload();
    return structuredClone(this.config);
  }

  private reload(): void {
    const env = fromEnv();
    const file = loadFile();
    this.config = {
      provider: file.provider ?? env.provider,
      language: file.language ?? env.language,
      providers: {},
      vocabBiasing: file.vocabBiasing ?? env.vocabBiasing,
      customVocabulary: file.customVocabulary ?? env.customVocabulary,
      cleanup: file.cleanup ?? env.cleanup,
      tts: file.tts ?? env.tts,
    };
    for (const key of Object.keys(env.providers)) {
      this.config.providers[key] = {
        ...env.providers[key],
        ...(file.providers?.[key] ?? {}),
      };
    }
    if (file.providers) {
      for (const key of Object.keys(file.providers)) {
        if (!this.config.providers[key]) {
          this.config.providers[key] = file.providers[key];
        }
      }
    }
  }

  update(patch: {
    provider?: string;
    language?: string;
    providerName?: string;
    providerSettings?: PerProviderConfig;
    vocabBiasing?: boolean;
    customVocabulary?: string[];
    cleanup?: Partial<CleanupConfig>;
    tts?: Partial<TtsConfig>;
  }): void {
    if (patch.provider != null) this.config.provider = patch.provider;
    if (patch.language != null) this.config.language = patch.language;
    if (patch.providerName && patch.providerSettings) {
      this.config.providers[patch.providerName] = {
        ...this.config.providers[patch.providerName],
        ...patch.providerSettings,
      };
    }
    if (patch.vocabBiasing != null) this.config.vocabBiasing = patch.vocabBiasing;
    if (patch.customVocabulary != null) this.config.customVocabulary = patch.customVocabulary;
    if (patch.cleanup) {
      this.config.cleanup = { ...this.config.cleanup, ...patch.cleanup } as CleanupConfig;
    }
    if (patch.tts) {
      this.config.tts = { ...this.config.tts, ...patch.tts } as TtsConfig;
    }
    saveFile(this.config);
  }

  getProviderSettings(name: string): PerProviderConfig {
    return this.config.providers[name] ?? {};
  }
}

export const configStore = ConfigStore.getInstance();
