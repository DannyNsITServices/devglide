#!/usr/bin/env node

import { build } from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const servers = [
  "kanban",
  "voice",
  "log",
  "test",
  "shell",
  "workflow",
  "vocabulary",
  "prompts",
  "chat",
  "documentation",
];

// Native / optional packages must not be inlined by esbuild. nodejs-whisper pulls in
// whisper.cpp and is an optional STT dependency that may be absent or fail to install;
// the voice provider imports it lazily and degrades gracefully at runtime. Bundling it
// makes the build fail with "Could not resolve 'nodejs-whisper'" when it is not present —
// and even when present, its CJS code references __dirname (undefined in ESM bundle
// scope) and resolves its whisper.cpp tree relative to its own install location.
const external = ["better-sqlite3", "node-pty", "nodejs-whisper"];

// CJS packages bundled into ESM need a real require() for Node built-ins
const banner = `import { createRequire as __bundleCR } from "module"; const require = __bundleCR(import.meta.url);`;

console.log("Building MCP server bundles...\n");

for (const name of servers) {
  const entryPoint = resolve(root, `src/apps/${name}/src/index.ts`);
  const outfile = resolve(root, `dist/mcp/${name}.mjs`);

  try {
    await build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: true,
      external,
      banner: { js: banner },
      logLevel: "warning",
    });
    console.log(`  ✓ ${name} → dist/mcp/${name}.mjs`);
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err.message);
    process.exit(1);
  }
}

console.log("\nAll MCP bundles built successfully.");
