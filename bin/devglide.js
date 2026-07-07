#!/usr/bin/env node

import { spawn, execSync, spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, openSync, closeSync } from "fs";

import { homedir } from "os";

import { getClaudeMdContent, injectSection, removeSection } from "./claude-md-template.js";
import { removeDevglideSectionsFromToml } from "./codex-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const stateDir = resolve(homedir(), ".devglide");
const pidDir = resolve(stateDir, "pids");
const logDir = resolve(stateDir, "logs");

mkdirSync(pidDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

// Unified server (single process, all apps on one port)
const SERVER_PORT = parseInt(process.env.DEVGLIDE_PORT || '7000', 10);

const [command, ...args] = process.argv.slice(2);

// --- PID helpers ---

function pidFile(name) {
  return resolve(pidDir, `${name}.pid`);
}

function savePid(name, pid) {
  writeFileSync(pidFile(name), String(pid));
}

function readPid(name) {
  try {
    return parseInt(readFileSync(pidFile(name), "utf8"), 10);
  } catch {
    return null;
  }
}

function removePid(name) {
  try { unlinkSync(pidFile(name)); } catch {}
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getStatus(name) {
  const pid = readPid(name);
  if (pid && isRunning(pid)) return { running: true, pid };
  if (pid) removePid(name); // stale pid
  return { running: false, pid: null };
}

// --- Commands ---

function showStatus() {
  console.log();
  const { running, pid } = getStatus("server");
  const state = running ? `\x1b[32mrunning\x1b[0m  pid ${pid}` : `\x1b[90mstopped\x1b[0m`;
  console.log(`  server  :${SERVER_PORT}  ${state}`);
  console.log();
}

function tailLogs(name) {
  const logFile = resolve(logDir, `${name}.log`);
  if (!existsSync(logFile)) {
    console.error(`No logs for ${name}`);
    process.exit(1);
  }
  const tail = spawn("tail", ["-f", "-n", "50", logFile], { stdio: "inherit" });
  process.on("SIGINT", () => { tail.kill(); process.exit(0); });
  tail.on("error", (err) => {
    if (err.code !== "ENOENT") {
      console.error(`  Failed to tail logs: ${err.message}`);
      process.exit(1);
    }
    // `tail` is not on PATH (typical on native Windows) — fall back gracefully.
    if (process.platform === "win32") {
      const ps = spawn(
        "powershell",
        ["-NoProfile", "-Command", `Get-Content -Path '${logFile}' -Tail 50 -Wait`],
        { stdio: "inherit" }
      );
      ps.on("error", () => {
        console.error("  Cannot tail logs: neither 'tail' nor PowerShell is available.");
        console.error(`  Log file: ${logFile}`);
        process.exit(1);
      });
      process.on("SIGINT", () => { ps.kill(); process.exit(0); });
    } else {
      console.error("  'tail' was not found on PATH.");
      console.error(`  Log file: ${logFile}`);
      process.exit(1);
    }
  });
}

// --- MCP launcher ---

const mcpServers = {
  kanban:     { cwd: "src/apps/kanban",     entry: "src/index.ts", runtime: "tsx" },
  voice:      { cwd: "src/apps/voice",      entry: "src/index.ts", runtime: "tsx" },
  log:        { cwd: "src/apps/log",        entry: "src/index.ts", runtime: "tsx" },
  test:       { cwd: "src/apps/test",       entry: "src/index.ts", runtime: "tsx" },
  shell:      { cwd: "src/apps/shell",      entry: "src/index.ts", runtime: "tsx" },
  workflow:   { cwd: "src/apps/workflow",   entry: "src/index.ts", runtime: "tsx" },
  vocabulary: { cwd: "src/apps/vocabulary", entry: "src/index.ts", runtime: "tsx" },
  prompts:    { cwd: "src/apps/prompts",    entry: "src/index.ts", runtime: "tsx" },
  chat:          { cwd: "src/apps/chat",          entry: "src/index.ts", runtime: "tsx" },
  documentation: { cwd: "src/apps/documentation", entry: "src/index.ts", runtime: "tsx" },
};

// --- Gemini CLI integration ---

const geminiSettingsPath = resolve(homedir(), ".gemini", "settings.json");

function detectGemini() {
  return existsSync(resolve(homedir(), ".gemini"));
}

/**
 * Read Gemini settings.json, add/replace all devglide-* MCP servers.
 * Format: { mcpServers: { "devglide-kanban": { command, args } } }
 */
function writeGeminiMcpServers() {
  let settings = {};
  // Distinguish "file missing" (start fresh) from "exists but unreadable/unparseable"
  // (abort — never clobber the user's existing Gemini config on a transient error).
  if (existsSync(geminiSettingsPath)) {
    try {
      settings = JSON.parse(readFileSync(geminiSettingsPath, "utf8"));
    } catch (err) {
      throw new Error(`Refusing to overwrite unreadable Gemini settings at ${geminiSettingsPath}: ${err.message}`);
    }
  }
  if (!settings.mcpServers) settings.mcpServers = {};

  // Remove existing devglide entries
  for (const key of Object.keys(settings.mcpServers)) {
    if (key.startsWith("devglide-")) delete settings.mcpServers[key];
  }

  // Add current servers
  for (const name of Object.keys(mcpServers)) {
    const mcpName = `devglide-${name}`;
    const bundle = resolve(root, `dist/mcp/${name}.mjs`);
    if (existsSync(bundle)) {
      settings.mcpServers[mcpName] = { command: process.execPath, args: [bundle, "--stdio"] };
    } else {
      const devglideBin = resolve(__dirname, "devglide.js");
      settings.mcpServers[mcpName] = { command: process.execPath, args: [devglideBin, "mcp", name] };
    }
  }

  mkdirSync(resolve(homedir(), ".gemini"), { recursive: true });
  writeFileSync(geminiSettingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Remove all devglide-* MCP servers from Gemini settings.json.
 */
function removeGeminiMcpServers() {
  let settings = {};
  try { settings = JSON.parse(readFileSync(geminiSettingsPath, "utf8")); } catch { return false; }
  if (!settings.mcpServers) return false;

  let changed = false;
  for (const key of Object.keys(settings.mcpServers)) {
    if (key.startsWith("devglide-")) {
      delete settings.mcpServers[key];
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(geminiSettingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return changed;
}

// --- Codex integration ---

const codexConfigPath = resolve(homedir(), ".codex", "config.toml");

function detectCodex() {
  return existsSync(resolve(homedir(), ".codex"));
}

/**
 * Build TOML [mcp_servers.devglide-*] sections for all servers.
 * Prefers bundled .mjs files, falls back to devglide.js mcp launcher.
 */
function buildCodexMcpSections() {
  const sections = [];
  for (const name of Object.keys(mcpServers)) {
    const mcpName = `devglide-${name}`;
    const bundle = resolve(root, `dist/mcp/${name}.mjs`);
    if (existsSync(bundle)) {
      sections.push(
        `[mcp_servers.${mcpName}]\n` +
        `command = ${JSON.stringify(process.execPath)}\n` +
        `args = [${JSON.stringify(bundle)}, "--stdio"]`
      );
    } else {
      const devglideBin = resolve(__dirname, "devglide.js");
      sections.push(
        `[mcp_servers.${mcpName}]\n` +
        `command = ${JSON.stringify(process.execPath)}\n` +
        `args = [${JSON.stringify(devglideBin)}, "mcp", ${JSON.stringify(name)}]`
      );
    }
  }
  return sections.join('\n\n') + '\n';
}

function runMcpServer(name) {
  const server = mcpServers[name];
  if (!server) {
    console.error(`Unknown MCP server: ${name}`);
    console.error(`Available: ${Object.keys(mcpServers).join(", ")}`);
    process.exit(1);
  }

  // Prefer pre-built bundle (1 process) over tsx (3+ processes)
  const bundle = resolve(root, `dist/mcp/${name}.mjs`);
  if (existsSync(bundle)) {
    const child = spawn(process.execPath, [bundle, "--stdio"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  // Dev fallback: use tsx
  const cwd = resolve(root, server.cwd);
  const entry = resolve(cwd, server.entry);

  if (server.runtime === "tsx") {
    const tsxPaths = [
      resolve(root, "node_modules/.bin/tsx"),
      resolve(cwd, "node_modules/.bin/tsx"),
    ];
    const tsxBin = tsxPaths.find((p) => existsSync(p));

    if (!tsxBin) {
      console.error("tsx not found. Run 'pnpm install' first.");
      process.exit(1);
    }

    // shell:true is needed on Windows to resolve the extensionless `.bin/tsx`
    // launcher via the shell. Quote the executable and path args so absolute
    // paths containing spaces are not split by the shell.
    const child = spawn(`"${tsxBin}"`, [`"${entry}"`, "--stdio"], {
      cwd,
      stdio: "inherit",
      env: process.env,
      shell: true,
    });
    child.on("exit", (code) => process.exit(code ?? 1));
  } else {
    const child = spawn(process.execPath, [entry, "--stdio"], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 1));
  }
}

// --- Unified server ---

/** Probe the health endpoint. Returns the health JSON, or null if nothing answers. */
async function probeHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Print the last lines of the server log to help diagnose a failed start. */
function printLogTail(lines = 15) {
  try {
    const logFile = resolve(logDir, "server.log");
    const content = readFileSync(logFile, "utf8").trimEnd().split("\n");
    const tail = content.slice(-lines);
    if (tail.length) {
      console.error(`\n  Last ${tail.length} log lines (${logFile}):`);
      for (const line of tail) console.error(`    ${line}`);
    }
  } catch { /* no log yet */ }
}

async function startServer(foreground = false) {
  const { running, pid } = getStatus("server");
  if (running) {
    console.log(`  server already running (pid ${pid})`);
    return;
  }

  // Preflight: the pid file may be stale while a *different* process still
  // holds the port (e.g. a server started from another working copy).
  // Starting on top of it would exit with EADDRINUSE after we already
  // reported success — detect and refuse instead.
  const existing = await probeHealth();
  if (existing) {
    console.error(
      `  port :${SERVER_PORT} is already served by another devglide process` +
      (existing.pid ? ` (pid ${existing.pid})` : "") +
      ` not tracked by this CLI.`
    );
    console.error(`  Stop it first (devglide stop, or kill the pid above), then retry.`);
    process.exitCode = 1;
    return;
  }

  // Spawn tsx via its JS entry with the current node binary — no shell.
  // shell:true combined with detached:true silently discards fd-redirected
  // stdio on Windows (cmd.exe attaches to a fresh console), which made the
  // daemon log permanently empty and startup failures undiagnosable.
  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  if (!existsSync(tsxCli)) {
    console.error("tsx not found. Run 'pnpm install' first.");
    process.exit(1);
  }

  if (foreground) {
    const child = spawn(process.execPath, [tsxCli, "src/server.ts"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PORT: String(SERVER_PORT) },
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  // Background daemon
  const logFile = resolve(logDir, "server.log");
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [tsxCli, "src/server.ts"], {
    cwd: root,
    stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(SERVER_PORT) },
    detached: true,
  });
  savePid("server", child.pid);
  child.unref();
  closeSync(out);

  // Verify the daemon actually came up before claiming success: the child
  // must stay alive AND the health endpoint must answer.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isRunning(child.pid)) {
      removePid("server");
      console.error(`  server failed to start — process exited during startup.`);
      printLogTail();
      process.exitCode = 1;
      return;
    }
    if (await probeHealth()) {
      console.log(`  server started on :${SERVER_PORT} (pid ${child.pid})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  removePid("server");
  console.error(`  server did not become ready on :${SERVER_PORT} within 15s.`);
  printLogTail();
  process.exitCode = 1;
}

function killTree(pid, signal) {
  if (process.platform === 'win32') {
    // On Windows, taskkill /T kills the entire process tree. Only force-kill
    // (/F) for SIGKILL; SIGTERM requests a graceful shutdown.
    const taskkillArgs = signal === 'SIGKILL'
      ? ['/F', '/T', '/PID', String(pid)]
      : ['/T', '/PID', String(pid)];
    spawnSync('taskkill', taskkillArgs, { stdio: 'ignore' });
  } else {
    // On Unix, negative PID kills the process group
    try { process.kill(-pid, signal); } catch {
      try { process.kill(pid, signal); } catch {}
    }
  }
}

/** Poll until the process exits or the timeout elapses. Resolves true if gone. */
function waitForExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!isRunning(pid)) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(check, 100);
    };
    check();
  });
}

async function stopServer() {
  const { running, pid } = getStatus("server");
  if (!running) {
    console.log("  server not running");
    return;
  }
  killTree(pid, "SIGTERM");
  // Wait for graceful exit; escalate to SIGKILL if still alive. Only remove the
  // PID file once the process is confirmed dead so a stale entry never lingers.
  let exited = await waitForExit(pid, 5000);
  if (!exited) {
    killTree(pid, "SIGKILL");
    exited = await waitForExit(pid, 2000);
  }
  if (exited) {
    removePid("server");
    console.log(`  server stopped (was pid ${pid})`);
  } else {
    console.error(`  server (pid ${pid}) did not exit; leaving PID file in place`);
  }
}

// --- Setup ---

function runSetup() {
  console.log("\n  Setting up DevGlide...\n");

  // Build MCP bundles first
  const buildScript = resolve(root, "scripts/build-mcp.mjs");
  if (existsSync(buildScript)) {
    console.log("  Building MCP bundles...\n");
    try {
      execSync(`"${process.execPath}" "${buildScript}"`, { cwd: root, stdio: "inherit" });
      console.log();
    } catch {
      console.error("  ✗ Bundle build failed — falling back to tsx registration\n");
    }
  }

  console.log("  Registering MCP servers in Claude Code...\n");

  // Remove legacy bare "devglide" HTTP server if present
  try {
    execSync("claude mcp remove devglide --scope user", { stdio: "pipe" });
    console.log("  ✓ devglide (legacy) removed\n");
  } catch { /* not registered — nothing to do */ }

  let failed = false;
  for (const name of Object.keys(mcpServers)) {
    const mcpName = `devglide-${name}`;
    const bundle = resolve(root, `dist/mcp/${name}.mjs`);
    const useBundle = existsSync(bundle);

    try {
      // Remove existing registration if any
      try {
        execSync(`claude mcp remove ${mcpName} --scope user`, { stdio: "pipe" });
      } catch {
        // Not registered yet — that's fine
      }

      if (useBundle) {
        // Register bundle directly — 1 process per server
        execSync(
          `claude mcp add --transport stdio ${mcpName} --scope user -- "${process.execPath}" "${bundle}" --stdio`,
          { stdio: "pipe" }
        );
      } else {
        // Fallback: register via devglide.js mcp launcher
        const devglideBin = resolve(__dirname, "devglide.js");
        execSync(
          `claude mcp add --transport stdio ${mcpName} --scope user -- "${process.execPath}" "${devglideBin}" mcp ${name}`,
          { stdio: "pipe" }
        );
      }
      console.log(`  ✓ ${mcpName} registered${useBundle ? " (bundled)" : " (tsx fallback)"}`);
    } catch (err) {
      console.error(`  ✗ ${mcpName} failed to register`);
      if (err.stderr) console.error(err.stderr.toString().trimEnd());
      failed = true;
    }
  }

  if (failed) {
    console.error("\n  Some servers failed to register. Is Claude Code (CLI) installed?");
    process.exit(1);
  }

  // Register in Codex (if present)
  if (detectCodex()) {
    console.log("\n  Registering MCP servers in Codex...\n");
    try {
      let toml = "";
      // Distinguish "file missing" (start fresh) from "exists but unreadable"
      // (abort — never clobber the user's existing Codex config on a read error).
      if (existsSync(codexConfigPath)) {
        try {
          toml = readFileSync(codexConfigPath, "utf8");
        } catch (err) {
          throw new Error(`Refusing to overwrite unreadable Codex config at ${codexConfigPath}: ${err.message}`);
        }
      }
      toml = removeDevglideSectionsFromToml(toml);
      const sections = buildCodexMcpSections();
      toml = (toml.trimEnd() + '\n\n' + sections).replace(/^\n+/, '');
      writeFileSync(codexConfigPath, toml);
      for (const name of Object.keys(mcpServers)) {
        const bundle = resolve(root, `dist/mcp/${name}.mjs`);
        console.log(`  ✓ devglide-${name} registered in Codex${existsSync(bundle) ? " (bundled)" : " (tsx fallback)"}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to update Codex config: ${err.message}`);
    }
  }

  // Register in Gemini (if present) — direct settings.json mutation
  if (detectGemini()) {
    console.log("\n  Registering MCP servers in Gemini...\n");
    try {
      writeGeminiMcpServers();
      for (const name of Object.keys(mcpServers)) {
        const bundle = resolve(root, `dist/mcp/${name}.mjs`);
        console.log(`  ✓ devglide-${name} registered in Gemini${existsSync(bundle) ? " (bundled)" : " (tsx fallback)"}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to update Gemini settings: ${err.message}`);
    }
  }

  // Install managed CLAUDE.md section
  const claudeDir = resolve(homedir(), ".claude");
  const claudeMdPath = resolve(claudeDir, "CLAUDE.md");
  mkdirSync(claudeDir, { recursive: true });

  let existing = "";
  try {
    existing = readFileSync(claudeMdPath, "utf8");
  } catch {
    // File doesn't exist yet
  }

  const updated = injectSection(existing, getClaudeMdContent());
  if (updated !== existing) {
    writeFileSync(claudeMdPath, updated);
    console.log(`\n  ✓ DevGlide instructions installed in ${claudeMdPath}`);
  } else {
    console.log(`\n  ✓ DevGlide instructions already up to date in ${claudeMdPath}`);
  }

  // Install managed GEMINI.md section (if Gemini detected)
  if (detectGemini()) {
    const geminiDir = resolve(homedir(), ".gemini");
    const geminiMdPath = resolve(geminiDir, "GEMINI.md");
    mkdirSync(geminiDir, { recursive: true });

    let gemExisting = "";
    try { gemExisting = readFileSync(geminiMdPath, "utf8"); } catch {}

    const gemUpdated = injectSection(gemExisting, getClaudeMdContent());
    if (gemUpdated !== gemExisting) {
      writeFileSync(geminiMdPath, gemUpdated);
      console.log(`  ✓ DevGlide instructions installed in ${geminiMdPath}`);
    } else {
      console.log(`  ✓ DevGlide instructions already up to date in ${geminiMdPath}`);
    }
  }

  console.log("\n  Setup complete!\n");
}

function runTeardown() {
  console.log("\n  Tearing down DevGlide...\n");

  const validNames = new Set(Object.keys(mcpServers).map((n) => `devglide-${n}`));

  // Remove known MCP server registrations
  for (const name of Object.keys(mcpServers)) {
    const mcpName = `devglide-${name}`;
    try {
      execSync(`claude mcp remove ${mcpName} --scope user`, { stdio: "pipe" });
      console.log(`  ✓ ${mcpName} removed`);
    } catch {
      console.log(`  - ${mcpName} was not registered`);
    }
  }

  // Remove any stale devglide or devglide-* servers not in the current map
  try {
    const out = execSync("claude mcp list --scope user", { stdio: "pipe", encoding: "utf8" });
    const registered = out.match(/devglide(?:-[\w-]+)?/g) || [];
    for (const name of registered) {
      if (!validNames.has(name)) {
        try {
          execSync(`claude mcp remove ${name} --scope user`, { stdio: "pipe" });
          console.log(`  ✓ ${name} removed (stale)`);
        } catch { /* ignore */ }
      }
    }
  } catch {
    // claude mcp list not available — skip
  }

  // Clean Codex config
  if (detectCodex()) {
    try {
      const toml = readFileSync(codexConfigPath, "utf8");
      const cleaned = removeDevglideSectionsFromToml(toml);
      if (cleaned.trimEnd() !== toml.trimEnd()) {
        writeFileSync(codexConfigPath, cleaned);
        console.log("  ✓ Removed devglide servers from Codex config");
      } else {
        console.log("  - No devglide servers found in Codex config");
      }
    } catch {
      // config.toml doesn't exist or unreadable — skip
    }
  }

  // Clean Gemini settings.json
  if (detectGemini()) {
    try {
      if (removeGeminiMcpServers()) {
        console.log("  ✓ Removed devglide servers from Gemini settings");
      } else {
        console.log("  - No devglide servers found in Gemini settings");
      }
    } catch {
      // settings.json doesn't exist or unreadable
    }
  }

  // Clean up legacy ~/.claude/.mcp.json devglide entries
  const legacyMcpPath = resolve(homedir(), ".claude", ".mcp.json");
  try {
    const raw = readFileSync(legacyMcpPath, "utf8");
    const data = JSON.parse(raw);
    const servers = data.mcpServers || {};
    let changed = false;
    for (const name of Object.keys(servers)) {
      if (name.startsWith("devglide-")) {
        delete servers[name];
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(legacyMcpPath, JSON.stringify(data, null, 2) + "\n");
      console.log(`  ✓ Cleaned stale entries from ${legacyMcpPath}`);
    }
  } catch {
    // file doesn't exist or not parseable — fine
  }

  // Remove managed CLAUDE.md section
  const claudeMdPath = resolve(homedir(), ".claude", "CLAUDE.md");
  try {
    const existing = readFileSync(claudeMdPath, "utf8");
    const updated = removeSection(existing);
    if (updated !== existing) {
      if (updated.trim().length === 0) {
        unlinkSync(claudeMdPath);
        console.log(`\n  ✓ Removed ${claudeMdPath} (was empty)`);
      } else {
        writeFileSync(claudeMdPath, updated);
        console.log(`\n  ✓ DevGlide instructions removed from ${claudeMdPath}`);
      }
    } else {
      console.log(`\n  - No DevGlide instructions found in ${claudeMdPath}`);
    }
  } catch {
    console.log(`\n  - ${claudeMdPath} not found`);
  }

  // Remove managed GEMINI.md section
  if (detectGemini()) {
    const geminiMdPath = resolve(homedir(), ".gemini", "GEMINI.md");
    try {
      const gemExisting = readFileSync(geminiMdPath, "utf8");
      const gemUpdated = removeSection(gemExisting);
      if (gemUpdated !== gemExisting) {
        if (gemUpdated.trim().length === 0) {
          unlinkSync(geminiMdPath);
          console.log(`  ✓ Removed ${geminiMdPath} (was empty)`);
        } else {
          writeFileSync(geminiMdPath, gemUpdated);
          console.log(`  ✓ DevGlide instructions removed from ${geminiMdPath}`);
        }
      } else {
        console.log(`  - No DevGlide instructions found in ${geminiMdPath}`);
      }
    } catch {
      // GEMINI.md doesn't exist
    }
  }

  console.log("\n  Teardown complete!\n");
}

function usage() {
  console.log(`
  devglide — development workflow toolkit

  Usage:
    devglide start           Start server as background daemon
    devglide stop            Stop server
    devglide restart         Restart server
    devglide dev             Run server in foreground (recommended for development)
    devglide status          Show running status
    devglide logs            Tail server logs
    devglide mcp <server>    Launch a single MCP server on stdio
    devglide setup           Register MCP servers + install CLAUDE.md instructions
    devglide teardown        Unregister MCP servers + remove CLAUDE.md instructions

  Server:
    All apps on :${SERVER_PORT} (single process)

  MCP servers:
${Object.keys(mcpServers).map((name) => `    ${name}`).join("\n")}

  State: ~/.devglide/  (pids, logs)
`);
}

switch (command) {
  case "dev":
    startServer(true).catch((err) => { console.error(err); process.exitCode = 1; });
    break;

  case "start":
  case "server":
    if (args[0] === "stop") {
      stopServer();
    } else {
      startServer(command === "dev").catch((err) => { console.error(err); process.exitCode = 1; });
    }
    break;

  case "stop":
    stopServer();
    break;

  case "restart":
    // Wait for the old process to actually exit (and release the port) before
    // starting the new one, otherwise startServer can hit EADDRINUSE.
    (async () => {
      await stopServer();
      await startServer(false);
    })().catch((err) => { console.error(err); process.exitCode = 1; });
    break;

  case "status":
    showStatus();
    break;

  case "logs":
    tailLogs("server");
    break;

  case "list":
    console.log("\nMCP servers:\n");
    for (const name of Object.keys(mcpServers)) {
      console.log(`  ${name}`);
    }
    console.log();
    break;

  case "mcp": {
    if (!args[0]) {
      console.error(`Usage: devglide mcp <server>\nAvailable: ${Object.keys(mcpServers).join(", ")}`);
      process.exit(1);
    }
    runMcpServer(args[0]);
    break;
  }

  case "setup":
    runSetup();
    break;

  case "teardown":
    runTeardown();
    break;

  case "help":
  case "--help":
  case "-h":
  case undefined:
    usage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
