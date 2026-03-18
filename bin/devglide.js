#!/usr/bin/env node

import { spawn, execSync, spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, openSync, closeSync } from "fs";

import { homedir } from "os";

import { getClaudeMdContent, injectSection, removeSection } from "./claude-md-template.js";

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
};

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

    const child = spawn(tsxBin, [entry, "--stdio"], {
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

function startServer(foreground = false) {
  const { running, pid } = getStatus("server");
  if (running) {
    console.log(`  server already running (pid ${pid})`);
    return;
  }

  const tsxBin = resolve(root, "node_modules/.bin/tsx");
  if (!existsSync(tsxBin)) {
    console.error("tsx not found. Run 'pnpm install' first.");
    process.exit(1);
  }

  if (foreground) {
    const child = spawn(tsxBin, ["src/server.ts"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PORT: String(SERVER_PORT) },
      shell: true,
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  // Background daemon
  const logFile = resolve(logDir, "server.log");
  const out = openSync(logFile, "a");
  const child = spawn(tsxBin, ["src/server.ts"], {
    cwd: root,
    stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(SERVER_PORT) },
    detached: true,
    shell: true,
  });
  savePid("server", child.pid);
  child.unref();
  closeSync(out);
  console.log(`  server started on :${SERVER_PORT} (pid ${child.pid})`);
}

function killTree(pid, signal) {
  if (process.platform === 'win32') {
    // On Windows, taskkill /T kills the entire process tree
    const flag = signal === 'SIGKILL' ? '/F' : '/F';
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    // On Unix, negative PID kills the process group
    try { process.kill(-pid, signal); } catch {
      try { process.kill(pid, signal); } catch {}
    }
  }
}

function stopServer() {
  const { running, pid } = getStatus("server");
  if (!running) {
    console.log("  server not running");
    return;
  }
  killTree(pid, "SIGTERM");
  setTimeout(() => {
    if (isRunning(pid)) killTree(pid, "SIGKILL");
  }, 5000).unref();
  removePid("server");
  console.log(`  server stopped (was pid ${pid})`);
}

// --- Setup ---

function runSetup() {
  console.log("\n  Setting up DevGlide...\n");

  // Build MCP bundles first
  const buildScript = resolve(root, "scripts/build-mcp.mjs");
  if (existsSync(buildScript)) {
    console.log("  Building MCP bundles...\n");
    try {
      execSync(`${process.execPath} ${buildScript}`, { cwd: root, stdio: "inherit" });
      console.log();
    } catch {
      console.error("  ✗ Bundle build failed — falling back to tsx registration\n");
    }
  }

  console.log("  Registering MCP servers in Claude Code...\n");

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
          `claude mcp add --transport stdio ${mcpName} --scope user -- ${process.execPath} ${bundle} --stdio`,
          { stdio: "inherit" }
        );
      } else {
        // Fallback: register via devglide.js mcp launcher
        const devglideBin = resolve(__dirname, "devglide.js");
        execSync(
          `claude mcp add --transport stdio ${mcpName} --scope user -- ${process.execPath} ${devglideBin} mcp ${name}`,
          { stdio: "inherit" }
        );
      }
      console.log(`  ✓ ${mcpName} registered${useBundle ? " (bundled)" : " (tsx fallback)"}`);
    } catch {
      console.error(`  ✗ ${mcpName} failed to register`);
      failed = true;
    }
  }

  if (failed) {
    console.error("\n  Some servers failed to register. Is Claude Code (CLI) installed?");
    process.exit(1);
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

  console.log("\n  Setup complete!\n");
}

function runTeardown() {
  console.log("\n  Tearing down DevGlide...\n");

  // Remove MCP server registrations
  for (const name of Object.keys(mcpServers)) {
    const mcpName = `devglide-${name}`;
    try {
      execSync(`claude mcp remove ${mcpName} --scope user`, { stdio: "pipe" });
      console.log(`  ✓ ${mcpName} removed`);
    } catch {
      console.log(`  - ${mcpName} was not registered`);
    }
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
    startServer(true);
    break;

  case "start":
  case "server":
    if (args[0] === "stop") {
      stopServer();
    } else {
      startServer(command === "dev");
    }
    break;

  case "stop":
    stopServer();
    break;

  case "restart":
    stopServer();
    // Brief wait for port to free
    setTimeout(() => startServer(false), 1000);
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
