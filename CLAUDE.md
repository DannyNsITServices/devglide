# DevGlide — Developer Guide

## Architecture

Monorepo managed with **pnpm workspaces** and **Turborepo**.

- `src/apps/` — individual apps (kanban, shell, test, workflow, etc.), each exposing an MCP server
- `src/packages/` — shared libraries
- `src/server.ts` — unified HTTP server that mounts all apps on a single port (:7000)
- `src/routers/` — Express routers that mount each app's routes under `/api/<name>`
- `bin/devglide.js` — CLI entry point (start/stop servers, MCP launcher, setup/teardown)
- `bin/claude-md-template.js` — managed CLAUDE.md section for end-user onboarding

## Terminology

- **Dashboard** — the web UI (served on the HTTP port) with the sidebar menu layout.
  All apps/features render within it. It is the container, not an app itself.
- **Shell** — the MCP server for terminal pane management (`shell_create_pane`,
  `shell_run_command`, etc.). Panes are ephemeral and in-memory.
- **Apps** — individual features (kanban, voice, test, workflow, etc.) that each
  expose both REST routes (mounted by the dashboard) and an MCP server (stdio).

## MCP Server Pattern

Each app in `src/apps/<name>/` exports an MCP server created via the `createDevglideMcpServer` factory.
Per-server instructions live in each app's own code (tool descriptions, server instructions).
Cross-cutting instructions (orchestration rules, priority behaviors) live in `bin/claude-md-template.js`
and get installed into the user's `~/.claude/CLAUDE.md` by `devglide setup`.

MCP servers are bundled into single-file ESM bundles at `dist/mcp/<name>.mjs` via
`scripts/build-mcp.mjs`. The CLI prefers the pre-built bundle; falls back to `tsx`
for dev. After changing app source, run `node scripts/build-mcp.mjs` to rebuild bundles.

## Key Commands

```bash
pnpm install              # install all dependencies
pnpm build                # type-check all packages (noEmit — no JS output)
pnpm dev                  # run all apps in dev mode (turbo)
devglide dev              # run unified server in foreground
devglide setup            # register MCP servers + install CLAUDE.md instructions
devglide teardown         # unregister MCP servers + remove CLAUDE.md instructions
devglide status           # show running processes
devglide mcp <name>       # launch a single MCP server on stdio
node scripts/build-mcp.mjs  # rebuild MCP bundles (required after source changes)
```

## State Directory

All runtime state lives in `~/.devglide/`. The directory structure:

```
~/.devglide/
├── projects.json              # project registry
├── projects/{projectId}/      # per-project data
│   ├── kanban.db              #   kanban SQLite database
│   ├── uploads/               #   kanban attachments
│   ├── scenarios.json         #   saved test scenarios
│   ├── logs/                  #   project log files
│   ├── workflows/             #   project-scoped workflows
│   ├── vocabulary/            #   project-scoped vocabulary
│   └── prompts/               #   project-scoped prompts
├── voice/                     # global voice config, history, stats
│   └── config.json
├── workflows/                 # global workflows
├── vocabulary/                # global vocabulary
├── prompts/                   # global prompts
├── logs/                      # server logs
└── pids/                      # daemon PID files
```

## Data Scoping Rules

Each app's data is scoped as **global**, **per-project**, or **hybrid**.
These rules are intentional — do not change an app's scoping without discussion.

### Global (shared across all projects)
| App | Path | Notes |
|-----|------|-------|
| **Voice** | `~/.devglide/voice/` | Config, history, stats. Like keymaps — not project-specific. |

### Per-project
| App | Path | Notes |
|-----|------|-------|
| **Kanban** | `projects/{id}/kanban.db` | SQLite DB + `uploads/` per project |
| **Test** | `projects/{id}/scenarios.json` | Saved test scenarios |
| **Log** | `projects/{id}/logs/` | Log file tailing scoped to active project |
| **Shell** | In-memory | Panes belong to a project session, no disk persistence |

### Hybrid (global + per-project overlay; per-project takes precedence)
| App | Path | Notes |
|-----|------|-------|
| **Workflow** | `~/.devglide/workflows/` + `projects/{id}/workflows/` | Project workflows override global |
| **Vocabulary** | `~/.devglide/vocabulary/` + `projects/{id}/vocabulary/` | Project terms overlay global |
| **Prompts** | `~/.devglide/prompts/` + `projects/{id}/prompts/` | Project prompts overlay global |

## Platform Notes

### Windows TTS Playback
On native Windows, TTS audio playback prefers `ffplay` or `mpv` (reliable cross-format
players) over `WMPlayer.OCX`, which is broken on some Windows 11 builds (stuck in
`playState 9`). The custom `playerCommand` config option (if set) takes highest priority
and must support MP3 format — `Media.SoundPlayer` is WAV-only and will silently fail.
