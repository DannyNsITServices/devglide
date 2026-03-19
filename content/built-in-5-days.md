# I Built a 10-App MCP Developer Toolkit in 4 Days with Claude Code

> 50,000 lines of code. 56 MCP tools. 8 servers. 10 integrated modules. 32 pull requests. One AI coding assistant. Four days.

I'm a developer who builds tools. Last week I shipped [DevGlide](https://github.com/DannyNsITServices/devglide) — a modular developer environment that gives Claude Code project management, browser testing, workflow automation, a terminal multiplexer, speech-to-text, and more. All through the Model Context Protocol.

This is the story of how it came together.

---

## The Problem

Claude Code is remarkably capable in a terminal. But a terminal is all it has. When I started using it seriously for project work, I kept hitting the same friction points:

- **No persistent task tracking.** Claude can't remember what it was working on between sessions. I'd re-explain context every time.
- **No visual feedback.** Tests pass or fail in text. Logs scroll by. There's no dashboard to glance at.
- **No process memory.** I'd describe the same deploy workflow repeatedly. There was no way to save and reuse it.
- **No voice.** I talk faster than I type. There was no way to speak to Claude Code.

I wanted to give Claude **eyes, hands, and memory** — visual tools it could control through MCP, the Model Context Protocol that Anthropic designed for exactly this kind of integration.

## The Architecture Decision

Before writing a line of code, I made three bets:

### Bet 1: MCP over custom APIs

MCP is the standard protocol for connecting AI models to external tools. Instead of building a bespoke integration, I built MCP servers. This means DevGlide works with any MCP-compatible client — Claude Code today, but potentially any AI IDE tomorrow.

Each module exposes its own stdio MCP server. `devglide setup` registers all 8 with Claude Code in one command. The same tools are available via REST on the unified HTTP server, so the browser dashboard and Claude share state in real time.

### Bet 2: Monorepo with Turborepo

Ten apps, shared packages, a CLI, MCP bundles, and a unified server — this needs a monorepo. I chose pnpm workspaces with Turborepo for task orchestration. Each app lives in `src/apps/<name>/` with its own `package.json`, MCP server, REST routes, and public assets.

The MCP servers are bundled into single-file ESM bundles via a custom esbuild script. The CLI prefers pre-built bundles; falls back to `tsx` for dev. This cuts the process count from 3 per server to 1.

### Bet 3: Vanilla JS over React

Controversial? Maybe. But the dashboard is a straightforward SPA — sidebar navigation, page modules with `mount()`/`unmount()` lifecycle, Socket.io for real-time updates. React would have added a build step, a virtual DOM, and 40KB of runtime for what amounts to templated HTML and event listeners.

Every page module is a plain ES module. No JSX, no bundler, no source maps to debug. The browser loads exactly what I wrote. When something breaks, I open DevTools and I'm looking at my code, not framework internals.

## Day by Day

### Day 1 (March 16): Foundation

The initial commit landed with the core architecture already in place — the unified HTTP server, the SPA dashboard shell, the MCP server factory pattern, and the first batch of modules: **Kanban**, **Shell**, **Test**, **Log**, and **Coder**.

The Kanban module alone ships 15 MCP tools: features, items, columns, work logs, review feedback. Claude can pick up a task, move it to "In Progress," implement the fix, append a work log, and move it to "In Review" — all without me touching the board.

The Shell module is a full terminal multiplexer with xterm.js, PTY emulation (via node-pty), and 200KB scrollback per pane. Claude creates panes, runs commands, reads output, and manages sessions. All state survives page navigation.

### Day 2 (March 17): Polish and Patterns

Data storage got centralized under `~/.devglide/projects/{projectId}/`. The scenario runner learned to use SPA navigation instead of page refreshes. MCP servers were bundled into single-file ESM builds to reduce process overhead.

REST API parity was added — every MCP tool is also available via HTTP. The CLAUDE.md template was refined so Claude understands the entire toolkit from the first message of a conversation.

Six pull requests merged on day 2. The pattern was already clear: write code, open PR, merge, ship.

### Day 3 (March 18): Voice and the Hard Platform Problems

This was the most technically dense day. **Voice** went from a simple STT wrapper to a full speech platform:

- **Speech-to-text** with pluggable providers (OpenAI, Groq, local whisper.cpp, VLLM)
- **Neural text-to-speech** via msedge-tts with chunked playback for long text
- **Transcription history** with text analysis (WPM, filler words, word count)
- **Auto-download** of prebuilt whisper-cli binaries on Windows; build from source on macOS/Linux

The TTS system alone required solving half a dozen platform-specific problems: WSLg PulseAudio routing, WPF MediaPlayer fallback for Windows 11 builds where WMPlayer.OCX is broken, audio buffer configuration to prevent first-word clipping, and process-level error handlers to prevent stray WebSocket exceptions from crashing the MCP stdio connection.

Twenty commits in one day, most of them fixing edge cases across WSL, native Windows, macOS, and Linux.

### Day 4 (March 19): Design System, Keyboard UX, and Final Polish

The final push focused on developer experience:

