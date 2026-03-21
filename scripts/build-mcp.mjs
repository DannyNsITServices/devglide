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
];

const external = ["better-sqlite3", "node-pty"];

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
