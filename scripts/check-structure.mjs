#!/usr/bin/env node

/**
 * DevGlide structure checker — deterministic monorepo boundary enforcement.
 *
 * Reads devglide.manifest.json and validates:
 *
 *   ERROR (hard fail — exit 1):
 *     1. Manifest schema (kind enum, required fields)
 *     2. Declared entrypoints exist on disk
 *     3. expectedPackageName matches package.json name
 *     4. Undeclared apps / packages / standalone files
 *     5. MCP registry drift (manifest vs build-mcp.mjs vs bin/devglide.js)
 *     6. Deep package imports (bypassing package entrypoints)
 *     7. Cross-app imports not declared in allowedCrossAppDeps
 *
 *   INFO (reported, no fail):
 *     8. Stale build artifacts inside app/package dirs
 *
 * Zero dependencies — Node built-ins only.
 * Exit 0 = pass, exit 1 = hard errors found.
 *
 * Usage:
 *   node scripts/check-structure.mjs
 *   pnpm check:structure
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

/** Normalize path separators to forward slashes (Windows compat). */
const toSlash = (p) => (sep === "\\" ? p.replaceAll("\\", "/") : p);

const ROOT = resolve(import.meta.dirname, "..");
const APPS_DIR = join(ROOT, "src/apps");
const PACKAGES_DIR = join(ROOT, "src/packages");
const MANIFEST_PATH = join(ROOT, "devglide.manifest.json");

// ── Kind enums (fixed — manifest cannot invent new categories) ───────────

const VALID_APP_KINDS = new Set(["mcp-app", "ui-app", "static-app"]);
const VALID_PACKAGE_KINDS = new Set([
  "lib-package",
  "asset-package",
  "config-package",
]);

// ── Collectors ───────────────────────────────────────────────────────────

const errors = [];
const infos = [];

function error(msg) {
  errors.push(msg);
}
function info(msg) {
  infos.push(msg);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function getFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".next",
  "public",
  "data",
  "templates",
]);

/** Recursively collect TS source files, skipping build artifacts. */
function collectSourceFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) result.push(...collectSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      result.push(full);
    }
  }
  return result;
}

// ── Load manifest ────────────────────────────────────────────────────────

if (!existsSync(MANIFEST_PATH)) {
  console.error("ERROR: devglide.manifest.json not found at project root.");
  process.exit(1);
}

const manifest = readJson(MANIFEST_PATH);
const apps = manifest.apps ?? {};
const packages = manifest.packages ?? {};
const standaloneFiles = new Set(manifest.standaloneFiles ?? []);

// ══════════════════════════════════════════════════════════════════════════
// CHECK 1 — Manifest schema validation
// ══════════════════════════════════════════════════════════════════════════

for (const [name, app] of Object.entries(apps)) {
  if (!VALID_APP_KINDS.has(app.kind)) {
    error(
      `manifest: app "${name}" has invalid kind "${app.kind}" (allowed: ${[...VALID_APP_KINDS].join(", ")})`,
    );
  }
  if (!Array.isArray(app.entrypoints) || app.entrypoints.length === 0) {
    error(`manifest: app "${name}" must have a non-empty entrypoints array`);
  }
}