- **Style Guide v3** — A complete design token system using OKLCH color space, a shared component library (`components.css`), and an auto-generated living styleguide. 156 tokens (39 primitive + 117 semantic) plus 48 OKLCH variables.
- **Keyboard project switcher** — Press `Ctrl+Alt+P` to open a VS Code-style quick-pick popup. Navigate with arrows, select with Enter, dismiss with Escape. Zero mouse required.
- **Workflow and Vocabulary** modules were refined with on-demand triggering and hybrid scoping (global + per-project overlays).
- **Documentation alignment** — Every tool count, port reference, and feature description was audited against the actual source code.
- **Drag-and-drop persistence** — Terminal pane reorder now survives page navigation (both server-side state and client-side Map ordering).

Twelve pull requests merged on day 4 alone.

## Technical Deep Dives

### The MCP Server Pattern

Every app follows the same factory pattern:

```javascript
import { createDevglideMcpServer } from '../../packages/mcp-factory.js';

const server = createDevglideMcpServer('voice', {
  instructions: '...',  // LLM-readable docs
});

server.tool('voice_speak', { text: z.string() }, async ({ text }) => {
  await speak(text);
  return { ok: true };
});
```

The factory handles stdio transport, project context injection, and error boundaries. Each server is bundled into a single `.mjs` file for deployment. The CLI launches them as child processes.

### Terminal Multiplexer Architecture

The Shell module maintains a global state that survives individual socket disconnects:

- **`globalPtys`** — Map of pane ID to PTY process + scrollback buffer
- **`dashboardState`** — Ordered list of panes, active tab, active pane
- **Multi-client resize arbitration** — Each PTY tracks which socket last sent input. Only that socket's resize events reach the PTY, preventing SIGWINCH corruption when multiple browser tabs are open.

When a client connects, it receives a full state snapshot with scrollback. When it reconnects (SPA navigation), pane elements are detached from the DOM but kept alive in memory. The Map insertion order determines reattach order — which is why drag-and-drop reorder had to update both the server state array and the client-side JavaScript Map.

### PulseAudio Sink Wake-Up Problem

The most obscure bug: TTS audio clips the first words on WSL. After investigation, the root cause is PulseAudio's `module-suspend-on-idle` — it suspends the WSLg RDP audio sink after inactivity. When new audio starts, the sink needs ~200-500ms to wake up, and those first milliseconds of speech are lost.

The fix: use ffmpeg's `adelay` filter to prepend 300ms of silence to every MP3 before playback. Simple, portable, and invisible to the user.

## What Claude Code Did Well

Let me be direct about Claude's role. I designed the architecture, made the technology choices, and directed every feature. Claude wrote the bulk of the implementation code under my supervision.

**Where Claude excelled:**
- **Boilerplate elimination.** Socket.io event handlers, Express routes, CSS layouts — Claude produces these fluently.
- **Cross-platform edge cases.** Given a failing WSL audio scenario, Claude systematically tested PulseAudio, fallback players, and path conversion until it worked.
- **Refactoring at scale.** "Move all voice config from per-project to global" touched 8 files. Claude did it correctly in one pass.
- **Documentation.** The CLAUDE.md template, MCP server instructions, and API reference tables were generated accurately from the source.

**Where I had to intervene:**
- **Architecture.** Claude doesn't naturally reach for the simplest solution. I had to push back on over-engineering repeatedly.
- **Bug diagnosis.** The drag-and-drop persistence bug required understanding that JavaScript Maps preserve insertion order and that the SPA remount iterates the Map. Claude found the server fix but missed the client-side Map ordering.
- **Design taste.** CSS spacing, animation curves, color choices — these need a human eye.

## The Numbers

| Metric | Value |
|--------|-------|
| Total development time | 4 days |
| Lines of code | ~50,000 |
| MCP tools | 56 |
| MCP servers | 8 |
| App modules | 10 |
| Pull requests | 32 |
| Non-merge commits | 73 |
| npm releases | 4 (v0.1.14 → v0.1.17) |
| Design tokens | 156 + 48 OKLCH |
| Platforms tested | WSL2, Windows, macOS, Linux |

## Lessons Learned

**1. MCP is ready for production tooling.** The protocol is simple, the stdio transport is reliable, and the tool calling pattern maps naturally to developer workflows. If you're building AI integrations, MCP should be your first choice.

**2. AI-assisted development is a multiplier, not a replacement.** Claude Code let me ship 4 days of work that would have taken 3-4 weeks solo. But every hour of Claude writing code required 15-20 minutes of me reviewing, redirecting, and occasionally rewriting. The ratio matters.

**3. Vanilla JS is underrated for dashboards.** No build step, no framework upgrades, no dependency vulnerabilities. The SPA pattern with `mount()`/`unmount()` lifecycle is clean and fast. The entire dashboard loads in under 200ms.

**4. Platform bugs are the real time sink.** The voice module alone required solving WSLg PulseAudio routing, Windows WPF MediaPlayer fallback, whisper.cpp cross-compilation, and MP3 silence padding. These aren't coding problems — they're systems problems that require deep platform knowledge.

**5. Ship the signal, not the artifact.** DevGlide's value isn't in the code — it's in what the code proves you can do. A working MCP toolkit that solves real problems demonstrates more than any resume bullet point.

---

## Try It

```bash
npm install -g devglide
devglide setup
devglide start
```

That's it. Three commands, and Claude Code has 56 new tools.

[GitHub](https://github.com/DannyNsITServices/devglide) | [npm](https://www.npmjs.com/package/devglide)

---

*Built by [Daniel Kutyla](https://github.com/DannyNsITServices) with Claude Code. March 2026.*
