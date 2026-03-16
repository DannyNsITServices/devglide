import { z } from "zod";
import { createDevglideMcpServer } from "../../../packages/mcp-utils/src/index.js";
import { transcribe } from "./transcribe.js";
import { stats } from "./services/stats.js";
import { mimeFromFilename } from "./utils/mime.js";
import { configStore } from "./services/config-store.js";

export function createVoiceMcpServer() {
  const server = createDevglideMcpServer("devglide-voice", "0.1.0");

  server.tool(
    "voice_transcribe",
    "Transcribe audio using the configured speech-to-text provider. Accepts base64-encoded audio data.",
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
    },
    async ({ audioBase64, filename, language }) => {
      const startTime = Date.now();
      try {
        const name = filename || "audio.webm";
        const buffer = Buffer.from(audioBase64, "base64");
        const file = new File([buffer], name, {
          type: mimeFromFilename(name),
        });

        const cfg = configStore.get();
        const lang = language ?? (cfg.language !== "auto" ? cfg.language : undefined);
        const result = await transcribe(file, { language: lang });
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

  return server;
}
