/**
 * Text-to-Speech service — neural TTS via msedge-tts (pure Node.js).
 * JARVIS-style: en-GB-RyanNeural, +5% rate, -2Hz pitch.
 *
 * IMPORTANT: This module must NEVER crash the process. All errors are
 * caught and logged to stderr. speak() never rejects.
 *
 * TTS chain:
 *   1. msedge-tts (Node.js, Microsoft Edge Read Aloud API)
 *   2. Platform fallback: powershell.exe SAPI (WSL/Windows), say (macOS), espeak-ng (Linux)
 *
 * Audio playback on WSL copies to Windows %TEMP% then plays via powershell.exe
 * since Linux audio binaries aren't typically available in WSL.
 */

import { unlinkSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { platform } from "os";
import { spawn, execSync, type ChildProcess } from "child_process";
import { configStore } from "./config-store.js";

let _activeProcess: ChildProcess | null = null;
let _tmpFile: string | null = null;
/** Temp files created during chunked playback. */
let _chunkFiles: string[] = [];
/** Stop flag — set to true to abort chunked playback between chunks. */
let _stopRequested = false;

/** Remove a file silently. */
function safeUnlink(path: string | null): void {
  if (!path) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Clean up all temp files from TTS (including chunk files). */
function cleanupTempFiles(): void {
  safeUnlink(_tmpFile);
  _tmpFile = null;
  for (const f of _chunkFiles) safeUnlink(f);
  _chunkFiles = [];
}

// Lazy-loaded msedge-tts
let _MsEdgeTTS: any = null;
let _OUTPUT_FORMAT: any = null;

// ── Process-level safety net ─────────────────────────────────────────────────
// Installed at module load time (not lazily) so the MCP process is protected
// from the very first tick.  msedge-tts fires WebSocket errors as unhandled
// rejections / uncaught exceptions that would otherwise crash the process and
// drop the MCP stdio connection.  We absorb ALL errors here instead of
// re-throwing, because a re-throw from uncaughtException kills the process
// immediately.

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Only log TTS-related errors to avoid noise
  if (/msedge|tts|websocket|speech\.platform|Unexpected server|ECONNRESET|ENOTFOUND|audio/i.test(msg)) {
    process.stderr.write(`[voice:tts] unhandled rejection: ${msg}\n`);
  }
  // Absorb all — never crash the MCP process
});

