/**
 * Text-to-Speech service — neural TTS via edge-tts Python CLI, fire-and-forget.
 * JARVIS-style: en-GB-RyanNeural, fast & crisp.
 *
 * IMPORTANT: This module must NEVER crash the process. All errors are
 * caught and logged to stderr. speak() never rejects.
 *
 * TTS chain:
 *   1. edge-tts Python CLI (actively maintained, works cross-platform)
 *   2. Platform fallback: powershell.exe SAPI (WSL/Windows), say (macOS), espeak-ng (Linux)
 *
 * Audio playback on WSL routes through powershell.exe since Linux audio
 * binaries aren't typically available in WSL.
 */

import { unlinkSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { platform } from "os";
import { spawn, execSync, type ChildProcess } from "child_process";
import { configStore } from "./config-store.js";

let _activeProcess: ChildProcess | null = null;
let _tmpFile: string | null = null;

/** Detect WSL environment. */
function isWSL(): boolean {
  try {
    const version = readFileSync("/proc/version", "utf-8");
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
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

/** Stop any active TTS playback. */
export function stop(): void {
  if (_activeProcess) {
    try {
      _activeProcess.kill();
    } catch {
      // already exited
    }
    _activeProcess = null;
  }
  if (_tmpFile) {
    try {
      unlinkSync(_tmpFile);
    } catch {
      // already cleaned up
    }
    _tmpFile = null;
  }
}

/**
 * Play an MP3 file in the background via the appropriate platform player.
 * On WSL, routes through powershell.exe to access Windows audio.
 */
function playMp3(mp3Path: string): ChildProcess | null {
  const os = platform();
  const wsl = isWSL();

  try {
    if (os === "win32" || wsl) {
      // Windows or WSL: use powershell(.exe) with Windows Media Player COM
      const psExe = wsl ? "powershell.exe" : "powershell";
      // Convert WSL path to Windows path for powershell.exe
      const winPath = wsl ? mp3Path.replace(/^\/mnt\/([a-z])\//, "$1:\\\\").replace(/\//g, "\\\\")
        : mp3Path;
      // For WSL tmp paths like /tmp/..., use wslpath or \\\\wsl$\\ UNC
      const resolvedPath = wsl && mp3Path.startsWith("/tmp")
        ? (() => { try { return execSync(`wslpath -w "${mp3Path}"`).toString().trim(); } catch { return mp3Path; } })()
        : winPath;
      const psCmd =
        `$mp = New-Object -ComObject WMPlayer.OCX; ` +
        `$mp.URL = '${resolvedPath.replace(/'/g, "''")}'; ` +
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
 * Generate MP3 using edge-tts Python CLI.
 * Returns the path to the generated MP3, or null on failure.
 */
async function generateEdgeTts(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
  volume: string,
): Promise<string | null> {
  const mp3Path = join(tmpdir(), `devglide-tts-${Date.now()}.mp3`);

  return new Promise<string | null>((resolve) => {
    const args = [
      "--text", text,
      "--voice", voice,
      "--rate", rate,
      "--pitch", pitch,
      "--volume", volume,
      "--write-media", mp3Path,
    ];

    const proc = spawn("edge-tts", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("error", (err) => {
      console.error("[voice:tts] edge-tts CLI error:", err.message);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code === 0 && existsSync(mp3Path)) {
        resolve(mp3Path);
      } else {
        console.error("[voice:tts] edge-tts CLI failed (code", code + "):", stderr.trim());
        resolve(null);
      }
    });
  });
}

/** Speak text using platform native TTS as fallback (no edge-tts). */
function speakFallback(text: string): void {
  const os = platform();
  const wsl = isWSL();
  const cfg = configStore.get();
  const ttsConfig = cfg.tts;
  const volume = ttsConfig?.volume ?? 80;

  try {
    if (os === "win32" || wsl) {
      // Windows or WSL: PowerShell SAPI
      const psExe = wsl ? "powershell.exe" : "powershell";
      const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
      const rate = Math.max(-10, Math.min(10, Math.round((185 - 200) / 20)));
      const psCmd =
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.Rate = ${rate}; $s.Volume = ${volume}; ` +
        `$s.Speak('${escaped}')`;
      _activeProcess = safeProc(
        spawn(psExe, ["-NoProfile", "-Command", psCmd], {
          stdio: "ignore",
          ...(os === "win32" ? { windowsHide: true } : {}),
        })
      );
    } else if (os === "darwin") {
      _activeProcess = safeProc(
        spawn("say", ["-r", "185", "-v", "Daniel", text], { stdio: "ignore" })
      );
    } else {
      // Linux (non-WSL)
      if (commandExists("espeak-ng")) {
        _activeProcess = safeProc(
          spawn("espeak-ng", ["-s", "185", "-a", String(Math.min(200, volume * 2)), text], {
            stdio: "ignore",
          })
        );
      } else if (commandExists("spd-say")) {
        _activeProcess = safeProc(
          spawn("spd-say", ["-r", "-15", text], { stdio: "ignore" })
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
    const rate = ttsConfig?.rate || "+12%";
    const pitch = ttsConfig?.pitch || "+1Hz";
    // edge-tts volume requires +N% or -N% format (relative to default)
    const volNum = ttsConfig?.volume ?? 80;
    const volume = `${volNum >= 0 ? "+" : ""}${volNum - 100}%`;

    // Try edge-tts Python CLI first
    if (commandExists("edge-tts")) {
      const mp3Path = await generateEdgeTts(text, voice, rate, pitch, volume);
      if (mp3Path) {
        _tmpFile = mp3Path;
        _activeProcess = playMp3(mp3Path);
        if (_activeProcess) {
          _activeProcess.on("exit", () => {
            try { unlinkSync(mp3Path); } catch { /* already gone */ }
            if (_tmpFile === mp3Path) _tmpFile = null;
            _activeProcess = null;
          });
        }
        return;
      }
    }

    // Fallback to platform native TTS
    console.error("[voice:tts] edge-tts not available, trying platform fallback");
    speakFallback(text);
  } catch (err) {
    // Absolute last resort — never let anything escape
    console.error("[voice:tts] unexpected error:", err);
  }
}

/** List available edge-tts voices via Python CLI. */
export async function listVoices(): Promise<
  Array<{ name: string; shortName: string; gender: string; locale: string }>
> {
  if (!commandExists("edge-tts")) return [];

  return new Promise((resolve) => {
    const proc = spawn("edge-tts", ["--list-voices"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";

    proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });

    proc.on("error", () => resolve([]));

    proc.on("close", (code) => {
      if (code !== 0) { resolve([]); return; }
      try {
        // Parse tabular output: Name, Gender, ContentCategories, VoicePersonalities
        const lines = stdout.trim().split("\n").slice(1); // skip header
        const voices = lines
          .map((line) => {
            const parts = line.split(/\s{2,}/);
            if (parts.length < 2) return null;
            const shortName = parts[0].trim();
            const gender = parts[1].trim();
            const locale = shortName.split("-").slice(0, 2).join("-");
            return { name: shortName, shortName, gender, locale };
          })
          .filter(Boolean) as Array<{ name: string; shortName: string; gender: string; locale: string }>;
        resolve(voices);
      } catch {
        resolve([]);
      }
    });
  });
}
