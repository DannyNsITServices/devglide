/**
 * Text-to-Speech service — neural TTS via edge-tts, fire-and-forget.
 * JARVIS-style: en-GB-RyanNeural, fast & crisp.
 */

import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { platform } from "os";
import { spawn, type ChildProcess } from "child_process";
import { configStore } from "./config-store.js";

let _activeProcess: ChildProcess | null = null;
let _tmpFile: string | null = null;

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

/** Play an MP3 file in the background, returns the child process. */
function playMp3(path: string): ChildProcess | null {
  const os = platform();
  try {
    if (os === "win32") {
      // Windows: PowerShell with Windows Media Player COM
      const psCmd =
        `$mp = New-Object -ComObject WMPlayer.OCX; ` +
        `$mp.URL = '${path.replace(/'/g, "''")}'; ` +
        `Start-Sleep -Milliseconds 100; ` +
        `while ($mp.playState -eq 3) { Start-Sleep -Milliseconds 50 }; ` +
        `$mp.close()`;
      return spawn("powershell", ["-NoProfile", "-Command", psCmd], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (os === "darwin") {
      return spawn("afplay", [path], { stdio: "ignore" });
    } else {
      // Linux: try mpv first, then ffplay
      try {
        return spawn("mpv", ["--no-video", path], { stdio: "ignore" });
      } catch {
        return spawn("ffplay", ["-nodisp", "-autoexit", path], {
          stdio: "ignore",
        });
      }
    }
  } catch {
    return null;
  }
}

/** Speak text using platform native TTS as fallback. */
function speakFallback(text: string): void {
  const os = platform();
  const cfg = configStore.get();
  const ttsConfig = cfg.tts;
  const volume = ttsConfig?.volume ?? 80;

  try {
    if (os === "win32") {
      const escaped = text.replace(/'/g, "''");
      const rate = Math.max(-10, Math.min(10, Math.round((185 - 200) / 20)));
      const psCmd =
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.Rate = ${rate}; $s.Volume = ${volume}; ` +
        `$s.Speak('${escaped}')`;
      _activeProcess = spawn("powershell", ["-NoProfile", "-Command", psCmd], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (os === "darwin") {
      _activeProcess = spawn("say", ["-r", "185", "-v", "Daniel", text], {
        stdio: "ignore",
      });
    } else {
      // Linux: espeak-ng or spd-say
      try {
        _activeProcess = spawn(
          "espeak-ng",
          ["-s", "185", "-a", String(Math.min(200, volume * 2)), text],
          { stdio: "ignore" }
        );
      } catch {
        _activeProcess = spawn("spd-say", ["-r", "-15", text], {
          stdio: "ignore",
        });
      }
    }
  } catch {
    // no TTS available
  }
}

/** Speak text — fire-and-forget, cancels previous speech. */
export async function speak(text: string): Promise<void> {
  const cfg = configStore.get();
  const ttsConfig = cfg.tts;
  if (ttsConfig && !ttsConfig.enabled) return;
  if (!text?.trim()) return;

  // Cancel previous speech
  stop();

  const voice = ttsConfig?.voice || "en-GB-RyanNeural";
  const rate = ttsConfig?.rate || "+12%";
  const pitch = ttsConfig?.pitch || "+1Hz";
  const volume = `+${ttsConfig?.volume ?? 80}%`;

  try {
    // Dynamic import of edge-tts
    const { tts: edgeTts } = await import("edge-tts");

    const audioBuffer = await edgeTts(text, { voice, rate, pitch, volume });

    const mp3Path = join(tmpdir(), `devglide-tts-${Date.now()}.mp3`);
    writeFileSync(mp3Path, audioBuffer);
    _tmpFile = mp3Path;

    _activeProcess = playMp3(mp3Path);

    // Clean up temp file when playback finishes
    if (_activeProcess) {
      _activeProcess.on("exit", () => {
        try {
          unlinkSync(mp3Path);
        } catch {
          // already gone
        }
        if (_tmpFile === mp3Path) _tmpFile = null;
        _activeProcess = null;
      });
    }
  } catch {
    // edge-tts failed — try platform fallback
    try {
      speakFallback(text);
    } catch {
      // no TTS available at all
    }
  }
}

/** List available edge-tts voices. */
export async function listVoices(): Promise<
  Array<{ name: string; shortName: string; gender: string; locale: string }>
> {
  try {
    const { getVoices } = await import("edge-tts");
    const voices = await getVoices();
    return voices.map((v) => ({
      name: v.FriendlyName,
      shortName: v.ShortName,
      gender: v.Gender,
      locale: v.Locale,
    }));
  } catch {
    return [];
  }
}
