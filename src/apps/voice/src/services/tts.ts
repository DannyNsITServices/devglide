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

import { unlinkSync, readFileSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { platform } from "os";
import { spawn, execSync, type ChildProcess } from "child_process";
import { configStore } from "./config-store.js";

let _activeProcess: ChildProcess | null = null;
let _tmpFile: string | null = null;
let _wslCopyFile: string | null = null;

/** Remove a file silently. */
function safeUnlink(path: string | null): void {
  if (!path) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Clean up all temp files from TTS. */
function cleanupTempFiles(): void {
  safeUnlink(_tmpFile);
  _tmpFile = null;
  safeUnlink(_wslCopyFile);
  _wslCopyFile = null;
}

// Lazy-loaded msedge-tts
let _MsEdgeTTS: any = null;
let _OUTPUT_FORMAT: any = null;

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

/**
 * Get a Windows-native temp directory path.
 * On Git Bash, tmpdir() returns POSIX paths like /tmp which PowerShell can't read.
 * Use process.env.TEMP (always a Windows path) as fallback.
 */
function getWindowsTempDir(): string {
  if (isGitBash() || isWSL()) {
    // Use Windows %TEMP% directly
    const winTemp = process.env.TEMP || process.env.TMP;
    if (winTemp && /^[A-Z]:\\/i.test(winTemp)) return winTemp;
    // For WSL, query from powershell
    if (isWSL()) {
      try {
        return execSync("powershell.exe -NoProfile -Command \"Write-Host $env:TEMP\"")
          .toString().trim();
      } catch { /* fall through */ }
    }
  }
  return tmpdir();
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
 * On WSL, copies to Windows %TEMP% and plays via powershell.exe.
 */
function playMp3(mp3Path: string): ChildProcess | null {
  const os = platform();
  const wsl = isWSL();

  try {
    if (os === "win32" || wsl) {
      const psExe = wsl ? "powershell.exe" : "powershell";
      let winPath: string;
      if (wsl) {
        // WSL: copy to Windows temp — UNC \\wsl.localhost paths don't work
        // reliably with WMPlayer COM
        const winTempDir = getWindowsTempDir();
        const wslTempDir = execSync(`wslpath -u "${winTempDir}"`).toString().trim();
        const copyDest = join(wslTempDir, "devglide-tts.mp3");
        copyFileSync(mp3Path, copyDest);
        _wslCopyFile = copyDest;
        winPath = `${winTempDir}\\devglide-tts.mp3`;
      } else {
        // Native Windows or Git Bash: convert path for PowerShell
        winPath = toWindowsPath(mp3Path);
      }
      const psCmd =
        `$mp = New-Object -ComObject WMPlayer.OCX; ` +
        `$mp.URL = '${winPath.replace(/'/g, "''")}'; ` +
        `Start-Sleep -Milliseconds 200; ` +
        `while ($mp.playState -eq 3) { Start-Sleep -Milliseconds 50 }; ` +
        `$mp.close()`;
      return safeProc(
        spawn(psExe, ["-NoProfile", "-Command", psCmd], {
          stdio: "ignore",
          ...(os === "win32" ? { windowsHide: true } : {}),
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

    // Use Windows-native temp dir on Git Bash/WSL so PowerShell can access the file
    const outDir = (platform() === "win32" || isWSL()) ? getWindowsTempDir() : tmpdir();
    const { audioFilePath } = await tts.toFile(outDir, text, { rate, pitch });

    if (audioFilePath && existsSync(audioFilePath)) {
      return audioFilePath;
    }
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
    if (os === "win32" || wsl) {
      // Windows or WSL: PowerShell SAPI
      // SAPI Rate: -10 to +10, where 0 ≈ 200 WPM
      const psExe = wsl ? "powershell.exe" : "powershell";
      const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
      const sapiRate = Math.max(-10, Math.min(10, Math.round((wpm - 200) / 20)));
      const psCmd =
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.Rate = ${sapiRate}; $s.Volume = ${volume}; ` +
        `$s.Speak('${escaped}')`;
      _activeProcess = safeProc(
        spawn(psExe, ["-NoProfile", "-Command", psCmd], {
          stdio: "ignore",
          ...(os === "win32" ? { windowsHide: true } : {}),
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

    // Cancel previous speech
    stop();

    const voice = ttsConfig?.voice || "en-GB-RyanNeural";
    const edgeRate = ttsConfig?.edgeRate || "+5%";
    const edgePitch = ttsConfig?.edgePitch || "-2Hz";

    // Try msedge-tts (pure Node.js) first
    const mp3Path = await generateEdgeTts(text, voice, edgeRate, edgePitch);
    if (mp3Path) {
      _tmpFile = mp3Path;
      _activeProcess = playMp3(mp3Path);
      if (_activeProcess) {
        _activeProcess.on("exit", () => {
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
