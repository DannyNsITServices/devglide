# DevGlide — Developer Guide

## Architecture

Monorepo managed with **pnpm workspaces** and **Turborepo**.

- `src/apps/` — individual apps (kanban, shell, test, workflow, etc.), each exposing an MCP server
- `src/packages/` — shared libraries
- `src/server.ts` — unified HTTP server that mounts all apps on a single port (:7000, overridable via `DEVGLIDE_PORT`)
- `src/routers/` — Express routers that mount each app's routes under `/api/<name>`
- `bin/devglide.js` — CLI entry point (start/stop servers, MCP launcher, setup/teardown)
- `bin/claude-md-template.js` — managed CLAUDE.md section for end-user onboarding

## Terminology

- **Dashboard** — the web UI (served on the HTTP port) with the sidebar menu layout.
  All apps/features render within it. It is the container, not an app itself.
- **Shell** — the MCP server for terminal pane management (`shell_create_pane`,
  `shell_run_command`, etc.). Panes are ephemeral and in-memory.
- **Apps** — individual features (kanban, voice, test, workflow, chat, etc.) that each
  expose both REST routes (mounted by the dashboard) and an MCP server (stdio).
- **Chat** — the MCP server for multi-LLM communication (`chat_join`,
  `chat_send`, etc.). Participants and message delivery are in-memory;
  message history is persisted per-project as JSONL. `chat_join` requires
  an explicit `paneId`, which should be read from `DEVGLIDE_PANE_ID` in
  the shell session. The effective chat rules of engagement are returned
  on join and can be overridden per project.

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
devglide start            # start server as background daemon
devglide stop             # stop server
devglide restart          # restart server
devglide status           # show running processes
devglide logs             # tail server logs
devglide setup            # register MCP servers + install CLAUDE.md instructions
devglide teardown         # unregister MCP servers + remove CLAUDE.md instructions
devglide mcp <name>       # launch a single MCP server on stdio
devglide list             # list available MCP servers
node scripts/build-mcp.mjs  # rebuild MCP bundles (required after source changes)
```

Server port defaults to `:7000`, overridable via `DEVGLIDE_PORT` env var.

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
│   ├── prompts/               #   project-scoped prompts
│   └── chat/                  #   chat message history (messages.jsonl)
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
| **Chat** | `projects/{id}/chat/` | Message history (`messages.jsonl`) and rules override (`rules.md`) per project; participants are in-memory |

### Hybrid (global + per-project overlay; per-project takes precedence)
| App | Path | Notes |
|-----|------|-------|
| **Workflow** | `~/.devglide/workflows/` + `projects/{id}/workflows/` | Project workflows override global |
| **Vocabulary** | `~/.devglide/vocabulary/` + `projects/{id}/vocabulary/` | Project terms overlay global |
| **Prompts** | `~/.devglide/prompts/` + `projects/{id}/prompts/` | Project prompts overlay global |

## Platform Notes

### TTS Audio Playback

TTS uses msedge-tts (Microsoft Edge Read Aloud API) for MP3 generation. Long text
is automatically split into sentence chunks with pipelined generation + playback
(configurable via `chunkThreshold`, default 100 chars).

Audio playback precedence per platform:

| Platform | Preference |
|----------|------------|
| **WSL** | mpv/ffplay via WSLg PulseAudio → PowerShell WPF MediaPlayer |
| **Windows** | ffplay → mpv → PowerShell WPF MediaPlayer |
| **macOS** | afplay |
| **Linux** | mpv → ffplay |

If msedge-tts fails entirely, fallback to platform native TTS:
- **Windows/WSL:** PowerShell SAPI (`System.Speech.Synthesis.SpeechSynthesizer`)
- **macOS:** `say` command
- **Linux:** espeak-ng or spd-say

On native Windows, WPF MediaPlayer is used instead of `WMPlayer.OCX`, which is
broken on some Windows 11 builds (stuck in `playState 9`).

### Local Whisper (whisper.cpp)

The local STT provider uses whisper.cpp via the `nodejs-whisper` package:
- **Windows:** Prebuilt `whisper-cli` binary is auto-downloaded from GitHub releases (v1.8.3).
- **macOS/Linux:** Built from source via CMake (requires build tools).
- **All platforms:** Requires FFmpeg on PATH for audio conversion.
