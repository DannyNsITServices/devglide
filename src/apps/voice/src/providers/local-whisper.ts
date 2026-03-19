import { writeFileSync, unlinkSync, mkdirSync, existsSync, createWriteStream } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import { createRequire } from "module";
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

const BUILD_TOOLS_HINT =
  "The local whisper provider uses nodejs-whisper which needs whisper.cpp.\n" +
  "Prebuilt binary download was attempted but failed.\n" +
  "\n" +
  "To compile manually:\n" +
  "\n" +
  "Step 1 — Install build tools (if not already installed):\n" +
  "  Windows:  winget install Kitware.CMake\n" +
  "            winget install Microsoft.VisualStudio.2022.BuildTools --override \"--add Microsoft.VisualStudio.Workload.VCTools\"\n" +
  "  macOS:    xcode-select --install\n" +
  "  Linux:    sudo apt install build-essential cmake\n" +
  "\n" +
  "Step 2 — Compile whisper.cpp (from project root):\n" +
  "  cd node_modules/nodejs-whisper/cpp/whisper.cpp\n" +
  "  cmake -B build\n" +
  "  cmake --build build --config Release\n" +
  "\n" +
  "Then restart the server.";

// --- Prebuilt whisper.cpp binary download ---

const WHISPER_CPP_RELEASE_VERSION = "v1.8.3";
const WHISPER_CPP_RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE_VERSION}`;

/** Maps platform+arch to the release asset name and executable path inside the archive. */
function getPrebuiltAsset(): { url: string; exeName: string; archiveFiles: string[] } | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") {
    return {
      url: `${WHISPER_CPP_RELEASE_BASE}/whisper-bin-x64.zip`,
      exeName: "whisper-cli.exe",
      archiveFiles: [
        "Release/whisper-cli.exe",
        "Release/whisper.dll",
        "Release/ggml.dll",
        "Release/ggml-base.dll",
        "Release/ggml-cpu.dll",
      ],
    };
  }
  if (platform === "win32" && arch === "ia32") {
    return {
      url: `${WHISPER_CPP_RELEASE_BASE}/whisper-bin-Win32.zip`,
      exeName: "whisper-cli.exe",
      archiveFiles: [
        "Release/whisper-cli.exe",
        "Release/whisper.dll",
        "Release/ggml.dll",
        "Release/ggml-base.dll",
        "Release/ggml-cpu.dll",
      ],
    };
  }
  // macOS and Linux do not ship prebuilt binaries on the whisper.cpp releases page
  return null;
}

/** Resolve the whisper.cpp directory inside the nodejs-whisper package. */
function getWhisperCppPath(): string {
  const require_ = createRequire(import.meta.url);
  const nodejsWhisperDir = dirname(require_.resolve("nodejs-whisper/package.json"));
  return join(nodejsWhisperDir, "cpp", "whisper.cpp");
}

/** Check if the whisper-cli executable already exists in any of the expected locations. */
function whisperCliExists(whisperCppPath: string): boolean {
  const exeName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const candidates = [
    join(whisperCppPath, "build", "bin", exeName),
    join(whisperCppPath, "build", "bin", "Release", exeName),
    join(whisperCppPath, "build", "bin", "Debug", exeName),
    join(whisperCppPath, "build", exeName),
    join(whisperCppPath, exeName),
  ];
  return candidates.some((p) => existsSync(p));
}

/** Download a file from `url` to `dest`. Uses `fetch` (Node 18+). */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} — ${url}`);
  }

  // Stream the response body into the file
  const fileStream = createWriteStream(dest);
  const reader = (res.body as any).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
    }
  } finally {
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
  }
}

/** Extract specific files from a zip archive using the `tar` command (available on Windows 10+). */
function extractZip(zipPath: string, destDir: string, files: string[]): void {
  // Windows 10+ ships bsdtar which handles zip files
  mkdirSync(destDir, { recursive: true });
  execSync(`tar -xf "${zipPath}" -C "${destDir}" ${files.map((f) => `"${f}"`).join(" ")}`, {
    stdio: "pipe",
    timeout: 30_000,
  });
}

