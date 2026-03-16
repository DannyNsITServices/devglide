# DevGlide — Developer Guide

## Architecture

Monorepo managed with **pnpm workspaces** and **Turborepo**.

- `src/apps/` — individual apps (kanban, shell, test, workflow, etc.), each exposing an MCP server
- `src/packages/` — shared libraries
- `src/server.ts` — unified HTTP server that mounts all apps on a single port (:7000)
- `bin/devglide.js` — CLI entry point (start/stop servers, MCP launcher, setup/teardown)
- `bin/claude-md-template.js` — managed CLAUDE.md section for end-user onboarding

## MCP Server Pattern

Each app in `src/apps/<name>/` exports an MCP server created via the `createDevglideMcpServer` factory.
Per-server instructions live in each app's own code (tool descriptions, server instructions).
Cross-cutting instructions (orchestration rules, priority behaviors) live in `bin/claude-md-template.js`
and get installed into the user's `~/.claude/CLAUDE.md` by `devglide setup`.

## Key Commands

```bash
pnpm install          # install all dependencies
pnpm build            # build all packages (design-tokens, etc.)
pnpm dev              # run all apps in dev mode (turbo)
devglide dev          # run unified server in foreground
devglide setup        # register MCP servers + install CLAUDE.md instructions
devglide teardown     # unregister MCP servers + remove CLAUDE.md instructions
devglide status       # show running processes
devglide mcp <name>   # launch a single MCP server on stdio
```

## State Directory

All runtime state lives in `~/.devglide/` (pids, logs, databases).
