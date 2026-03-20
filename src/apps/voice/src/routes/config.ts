import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import {
  getProvider,
  getProviderConfig,
  invalidateProvider,
  PROVIDER_META,
} from "../providers/index.js";
import { configStore } from "../services/config-store.js";
import type { CleanupConfig, TtsConfig } from "../services/config-store.js";
import { stats } from "../services/stats.js";
import { handleTranscribe } from "./transcribe.js";
import { checkFfmpeg } from "../providers/local-whisper.js";
import { speak, stop as ttsStop, listVoices } from "../services/tts.js";

export const configRouter: RouterType = Router();

const cleanupConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
});

const ttsConfigSchema = z.object({
  enabled: z.boolean(),
  voice: z.string().optional(),
  edgeRate: z.string().optional(),
  edgePitch: z.string().optional(),
  fallbackRate: z.number().optional(),
  volume: z.number().optional(),
  chunkThreshold: z.number().optional(),
});

const updateConfigSchema = z.object({
  provider: z.string().optional(),
  language: z.string().optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
  vocabBiasing: z.boolean().optional(),
  customVocabulary: z.array(z.string()).optional(),
  cleanup: cleanupConfigSchema.optional(),
  tts: ttsConfigSchema.optional(),
});

const speakBodySchema = z.object({
  text: z.string().min(1),
});

configRouter.get("/", (_req, res) => {
  const cfg = configStore.get();
  const pc = getProviderConfig();
  const settings = configStore.getProviderSettings(cfg.provider);
  res.json({
    provider: pc.name,
    displayName: pc.displayName,
    model: pc.model,
    baseURL: pc.baseURL ?? null,
    language: cfg.language,
    configured: pc.requiresApiKey ? !!pc.apiKey : !!pc.baseURL,
    requiresApiKey: pc.requiresApiKey,
    apiKeyMasked: settings.apiKey ? `...${settings.apiKey.slice(-4)}` : null,
  });
});

configRouter.get("/providers", (_req, res) => {
  const cfg = configStore.get();
  const providers = Object.entries(PROVIDER_META).map(([id, meta]) => {
    const settings = configStore.getProviderSettings(id);
    return {
      id,
      displayName: meta.displayName,
      requiresApiKey: meta.requiresApiKey,
      defaultBaseURL: meta.defaultBaseURL ?? null,
      defaultModel: meta.defaultModel,
      models: meta.models ?? null,
      currentApiKeyMasked: settings.apiKey ? `...${settings.apiKey.slice(-4)}` : null,
      currentBaseURL: settings.baseURL ?? null,
      currentModel: settings.model ?? null,
    };
  });
  res.json({
    current: cfg.provider,
    language: cfg.language,
    providers,
    vocabBiasing: cfg.vocabBiasing ?? false,
    customVocabulary: cfg.customVocabulary ?? [],
    cleanup: cfg.cleanup ?? { enabled: false },
    tts: cfg.tts ?? { enabled: true },
  });
});

configRouter.put("/", (req, res) => {
  const parsed = updateConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid config payload" });
    return;
  }

  const { provider, language, apiKey, baseURL, model, vocabBiasing, customVocabulary, cleanup, tts } = parsed.data;

  if (provider && !PROVIDER_META[provider]) {
    res.status(400).json({ error: `Unknown provider "${provider}"` });
    return;
  }

  // Validate language (BCP 47 pattern or "auto")
  if (language !== undefined) {
    if (language !== "auto" && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(language)) {
      res.status(400).json({ error: `Invalid language value "${language}". Use BCP 47 code (e.g. "en", "en-US") or "auto".` });
      return;
    }
  }

  // Validate model is non-empty if provided
  if (model !== undefined && typeof model === "string" && model.trim() === "") {
    res.status(400).json({ error: "Model must be a non-empty string if provided." });
    return;
  }

  const targetProvider = provider ?? configStore.get().provider;
  const patch: Parameters<typeof configStore.update>[0] = {};

  if (provider) patch.provider = provider;
  if (language) patch.language = language;

  if (apiKey !== undefined || baseURL !== undefined || model !== undefined) {
    const settings: Record<string, string | undefined> = {};
    if (apiKey !== undefined) settings.apiKey = apiKey || undefined;
    if (baseURL !== undefined) settings.baseURL = baseURL || undefined;
    if (model !== undefined) settings.model = model || undefined;
    patch.providerName = targetProvider;
    patch.providerSettings = settings;
  }

  if (vocabBiasing !== undefined) patch.vocabBiasing = !!vocabBiasing;
  if (Array.isArray(customVocabulary)) patch.customVocabulary = customVocabulary.map(String);
  if (cleanup) patch.cleanup = cleanup as Partial<CleanupConfig>;
  if (tts) patch.tts = tts as Partial<TtsConfig>;

  configStore.update(patch);
  invalidateProvider();

  const updated = getProviderConfig();
  res.json({ ok: true, provider: updated.name, model: updated.model, baseURL: updated.baseURL ?? null });
});

configRouter.post("/test", (_req, res) => {
  try {
    const provider = getProvider();
    if (!provider.isConfigured()) {
      res.json({ ok: false, reason: "Provider is not configured (missing API key or base URL)" });
      return;
    }
    res.json({ ok: true, provider: provider.name, displayName: provider.displayName });
  } catch (err) {
    res.json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
});

configRouter.get("/check-ffmpeg", (_req, res) => {
  res.json(checkFfmpeg());
});

// ── TTS endpoints ────────────────────────────────────────────────────

configRouter.post("/tts/speak", (req, res) => {
  const parsed = speakBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "text is required" });
    return;
  }
  const { text } = parsed.data;
  // Respond immediately — speak() is fire-and-forget and never throws
  res.json({ ok: true, chars: text.length });
  speak(text);
});

configRouter.post("/tts/stop", (_req, res) => {
  ttsStop();
  res.json({ ok: true });
});

configRouter.get("/tts/voices", async (_req, res) => {
  const voices = await listVoices();
  res.json({ voices });
});

configRouter.delete("/stats", (_req, res) => {
  stats.reset();
  res.json({ ok: true });
});

// Alias for backwards compatibility — delegates to the canonical /api/transcribe handler
configRouter.post("/test-transcription", handleTranscribe);

configRouter.get("/stats", (_req, res) => {
  res.json(stats.getStats());
});