/** Attempt to build whisper.cpp from source using CMake. */
function buildFromSource(whisperCppPath: string): boolean {
  try {
    console.log("[devglide-voice] Building whisper.cpp from source…");

    const cmakeCache = join(whisperCppPath, "build", "CMakeCache.txt");
    if (!existsSync(cmakeCache)) {
      console.log("[devglide-voice] Configuring CMake build…");
      execSync("cmake -B build", { cwd: whisperCppPath, stdio: "pipe", timeout: 60_000 });
    }

    console.log("[devglide-voice] Compiling (this may take a few minutes)…");
    execSync("cmake --build build --config Release", {
      cwd: whisperCppPath,
      stdio: "pipe",
      timeout: 300_000,
    });

    if (whisperCliExists(whisperCppPath)) {
      console.log("[devglide-voice] whisper.cpp built successfully.");
      return true;
    }

    console.warn("[devglide-voice] Build completed but whisper-cli not found.");
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[devglide-voice] CMake build failed: ${msg}`);
    return false;
  }
}

/**
 * Ensure the whisper-cli binary is available.
 * 1. If already present → no-op.
 * 2. On Windows → try downloading prebuilt binaries from GitHub releases.
 * 3. Fall back to building from source via CMake (macOS/Linux have compilers
 *    readily available; Windows will reach this if the prebuilt download fails).
 */
async function ensureWhisperBinary(): Promise<boolean> {
  const whisperCppPath = getWhisperCppPath();

  // Already available — nothing to do
  if (whisperCliExists(whisperCppPath)) return true;

  // Step 1: Try prebuilt binary (Windows only — no official macOS/Linux binaries)
  const asset = getPrebuiltAsset();
  if (asset) {
    console.log(`[devglide-voice] whisper-cli not found — downloading prebuilt binary (${WHISPER_CPP_RELEASE_VERSION})…`);

    const tmpZip = join(tmpdir(), `whisper-prebuilt-${randomBytes(4).toString("hex")}.zip`);

    try {
      await downloadFile(asset.url, tmpZip);

      const extractDir = join(tmpdir(), `whisper-extract-${randomBytes(4).toString("hex")}`);
      extractZip(tmpZip, extractDir, asset.archiveFiles);

      const targetDir = join(whisperCppPath, "build", "bin", "Release");
      mkdirSync(targetDir, { recursive: true });

      for (const file of asset.archiveFiles) {
        const src = join(extractDir, file);
        const dest = join(targetDir, file.split("/").pop()!);
        if (existsSync(src)) {
          const { copyFileSync } = await import("fs");
          copyFileSync(src, dest);
        }
      }

      if (whisperCliExists(whisperCppPath)) {
        console.log("[devglide-voice] Prebuilt whisper-cli installed successfully.");
        return true;
      }

      console.warn("[devglide-voice] Prebuilt binary extracted but not found — falling back to CMake build.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[devglide-voice] Failed to download prebuilt binary: ${msg}`);
      console.warn("[devglide-voice] Falling back to CMake build…");
    } finally {
      try { unlinkSync(tmpZip); } catch { /* ignore */ }
    }
  }

  // Step 2: Build from source via CMake
  return buildFromSource(whisperCppPath);
}

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

    // Ensure whisper-cli binary is available (download prebuilt if possible)
    await ensureWhisperBinary();

    // Write audio buffer to a temp file (nodejs-whisper needs a file path)
    const tmpDir = join(tmpdir(), "devglide-voice");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, `${randomBytes(8).toString("hex")}-${audio.name}`);

    try {
      const buffer = Buffer.from(await audio.arrayBuffer());
      writeFileSync(tmpFile, buffer);

      const startTime = Date.now();

      let result;
      try {
        result = await nodeWhisper(tmpFile, {
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Detect whisper binary / build tool issues and provide actionable guidance
        if (/whisper.*not found|executable not found|ENOENT|cmake|build|compile/i.test(msg)) {
          throw new Error(
            `Local whisper transcription failed: ${msg}\n\n${BUILD_TOOLS_HINT}`
          );
        }
        throw err;
      }

      const durationSec = (Date.now() - startTime) / 1000;

      // nodejs-whisper returns an array of segments with speech property
      // Segments may contain timestamp prefixes like [00:00:00.000 --> 00:00:02.000]
      const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g;

      let text: string;
      if (Array.isArray(result)) {
        text = result
          .map((segment: any) => {
            const raw = (segment.speech ?? segment.text ?? "").trim();
            return raw.replace(TIMESTAMP_RE, "").replace(/\s+/g, " ").trim();
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