process.on("uncaughtException", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[voice:tts] uncaught exception: ${msg}\n`);
  // Absorb — do NOT re-throw.  Re-throwing from uncaughtException kills the
  // process, which drops the MCP stdio connection.  The MCP transport has its
  // own error handling; a stray WebSocket error should never take it down.
});

/** Detect WSL environment. */
function isWSL(): boolean {
  try {
    const version = readFileSync("/proc/version", "utf-8");
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

/** Detect Git Bash / MSYS2 / Cygwin on Windows. */
function isGitBash(): boolean {
  return platform() === "win32" && !!(process.env.MSYSTEM || process.env.MINGW_PREFIX || process.env.CYGPATH);
}

/** Check if a command exists on PATH. */
function commandExists(cmd: string): boolean {
  try {
    execSync(platform() === "win32" ? `where ${cmd}` : `which ${cmd}`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Check if WSLg PulseAudio server is alive (synchronous socket probe, 1s timeout). */
function isWslPulseAvailable(): boolean {
  const sock = "/mnt/wslg/PulseServer";
  if (!existsSync(sock)) return false;
  try {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const r = spawnSync("node", ["-e", [
      'const c=require("net").createConnection({path:process.argv[1]});',
      'c.on("connect",()=>{c.destroy();process.exit(0)});',
      'c.on("error",()=>process.exit(1));',
      'setTimeout(()=>process.exit(1),1000);',
    ].join(""), sock], { timeout: 2000, stdio: "pipe" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Convert a path to Windows format for PowerShell.
 * Handles: Git Bash POSIX paths (cygpath), WSL paths (wslpath), native Windows paths (passthrough).
 */
function toWindowsPath(filePath: string): string {
  // Already a Windows path
  if (/^[A-Z]:\\/i.test(filePath)) return filePath;

  // Git Bash / MSYS2: use cygpath
  if (isGitBash()) {
    try {
      return execSync(`cygpath -w "${filePath}"`).toString().trim();
    } catch { /* fall through */ }
  }

  // WSL: use wslpath
  if (isWSL()) {
    try {
      return execSync(`wslpath -w "${filePath}"`).toString().trim();
    } catch { /* fall through */ }
  }

  return filePath;
}

/** Attach error handler to a child process so it can't crash Node. */
function safeProc(proc: ChildProcess | null): ChildProcess | null {
  if (proc) {
    proc.on("error", (err) => {
      console.error("[voice:tts] child process error:", err.message);
      if (_activeProcess === proc) _activeProcess = null;
    });
  }
  return proc;
}

/** Stop any active TTS playback and clean up all temp files. */
export function stop(): void {
  _stopRequested = true;
  if (_activeProcess) {
    try {
      _activeProcess.kill();
    } catch {
      // already exited
    }
    _activeProcess = null;
  }
  cleanupTempFiles();
}

/**
 * Play an MP3 file in the background via the appropriate platform player.
 *
 * WSL: Uses ffplay/mpv with WSLg PulseAudio (PULSE_SERVER=/mnt/wslg/PulseServer).
 * Falls back to powershell.exe + WMPlayer if no Linux player is available.
 */
function playMp3(mp3Path: string): ChildProcess | null {
  const os = platform();
  const wsl = isWSL();

  try {
    if (wsl) {
      // WSL → prefer native Linux player via WSLg PulseAudio, but only if PulseAudio is alive.
      // SDL_AUDIODRIVER=pulse is required — without it ffplay/SDL defaults to ALSA which doesn't exist in WSL.
      const pulseAlive = isWslPulseAvailable();
      if (pulseAlive) {
        const pulseEnv = { ...process.env, PULSE_SERVER: "/mnt/wslg/PulseServer", SDL_AUDIODRIVER: "pulse" };
        if (commandExists("mpv")) {
          return safeProc(spawn("mpv", ["--no-video", "--ao=pulse", mp3Path], { stdio: "ignore", env: pulseEnv }));
        }
        if (commandExists("ffplay")) {
          return safeProc(spawn("ffplay", ["-nodisp", "-autoexit", mp3Path], { stdio: "ignore", env: pulseEnv }));
        }
      } else {
        console.error("[voice:tts] WSLg PulseAudio not available, falling back to powershell.exe");
      }
      // Fallback: powershell.exe + WPF MediaPlayer (more reliable than WMPlayer.OCX
      // which is broken on some Windows 11 builds — stuck in playState 9).
      const wslWinPath = execSync(`wslpath -w "${mp3Path}"`).toString().trim();
      const psCmd =
        `$dest = Join-Path $env:TEMP 'devglide-tts.mp3'; ` +
        `Copy-Item '${wslWinPath.replace(/'/g, "''")}' $dest -Force; ` +
        `Add-Type -AssemblyName PresentationCore; ` +
        `$p = New-Object System.Windows.Media.MediaPlayer; ` +
        `$p.Open([Uri]$dest); ` +
        `Start-Sleep -Milliseconds 500; ` +
        `$p.Play(); ` +
        `while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }; ` +
        `Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 200); ` +
        `$p.Close(); ` +
        `Remove-Item $dest -ErrorAction SilentlyContinue`;
      return safeProc(
        spawn("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: "ignore" })
      );
    } else if (os === "win32") {
      // Native Windows: prefer ffplay/mpv (reliable), fall back to WMPlayer.OCX
      const winPath = toWindowsPath(mp3Path);
      if (commandExists("ffplay")) {
        return safeProc(spawn("ffplay", ["-nodisp", "-autoexit", winPath], { stdio: "ignore", windowsHide: true }));
      }
      if (commandExists("mpv")) {
        return safeProc(spawn("mpv", ["--no-video", winPath], { stdio: "ignore", windowsHide: true }));
      }
      // Fallback: WPF MediaPlayer (more reliable than WMPlayer.OCX which is
      // broken on some Windows 11 builds — stuck in playState 9).
      const psCmd =
        `Add-Type -AssemblyName PresentationCore; ` +
        `$p = New-Object System.Windows.Media.MediaPlayer; ` +
        `$p.Open([Uri]'${winPath.replace(/'/g, "''")}'); ` +
        `Start-Sleep -Milliseconds 500; ` +
        `$p.Play(); ` +
        `while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }; ` +
        `Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 200); ` +
        `$p.Close()`;
      return safeProc(
        spawn("powershell", ["-NoProfile", "-Command", psCmd], {
          stdio: "ignore",
          windowsHide: true,
        })
      );
    } else if (os === "darwin") {
      return safeProc(spawn("afplay", [mp3Path], { stdio: "ignore" }));
    } else {
      // Linux (non-WSL): try mpv, then ffplay
      if (commandExists("mpv")) {
        return safeProc(spawn("mpv", ["--no-video", mp3Path], { stdio: "ignore" }));
      }
      if (commandExists("ffplay")) {
        return safeProc(spawn("ffplay", ["-nodisp", "-autoexit", mp3Path], { stdio: "ignore" }));
      }
      console.error("[voice:tts] no audio player found (mpv, ffplay)");
      return null;
    }
  } catch (err) {
    console.error("[voice:tts] playMp3 error:", err);
    return null;
  }
}

