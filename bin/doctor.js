// Dependency doctor for the voice local-whisper provider.
// Reports whether local transcription can work on this machine: ffmpeg
// (always required), whisper-cli (built in the nodejs-whisper tree, on PATH,
// or auto-provisioned), and cmake (only needed for a from-source build).

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { createRequire } from "module";

/** Run a probe command; return its first output line, or null if it fails. */
export function defaultProbe(cmd) {
  try {
    const out = execSync(cmd, { stdio: "pipe", timeout: 10_000 }).toString();
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "found";
  } catch {
    return null;
  }
}

/** Check whether whisper-cli was already built inside the nodejs-whisper package. */
function whisperCliBuiltInTree() {
  try {
    const require_ = createRequire(import.meta.url);
    const whisperCppPath = join(
      dirname(require_.resolve("nodejs-whisper/package.json")),
      "cpp",
      "whisper.cpp"
    );
    const exeName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    return [
      join(whisperCppPath, "build", "bin", exeName),
      join(whisperCppPath, "build", "bin", "Release", exeName),
      join(whisperCppPath, "build", "bin", "Debug", exeName),
      join(whisperCppPath, "build", exeName),
      join(whisperCppPath, exeName),
    ].some((p) => existsSync(p));
  } catch {
    return false;
  }
}

/**
 * Collect dependency checks as { name, ok, detail, hint } entries.
 * All environment access is injectable for tests.
 */
export function collectDoctorChecks({
  platform = process.platform,
  probe = defaultProbe,
  builtInTree = whisperCliBuiltInTree,
} = {}) {
  const checks = [];

  const ffmpeg = probe("ffmpeg -version");
  checks.push({
    name: "ffmpeg",
    ok: ffmpeg !== null,
    detail: ffmpeg ?? "not found on PATH",
    hint: ffmpeg !== null
      ? null
      : platform === "darwin"
        ? "brew install ffmpeg"
        : platform === "win32"
          ? "winget install ffmpeg"
          : "sudo apt install ffmpeg",
  });

  const inTree = builtInTree();
  const onPath = probe(platform === "win32" ? "where whisper-cli" : "command -v whisper-cli");
  // Windows never needs manual provisioning: a prebuilt binary is downloaded
  // on first transcription.
  const whisperOk = inTree || onPath !== null || platform === "win32";
  checks.push({
    name: "whisper-cli",
    ok: whisperOk,
    detail: inTree
      ? "already built for nodejs-whisper"
      : onPath !== null
        ? `found on PATH (${onPath}) — adopted automatically on first use`
        : platform === "win32"
          ? "not found — prebuilt binary is auto-downloaded on first transcription"
          : "not found",
    hint: whisperOk
      ? null
      : platform === "darwin"
        ? "brew install whisper-cpp   (no compile needed — adopted automatically)"
        : "install build tools below; whisper.cpp is compiled on first transcription",
  });

  const cmakeNeeded = !inTree && onPath === null && platform !== "win32";
  const cmake = probe("cmake --version");
  const cmakeOk = cmake !== null || !cmakeNeeded;
  checks.push({
    name: "cmake",
    ok: cmakeOk,
    detail: cmake ?? (cmakeNeeded ? "not found on PATH" : "not needed (whisper-cli already available)"),
    hint: cmakeOk
      ? null
      : platform === "darwin"
        ? "brew install cmake   (xcode-select --install alone is not enough)"
        : "sudo apt install build-essential cmake",
  });

  return checks;
}

/** Render checks as an indented report block. */
export function formatDoctorReport(checks) {
  const lines = ["", "  Voice dependency check:", ""];
  for (const check of checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    if (check.hint) lines.push(`      → ${check.hint}`);
  }
  return lines.join("\n");
}

/** Print the doctor report; returns true when every check passed. */
export function runDoctor(options = {}) {
  const checks = collectDoctorChecks(options);
  console.log(formatDoctorReport(checks));
  return checks.every((check) => check.ok);
}