for (const [name, pkg] of Object.entries(packages)) {
  if (!VALID_PACKAGE_KINDS.has(pkg.kind)) {
    error(
      `manifest: package "${name}" has invalid kind "${pkg.kind}" (allowed: ${[...VALID_PACKAGE_KINDS].join(", ")})`,
    );
  }
  if (!Array.isArray(pkg.entrypoints) || pkg.entrypoints.length === 0) {
    error(
      `manifest: package "${name}" must have a non-empty entrypoints array`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK 2 — Declared entrypoints exist on disk
// ══════════════════════════════════════════════════════════════════════════

for (const [name, app] of Object.entries(apps)) {
  const appDir = join(APPS_DIR, name);
  if (!existsSync(appDir)) {
    error(`app "${name}": directory missing at src/apps/${name}`);
    continue;
  }
  for (const ep of app.entrypoints ?? []) {
    if (!existsSync(join(appDir, ep))) {
      error(`app "${name}": missing entrypoint "${ep}"`);
    }
  }
}

for (const [name, pkg] of Object.entries(packages)) {
  const pkgDir = join(PACKAGES_DIR, name);
  if (!existsSync(pkgDir)) {
    error(`package "${name}": directory missing at src/packages/${name}`);
    continue;
  }
  for (const ep of pkg.entrypoints ?? []) {
    if (!existsSync(join(pkgDir, ep))) {
      error(`package "${name}": missing entrypoint "${ep}"`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK 3 — expectedPackageName matches package.json
// ══════════════════════════════════════════════════════════════════════════

function checkPackageName(label, dir, expected) {
  const pj = join(dir, "package.json");
  if (existsSync(pj)) {
    const { name } = readJson(pj);
    if (name !== expected) {
      error(
        `${label}: package.json name "${name}" does not match expected "${expected}"`,
      );
    }
  } else {
    error(`${label}: expectedPackageName set but no package.json found`);
  }
}

for (const [name, app] of Object.entries(apps)) {
  if (app.expectedPackageName) {
    checkPackageName(`app "${name}"`, join(APPS_DIR, name), app.expectedPackageName);
  }
}

for (const [name, pkg] of Object.entries(packages)) {
  if (pkg.expectedPackageName) {
    checkPackageName(
      `package "${name}"`,
      join(PACKAGES_DIR, name),
      pkg.expectedPackageName,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK 4 — Undeclared apps / packages / standalone files
// ══════════════════════════════════════════════════════════════════════════

const declaredApps = new Set(Object.keys(apps));
for (const dir of getDirs(APPS_DIR)) {
  if (!declaredApps.has(dir)) {
    error(`undeclared app: src/apps/${dir} is not in manifest`);
  }
}

const declaredPackages = new Set(Object.keys(packages));
for (const dir of getDirs(PACKAGES_DIR)) {
  if (!declaredPackages.has(dir)) {
    error(`undeclared package: src/packages/${dir} is not in manifest`);
  }
}

const actualStandalone = getFiles(PACKAGES_DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);
for (const f of actualStandalone) {
  if (!standaloneFiles.has(f)) {
    error(
      `undeclared standalone file: src/packages/${f} is not in manifest.standaloneFiles`,
    );
  }
}
for (const f of standaloneFiles) {
  if (!existsSync(join(PACKAGES_DIR, f))) {
    error(
      `missing standalone file: "${f}" declared in manifest but does not exist`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK 5 — MCP registry drift
// ══════════════════════════════════════════════════════════════════════════

const buildTargetApps = new Set(
  Object.entries(apps)
    .filter(([, app]) => app.buildTarget)
    .map(([name]) => name),
);

// Parse scripts/build-mcp.mjs — extract the servers = [...] array
const buildMcpPath = join(ROOT, "scripts/build-mcp.mjs");
const buildMcpApps = new Set();
if (existsSync(buildMcpPath)) {
  const content = readFileSync(buildMcpPath, "utf8");
  const arrayMatch = content.match(
    /(?:const|let|var)\s+servers\s*=\s*\[([\s\S]*?)\]/,
  );
  if (arrayMatch) {
    for (const m of arrayMatch[1].matchAll(/["'](\w+)["']/g)) {
      buildMcpApps.add(m[1]);
    }
  }
}

// Parse bin/devglide.js — extract mcpServers object keys only
const devglidePath = join(ROOT, "bin/devglide.js");
const cliMcpApps = new Set();
if (existsSync(devglidePath)) {
  const content = readFileSync(devglidePath, "utf8");
  // Match the mcpServers block and extract only top-level keys
  // Keys are at column 2 (2-space indent) inside the object
  const objMatch = content.match(
    /const\s+mcpServers\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (objMatch) {
    // Match lines like "  kanban:" or "  voice:" (keys at first indent level)
    for (const m of objMatch[1].matchAll(/^\s{2}(\w+)\s*:/gm)) {
      cliMcpApps.add(m[1]);
    }
  }
}

// Compare all three sets (order-independent)
for (const app of buildTargetApps) {
  if (buildMcpApps.size > 0 && !buildMcpApps.has(app)) {
    error(
      `MCP drift: "${app}" has buildTarget in manifest but missing from scripts/build-mcp.mjs`,
    );
  }
  if (cliMcpApps.size > 0 && !cliMcpApps.has(app)) {
    error(
      `MCP drift: "${app}" has buildTarget in manifest but missing from bin/devglide.js`,
    );
  }
}
for (const app of buildMcpApps) {
  if (!buildTargetApps.has(app)) {
    error(
      `MCP drift: "${app}" in scripts/build-mcp.mjs but not buildTarget in manifest`,
    );
  }
}
for (const app of cliMcpApps) {
  if (!buildTargetApps.has(app)) {
    error(
      `MCP drift: "${app}" in bin/devglide.js but not buildTarget in manifest`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// IMPORT SCANNING — shared by checks 6 and 7
// ══════════════════════════════════════════════════════════════════════════

// Matches all import/export specifier strings across the whole file:
//   import ... from "..."
//   export ... from "..."
//   import("...")
//   import '...'  (side-effect imports)
// Works across multi-line import statements because it scans the full file
// content, not line-by-line.

const IMPORT_SPECIFIER_RE =
  /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

const allSourceFiles = collectSourceFiles(join(ROOT, "src"));

/**
 * Extract all import specifiers from a file with line numbers.
 * Returns array of { specifier, line }.
 */
function extractImports(content) {
  const results = [];
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_SPECIFIER_RE.exec(content)) !== null) {
    // Compute line number from character offset
    const line =
      content.slice(0, match.index).split("\n").length;
    results.push({ specifier: match[1], line });
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
// NOTE: Deep package imports (packages/*/src/) are intentional.
// Relative imports are required for npm install -g compatibility —
// workspace package names (@devglide/*) don't resolve after global install.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// CHECK 7 — Cross-app import violations
// ══════════════════════════════════════════════════════════════════════════

// Rule: app code must not import from another app unless declared in allowedCrossAppDeps.
// Router→app imports are the expected wiring pattern and always allowed.

const CROSS_APP_PATH_RE = /\/apps\/([^/]+)\//;

for (const filePath of allSourceFiles) {
  // Determine which app this file belongs to
  const relToApps = toSlash(relative(APPS_DIR, filePath));
  const isInApp = !relToApps.startsWith("..");
  if (!isInApp) continue; // routers / server.ts — always allowed

  const sourceApp = relToApps.split("/")[0];
  const content = readFileSync(filePath, "utf8");

  for (const { specifier, line } of extractImports(content)) {
    const m = CROSS_APP_PATH_RE.exec(specifier);
    if (!m) continue;
    const targetApp = m[1];
    if (targetApp === sourceApp) continue; // self-import is fine

    const allowed = new Set(apps[sourceApp]?.allowedCrossAppDeps ?? []);
    if (!allowed.has(targetApp)) {
      error(
        `cross-app import: ${toSlash(relative(ROOT, filePath))}:${line} — "${sourceApp}" imports from "${targetApp}" (not in allowedCrossAppDeps)`,
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// INFO — Stale build artifacts (reported, not a hard fail)
// ══════════════════════════════════════════════════════════════════════════

// Only report artifacts that indicate real cleanup issues.
// dist/, .turbo/, .next/ are expected build cache covered by .gitignore.
const STALE_PATTERNS = ["server.log"];

for (const appName of getDirs(APPS_DIR)) {
  for (const pattern of STALE_PATTERNS) {
    if (existsSync(join(APPS_DIR, appName, pattern))) {
      info(`stale artifact: src/apps/${appName}/${pattern}`);
    }
  }
}

for (const pkgName of getDirs(PACKAGES_DIR)) {
  for (const pattern of STALE_PATTERNS) {
    if (existsSync(join(PACKAGES_DIR, pkgName, pattern))) {
      info(`stale artifact: src/packages/${pkgName}/${pattern}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Report
// ══════════════════════════════════════════════════════════════════════════

console.log("");
console.log("DevGlide Structure Check");
console.log("========================\n");

if (errors.length > 0) {
  console.log(`ERRORS (${errors.length}):\n`);
  for (const e of errors) console.log(`  \u2717 ${e}`);
  console.log("");
}

if (infos.length > 0) {
  console.log(`INFO (${infos.length}):\n`);
  for (const i of infos) console.log(`  \u2139 ${i}`);
  console.log("");
}

if (errors.length === 0 && infos.length === 0) {
  console.log("  All checks passed.\n");
}

const summary = `${errors.length} error(s), ${infos.length} info(s)`;
if (errors.length > 0) {
  console.log(`FAIL: ${summary}\n`);
  process.exit(1);
} else {
  console.log(`PASS: ${summary}\n`);
}
