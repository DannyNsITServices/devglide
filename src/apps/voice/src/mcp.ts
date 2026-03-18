import { z } from "zod";
import { createDevglideMcpServer } from "../../../packages/mcp-utils/src/index.js";
import { transcribe } from "./transcribe.js";
import { stats } from "./services/stats.js";
import { historyStore } from "./services/history-store.js";
import { mimeFromFilename } from "./utils/mime.js";
import { configStore } from "./services/config-store.js";
import { speak, stop as ttsStop } from "./services/tts.js";

export function createVoiceMcpServer() {
  const server = createDevglideMcpServer(
    "devglide-voice",
    "0.1.0",
    "Speech-to-text transcription and text-to-speech synthesis",
    {
      instructions: [
        "## Voice — Usage Conventions",
        "",
        "### Speech-to-text (STT)",
        "- Use `voice_transcribe` to convert audio to text. Accepts base64-encoded audio.",
        "- Supports vocabulary biasing via `prompt` parameter to improve accuracy for developer terminology.",
        "- Two modes: `raw` (default) returns transcription as-is, `cleanup` applies AI post-processing to remove filler words and fix grammar.",
        "- Provider is configurable (OpenAI, Groq, local whisper.cpp, and more).",
        "",
        "### Text-to-speech (TTS)",
        "- Use `voice_speak` to speak text aloud. Fire-and-forget — cancels any previous speech.",
        "- Use `voice_stop` to cancel current speech playback.",
        "- Uses JARVIS-style neural voice (en-GB-RyanNeural) by default. Configurable via dashboard.",
        "- Use TTS to give the user audible feedback when completing tasks or reporting results.",
        "",
        "### History and analytics",
        "- Every transcription is automatically recorded in history with text analysis (word count, WPM, filler words).",
        "- Use `voice_history` to list or search past transcriptions.",
        "- Use `voice_analytics` to get aggregated stats (average WPM, top filler words, totals).",
        "",
        "### Quick reference",
        "- `voice_transcribe(audioBase64, ...)` — `audioBase64` is required. Optional: `filename`, `language`, `prompt`, `mode`.",
        "- `voice_speak(text)` — `text` is the string to speak aloud.",
        "- `voice_history(limit?, offset?, search?)` — returns newest first. Use `search` to filter by text content.",
      ],
    }
  );

  server.tool(
    "voice_transcribe",
    "Transcribe audio using the configured speech-to-text provider. Accepts base64-encoded audio data. Supports vocabulary biasing and AI text cleanup.",
    {
      audioBase64: z.string().describe("Base64-encoded audio data"),
      filename: z
        .string()
        .optional()
        .describe("Original filename with extension (e.g. 'recording.webm')"),
      language: z
        .string()
        .optional()
        .describe("BCP 47 language hint (e.g. 'en')"),
      prompt: z
        .string()
        .optional()
        .describe("Custom prompt for vocabulary biasing (overrides built-in vocab)"),
      mode: z
        .enum(["raw", "cleanup"])
        .optional()
        .describe("Transcription mode: 'raw' returns as-is, 'cleanup' applies AI text cleanup"),
    },
    async ({ audioBase64, filename, language, prompt, mode }) => {
      const startTime = Date.now();
      try {
        const name = filename || "audio.webm";
        const buffer = Buffer.from(audioBase64, "base64");
        const file = new File([buffer], name, {
          type: mimeFromFilename(name),
        });

        const cfg = configStore.get();
        const lang = language ?? (cfg.language !== "auto" ? cfg.language : undefined);
        const result = await transcribe(file, {
          language: lang,
          ...(prompt ? { prompt } : {}),
          mode: mode ?? "raw",
        });
        const durationSec = (Date.now() - startTime) / 1000;
        stats.recordSuccess(result.duration ?? durationSec);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        stats.recordError();
        throw error;
      }
    }
  );

  server.tool(
    "voice_status",
    "Check voice service status and transcription statistics",
    {},
    async () => {
      const voiceStats = stats.getStats();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(voiceStats, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "voice_history",
    "List transcription history with text analysis (WPM, filler words). Returns newest first.",
    {
      limit: z.number().optional().describe("Max entries to return (default 25, max 100)"),
      offset: z.number().optional().describe("Number of entries to skip"),
      search: z.string().optional().describe("Search query to filter transcriptions"),
    },
    async ({ limit, offset, search }) => {
      let result;
      if (search) {
        const entries = historyStore.search(search, limit ?? 25);
        result = { entries, total: entries.length };
      } else {
        result = historyStore.list(limit ?? 25, offset ?? 0);
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "voice_analytics",
    "Get transcription analytics: average WPM, top filler words, total stats.",
    {},
    async () => {
      const analytics = historyStore.getAnalytics();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(analytics, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "voice_speak",
    "Speak text aloud using text-to-speech (JARVIS-style neural voice). Use this to give the user audible feedback when you complete a task. Fire-and-forget — cancels any previous speech.",
    {
      text: z.string().describe("Text to speak aloud"),
    },
    async ({ text }) => {
      // Fire-and-forget — speak() never throws
      speak(text);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, chars: text.length }),
          },
        ],
      };
    }
  );

  server.tool(
    "voice_stop",
    "Stop any currently playing text-to-speech audio.",
    {},
    async () => {
      ttsStop();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ok: true }) },
        ],
      };
    }
  );

  return server;
}