/**
 * Generate MP3 using msedge-tts (pure Node.js).
 * Returns the path to the generated MP3, or null on failure.
 */
async function generateEdgeTts(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
): Promise<string | null> {
  try {
    if (!_MsEdgeTTS) {
      const mod = await import("msedge-tts");
      _MsEdgeTTS = mod.MsEdgeTTS;
      _OUTPUT_FORMAT = mod.OUTPUT_FORMAT;
    }

    const tts = new _MsEdgeTTS();
    await tts.setMetadata(voice, _OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    // Always write to native temp — playMp3() handles Windows path conversion
    const outDir = tmpdir();

    // Race against a timeout — msedge-tts can hang on bad config.
    // Scale timeout with text length: 15s base + 1s per 40 chars (≈ per sentence).
    const timeoutMs = Math.max(15_000, 15_000 + Math.ceil(text.length / 40) * 1_000);
    const result = await Promise.race([
      tts.toFile(outDir, text, { rate, pitch }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (result && (result as any).audioFilePath && existsSync((result as any).audioFilePath)) {
      return (result as any).audioFilePath;
    }
    if (!result) console.error(`[voice:tts] msedge-tts timed out after ${timeoutMs / 1000}s`);
    return null;
  } catch (err) {
    console.error("[voice:tts] msedge-tts failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Speak text using platform native TTS as fallback (no msedge-tts). */
function speakFallback(text: string): void {
  const os = platform();
  const wsl = isWSL();
  // Git Bash: powershell is available but may need full path
  const gitBash = isGitBash();
  const cfg = configStore.get();
  const ttsConfig = cfg.tts;
  const volume = ttsConfig?.volume ?? 80;
  const wpm = ttsConfig?.fallbackRate ?? 200;

  try {
    if (wsl) {
      // WSL: prefer Linux TTS via WSLg PulseAudio (if alive), fall back to PowerShell SAPI
      const pulseAlive = isWslPulseAvailable();
      if (pulseAlive) {
        const pulseEnv = { ...process.env, PULSE_SERVER: "/mnt/wslg/PulseServer", SDL_AUDIODRIVER: "pulse" };
        if (commandExists("espeak-ng")) {
          _activeProcess = safeProc(
            spawn("espeak-ng", ["-s", String(wpm), "-a", String(Math.min(200, volume * 2)), text], {
              stdio: "ignore", env: pulseEnv,
            })
          );
          return;
        } else if (commandExists("spd-say")) {
          const spdRate = String(Math.max(-100, Math.min(100, wpm - 200)));
          _activeProcess = safeProc(
            spawn("spd-say", ["-r", spdRate, text], { stdio: "ignore", env: pulseEnv })
          );
          return;
        }
      }
      {
        // Fallback: PowerShell SAPI
        const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
        const sapiRate = Math.max(-10, Math.min(10, Math.round((wpm - 200) / 20)));
        const psCmd =
          `Add-Type -AssemblyName System.Speech; ` +
          `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
          `$s.Rate = ${sapiRate}; $s.Volume = ${volume}; ` +
          `$s.Speak('${escaped}')`;
        _activeProcess = safeProc(
          spawn("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: "ignore" })
        );
      }
    } else if (os === "win32") {
      // Native Windows: PowerShell SAPI
      const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
      const sapiRate = Math.max(-10, Math.min(10, Math.round((wpm - 200) / 20)));
      const psCmd =
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.Rate = ${sapiRate}; $s.Volume = ${volume}; ` +
        `$s.Speak('${escaped}')`;
      _activeProcess = safeProc(
        spawn("powershell", ["-NoProfile", "-Command", psCmd], {
          stdio: "ignore",
          windowsHide: true,
        })
      );
    } else if (os === "darwin") {
      _activeProcess = safeProc(
        spawn("say", ["-r", String(wpm), "-v", "Daniel", text], { stdio: "ignore" })
      );
    } else {
      // Linux (non-WSL)
      if (commandExists("espeak-ng")) {
        _activeProcess = safeProc(
          spawn("espeak-ng", ["-s", String(wpm), "-a", String(Math.min(200, volume * 2)), text], {
            stdio: "ignore",
          })
        );
      } else if (commandExists("spd-say")) {
        const spdRate = String(Math.max(-100, Math.min(100, wpm - 200)));
        _activeProcess = safeProc(
          spawn("spd-say", ["-r", spdRate, text], { stdio: "ignore" })
        );
      } else {
        console.error("[voice:tts] no fallback TTS engine found");
      }
    }
  } catch (err) {
    console.error("[voice:tts] fallback error:", err);
  }
}

// ── Chunked TTS helpers ─────────────────────────────────────────────────────

/** Default chunk threshold in characters. */
const DEFAULT_CHUNK_THRESHOLD = 100;

/**
 * Split text into sentences for chunked playback.
 * Splits on sentence-ending punctuation followed by whitespace.
 * Merges very short fragments (<30 chars) with the previous sentence.
 */
function splitSentences(text: string): string[] {
  const parts = text.trim().split(/(?<=[.!?])\s+/);
  const sentences: string[] = [];
  for (const part of parts) {
    if (sentences.length > 0 && sentences[sentences.length - 1].length < 30) {
      sentences[sentences.length - 1] += " " + part;
    } else {
      sentences.push(part);
    }
  }
  return sentences.filter((s) => s.trim());
}

/**
 * Group sentences into chunks of approximately `targetLen` characters (2-3 sentences).
 */
function groupChunks(sentences: string[], targetLen = 150): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const s of sentences) {
    current.push(s);
    currentLen += s.length;
    if (currentLen >= targetLen) {
      chunks.push(current.join(" "));
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) {
    chunks.push(current.join(" "));
  }
  return chunks;
}

/**
 * Play an MP3 and return a promise that resolves when playback finishes.
 * Resolves to true if playback completed, false if it failed or was stopped.
 */
function playMp3Blocking(mp3Path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = playMp3(mp3Path);
    if (!proc) {
      resolve(false);
      return;
    }
    _activeProcess = proc;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (_activeProcess === proc) _activeProcess = null;
      resolve(ok);
    };
    proc.on("exit", (code) => done(code === 0));
    proc.on("error", () => done(false));
  });
}

/**
 * Chunked TTS: split text into rolling chunks, generate first chunk,
 * then pipeline generation + playback so speech starts almost immediately.
 */
async function speakChunked(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
): Promise<boolean> {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return false;

  const chunks = groupChunks(sentences);
  if (chunks.length === 0) return false;

  console.error(`[voice:tts] chunked: ${chunks.length} chunks from ${sentences.length} sentences`);

  // Resolved paths for each chunk — filled in as generation completes.
  // generateEdgeTts writes to a random temp name, so we track what it returns.
  const resolvedPaths: (string | null)[] = new Array(chunks.length).fill(null);

  // Generate first chunk before entering the pipeline loop
  const gen0 = await generateEdgeTts(chunks[0], voice, rate, pitch);
  if (!gen0 || _stopRequested) return false;
  resolvedPaths[0] = gen0;
  _chunkFiles.push(gen0);

  for (let i = 0; i < chunks.length; i++) {
    if (_stopRequested) return false;

    const currentPath = resolvedPaths[i];
    if (!currentPath || !existsSync(currentPath)) {
      console.error(`[voice:tts] chunk ${i} file missing, aborting chunked playback`);
      return false;
    }

    // Start generating next chunk in parallel while current one plays
    let nextGenPromise: Promise<string | null> | null = null;
    if (i + 1 < chunks.length) {
      nextGenPromise = generateEdgeTts(chunks[i + 1], voice, rate, pitch);
    }

    // Play current chunk (blocking)
    console.error(`[voice:tts] playing chunk ${i + 1}/${chunks.length}`);
    await playMp3Blocking(currentPath);

    // Wait for next chunk to finish generating
    if (nextGenPromise) {
      const genResult = await nextGenPromise;
      if (genResult && !_stopRequested) {
        resolvedPaths[i + 1] = genResult;
        _chunkFiles.push(genResult);
      }
    }
  }

  return true;
}

/**
 * Speak text — fire-and-forget, cancels previous speech.
 * This function NEVER throws or rejects. All errors are logged to stderr.
 */
export async function speak(text: string): Promise<void> {
  try {
    const cfg = configStore.get();
    const ttsConfig = cfg.tts;
    if (ttsConfig && !ttsConfig.enabled) return;
    if (!text?.trim()) return;

    // Cancel previous speech and reset stop flag
    stop();
    _stopRequested = false;

    const voice = ttsConfig?.voice || "en-GB-RyanNeural";
    const edgeRate = ttsConfig?.edgeRate || "+5%";
    const edgePitch = ttsConfig?.edgePitch || "-2Hz";
    const chunkThreshold = ttsConfig?.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD;

    // Long text → chunked playback (generate + play in rolling pipeline)
    if (text.length > chunkThreshold) {
      console.error(`[voice:tts] text length ${text.length} > threshold ${chunkThreshold}, using chunked playback`);
      const ok = await speakChunked(text, voice, edgeRate, edgePitch);
      if (ok || _stopRequested) {
        cleanupTempFiles();
        return;
      }
      // Chunked failed — fall through to single-shot, then platform fallback
      console.error("[voice:tts] chunked playback failed, trying single-shot");
    }

    // Short text (or chunked fallback): generate and play in one shot
    console.error(`[voice:tts] generating: voice=${voice} rate=${edgeRate} pitch=${edgePitch} tmpdir=${tmpdir()}`);
    const mp3Path = await generateEdgeTts(text, voice, edgeRate, edgePitch);
    console.error(`[voice:tts] mp3Path=${mp3Path}`);
    if (mp3Path) {
      _tmpFile = mp3Path;
      _activeProcess = playMp3(mp3Path);
      console.error(`[voice:tts] playMp3 started, process=${_activeProcess?.pid ?? 'null'}`);
      if (_activeProcess) {
        _activeProcess.on("exit", (code) => {
          console.error(`[voice:tts] playback exited code=${code}`);
          cleanupTempFiles();
          _activeProcess = null;
        });
        // Safety: clean up after 2 minutes even if exit never fires
        setTimeout(() => { cleanupTempFiles(); }, 120_000);
      } else {
        // Playback didn't start — clean up immediately
        cleanupTempFiles();
      }
      return;
    }

    // Fallback to platform native TTS
    console.error("[voice:tts] msedge-tts failed, trying platform fallback");
    speakFallback(text);
  } catch (err) {
    // Absolute last resort — never let anything escape
    console.error("[voice:tts] unexpected error:", err);
  }
}

/** List available edge-tts voices. */
export async function listVoices(): Promise<
  Array<{ name: string; shortName: string; gender: string; locale: string }>
> {
  try {
    if (!_MsEdgeTTS) {
      const mod = await import("msedge-tts");
      _MsEdgeTTS = mod.MsEdgeTTS;
      _OUTPUT_FORMAT = mod.OUTPUT_FORMAT;
    }

    const tts = new _MsEdgeTTS();
    const voices = await tts.getVoices();
    return voices.map((v: any) => ({
      name: v.FriendlyName ?? v.ShortName,
      shortName: v.ShortName,
      gender: v.Gender,
      locale: v.Locale,
    }));
  } catch {
    return [];
  }
}
