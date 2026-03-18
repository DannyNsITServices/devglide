import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import type {
  TranscriptionProvider,
  TranscribeOptions,
  TranscriptionResult,
} from "./types.js";

const FFMPEG_INSTALL_HINT =
  "Install FFmpeg:\n" +
  "  Windows:  winget install ffmpeg  (or choco install ffmpeg)\n" +
  "  macOS:    brew install ffmpeg\n" +
  "  Linux:    sudo apt install ffmpeg  (or your distro's package manager)";

/** Check whether ffmpeg is available on PATH. */
export function checkFfmpeg(): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execSync("ffmpeg -version", {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).toString();
    const match = out.match(/ffmpeg version (\S+)/);
    return { ok: true, version: match?.[1] ?? "unknown" };
  } catch {
    return { ok: false, error: `FFmpeg not found on PATH. ${FFMPEG_INSTALL_HINT}` };
  }
}

export class LocalWhisperProvider implements TranscriptionProvider {
  readonly name = "local";
  readonly displayName = "Local (whisper.cpp)";
  readonly requiresApiKey = false;

  private model: string;

  constructor(model: string = "base") {
    this.model = model;
  }

  async transcribe(
    audio: File,
    options: TranscribeOptions = {}
  ): Promise<TranscriptionResult> {
    let nodeWhisper: typeof import("nodejs-whisper")["nodewhisper"];
    try {
      nodeWhisper = (await import("nodejs-whisper")).nodewhisper;
    } catch {
      throw new Error(
        "Local whisper provider requires the 'nodejs-whisper' package. Install it with: pnpm add nodejs-whisper"
      );
    }

    // Verify FFmpeg is available before attempting transcription
    const ffmpeg = checkFfmpeg();
    if (!ffmpeg.ok) {
      throw new Error(ffmpeg.error!);
    }

    // Write audio buffer to a temp file (nodejs-whisper needs a file path)
    const tmpDir = join(tmpdir(), "devglide-voice");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, `${randomBytes(8).toString("hex")}-${audio.name}`);

    try {
      const buffer = Buffer.from(await audio.arrayBuffer());
      writeFileSync(tmpFile, buffer);

      const startTime = Date.now();

      const result = await nodeWhisper(tmpFile, {
        modelName: this.model as any,
        autoDownloadModelName: this.model as any,
        removeWavFileAfterTranscription: true,
        whisperOptions: {
          outputInText: false,
          outputInVtt: false,
          outputInSrt: false,
          outputInCsv: false,
          translateToEnglish: false,
          wordTimestamps: false,
          timestamps_length: 60,
          splitOnWord: true,
          ...(options.language ? { language: options.language } : {}),
          ...(options.prompt ? { prompt: options.prompt } : {}),
        },
      });

      const durationSec = (Date.now() - startTime) / 1000;

      // nodejs-whisper returns an array of segments with speech property
      // Segments may contain timestamp prefixes like [00:00:00.000 --> 00:00:02.000]
      const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g;

      let text: string;
      if (Array.isArray(result)) {
        text = result
          .map((segment: any) => {
            const raw = (segment.speech ?? segment.text ?? "").trim();
            return raw.replace(TIMESTAMP_RE, "").trim();
          })
          .filter(Boolean)
          .join(" ");
      } else if (typeof result === "string") {
        text = result.replace(TIMESTAMP_RE, "").trim();
      } else {
        text = String(result).replace(TIMESTAMP_RE, "").trim();
      }

      return {
        text,
        language: options.language,
        duration: durationSec,
      };
    } finally {
      // Clean up temp file (best-effort)
      try {
        unlinkSync(tmpFile);
      } catch {
        // already removed by nodejs-whisper or doesn't exist
      }
    }
  }

  isConfigured(): boolean {
    // Local provider is always "configured" — no API key or server needed
    return true;
  }
}
