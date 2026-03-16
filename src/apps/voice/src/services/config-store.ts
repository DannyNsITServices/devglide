import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { VOICE_DIR } from "../../../../packages/paths.js";

const DATA_DIR = VOICE_DIR;
const CONFIG_FILE = join(DATA_DIR, "config.json");

export interface PerProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface PersistentConfig {
  provider: string;
  language: string;
  providers: Record<string, PerProviderConfig>;
}

function loadFile(): Partial<PersistentConfig> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      try {
        return JSON.parse(raw) as Partial<PersistentConfig>;
      } catch (parseErr) {
        console.error(`[voice] corrupt config file at ${CONFIG_FILE} — ignoring and using defaults. Parse error:`, parseErr);
        return {};
      }
    }
  } catch (e) {
    console.error(`[voice] failed to read config file at ${CONFIG_FILE}:`, e);
  }
  return {};
}

function saveFile(config: PersistentConfig): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function fromEnv(): PersistentConfig {
  return {
    provider: process.env.VOICE_PROVIDER || "openai",
    language: process.env.WHISPER_LANGUAGE || "auto",
    providers: {
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
  };
}

class ConfigStore {
  private static _instance: ConfigStore;
  private config: PersistentConfig;

  private constructor() {
    const env = fromEnv();
    const file = loadFile();
    this.config = {
      provider: file.provider ?? env.provider,
      language: file.language ?? env.language,
      providers: {},
    };
    for (const key of Object.keys(env.providers)) {
      this.config.providers[key] = {
        ...env.providers[key],
        ...(file.providers?.[key] ?? {}),
      };
    }
  }

  static getInstance(): ConfigStore {
    if (!ConfigStore._instance) {
      ConfigStore._instance = new ConfigStore();
    }
    return ConfigStore._instance;
  }

  get(): PersistentConfig {
    return structuredClone(this.config);
  }

  update(patch: {
    provider?: string;
    language?: string;
    providerName?: string;
    providerSettings?: PerProviderConfig;
  }): void {
    if (patch.provider != null) this.config.provider = patch.provider;
    if (patch.language != null) this.config.language = patch.language;
    if (patch.providerName && patch.providerSettings) {
      this.config.providers[patch.providerName] = {
        ...this.config.providers[patch.providerName],
        ...patch.providerSettings,
      };
    }
    saveFile(this.config);
  }

  getProviderSettings(name: string): PerProviderConfig {
    return this.config.providers[name] ?? {};
  }
}

export const configStore = ConfigStore.getInstance();
