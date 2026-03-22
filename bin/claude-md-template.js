// Managed CLAUDE.md section for DevGlide onboarding instructions.
// Installed by `devglide setup`, removed by `devglide teardown`.

const VERSION = "0.5.0";
const BEGIN = `<!-- DEVGLIDE:BEGIN v${VERSION} -->`;
const END = "<!-- DEVGLIDE:END -->";

export function getClaudeMdContent() {
  return `${BEGIN}
# DevGlide — AI Workflow Toolkit

DevGlide provides MCP (Model Context Protocol) tools for kanban boards, shell
automation, test runners, workflows, vocabulary, voice, prompts, and logging.
These tools are available to any LLM that supports MCP tool calling. Each tool
is prefixed with its server name (e.g. \`kanban_list_items\`, \`shell_run_command\`).
Follow the rules below so the tools work together correctly.

## Priority Rules (execute in order)

1. **Call \`workflow_match\`** only when the user's prompt explicitly contains the word "workflow".
   If a workflow matches, follow the returned instructions exactly.
2. **Call \`vocabulary_lookup\`** when you encounter unfamiliar or ambiguous terms
   that could be domain jargon, project names, or abbreviations.
3. **Update kanban status** when working on tracked tasks:
   - \`kanban_move_item\` → In Progress when starting work.
   - \`kanban_move_item\` → In Review or Testing when work is complete.
   - **Never** move items to Done — only the user can mark items as done.
4. **Append a work log** via \`kanban_append_work_log\` after completing work
   on any kanban task. Describe what was changed and verified.

## MCP Servers and Tools

### devglide-kanban — Task boards
Manage features (product initiatives) and their kanban items (tasks/bugs).
Columns: Backlog → Todo → In Progress → In Review → Testing → Done.
Item types: TASK, BUG. Priorities: LOW, MEDIUM, HIGH, URGENT.
- \`kanban_list_features\`, \`kanban_create_feature\`, \`kanban_get_feature\` — manage feature boards
- \`kanban_update_feature\`, \`kanban_delete_feature\` — update or remove features
- \`kanban_list_items\`, \`kanban_create_item\`, \`kanban_get_item\` — manage tasks/bugs
- \`kanban_update_item\`, \`kanban_delete_item\` — update or remove items
- \`kanban_move_item\` — change task status (column)
- \`kanban_append_work_log\`, \`kanban_get_work_log\` — record and read work log entries
- \`kanban_append_review\`, \`kanban_get_review_history\` — add and read review feedback

### devglide-workflow — Reusable workflow templates
- \`workflow_match\` — match a user prompt to an existing workflow (only when user mentions "workflow")
- \`workflow_list\`, \`workflow_get\` — browse and inspect workflows
- \`workflow_get_instructions\` — get compiled instructions from all enabled workflows
- \`workflow_create\`, \`workflow_toggle\` — create or enable/disable workflows

### devglide-shell — Terminal pane management
Run shell commands in managed terminal panes. Useful for builds, tests, and server management.
- \`shell_create_pane\` — open a new terminal pane
- \`shell_run_command\` — execute a command in a pane
- \`shell_get_scrollback\` — read terminal output
- \`shell_list_panes\`, \`shell_close_pane\` — manage panes

### devglide-test — AI-driven browser test automation
Describe what to test in natural language and scenarios are generated automatically.
- \`test_commands\` — list available browser automation commands
- \`test_list_saved\`, \`test_run_saved\` — list and run saved test scenarios
- \`test_run_scenario\` — run an ad-hoc test scenario
- \`test_save_scenario\`, \`test_delete_saved\` — save or delete a test scenario
- \`test_get_result\` — check test results

### devglide-vocabulary — Domain term dictionary
- \`vocabulary_lookup\` — expand a term by name or alias
- \`vocabulary_list\`, \`vocabulary_context\` — browse all terms
- \`vocabulary_add\`, \`vocabulary_update\`, \`vocabulary_remove\` — manage terms

### devglide-prompts — Prompt template library
- \`prompts_list\`, \`prompts_get\`, \`prompts_render\` — browse, inspect, and render prompt templates
- \`prompts_add\`, \`prompts_update\`, \`prompts_remove\` — manage templates
- \`prompts_context\` — get all prompts as compiled markdown for LLM context injection

### devglide-voice — Speech-to-text and text-to-speech
- \`voice_transcribe\` — transcribe audio (supports vocab biasing via \`prompt\`, \`cleanup\` mode for AI post-processing)
- \`voice_speak\` — speak text aloud (neural TTS, fire-and-forget). **Only use when the user explicitly asks to be notified** (e.g. "notify me once you're done", "tell me when it's ready", "speak", "say"). Do NOT speak proactively.
- \`voice_stop\` — stop current speech playback
- \`voice_history\` — list/search transcription history with text analysis (WPM, filler words). Default limit 25, max 100.
- \`voice_analytics\` — get aggregated transcription analytics
- \`voice_status\` — check transcription service status and statistics
- **STT providers:** openai, groq, local (whisper.cpp), whisper-cpp, faster-whisper, vllm, local-ai
- **Local whisper:** On Windows, prebuilt whisper-cli is auto-downloaded from GitHub releases. On macOS/Linux, built from source via CMake.
- **TTS engine:** msedge-tts (Microsoft Edge Read Aloud). Long text is automatically split into sentence chunks with pipelined generation + playback.
- **TTS config:** \`voice\`, \`edgeRate\`, \`edgePitch\`, \`volume\`, \`chunkThreshold\`, \`fallbackRate\`, \`enabled\` — configurable via dashboard.
- **TTS fallback chain:** If msedge-tts fails → PowerShell SAPI (Windows/WSL), \`say\` (macOS), espeak-ng/spd-say (Linux).
- **Audio playback:** WSL: mpv/ffplay via WSLg PulseAudio → PowerShell WPF MediaPlayer. Windows: ffplay → mpv → WPF MediaPlayer. macOS: afplay. Linux: mpv → ffplay.
- **AI text cleanup:** Configurable LLM provider/model for post-processing transcriptions (cleanup.provider, cleanup.model, cleanup.apiKey).
- **REST API** (base: \`/api/voice\`):
  - Transcribe: \`POST /transcribe\` body \`{ audioBase64, filename, language?, prompt?, mode? }\`
  - TTS: \`POST /config/tts/speak\` body \`{ text }\` · \`POST /config/tts/stop\` · \`GET /config/tts/voices\`
  - History: \`GET /history\` · \`GET /history/:id\` · \`GET /history/search?q=\` · \`GET /history/analytics\` · \`DELETE /history\`
  - Config: \`GET /config\` · \`GET /config/providers\` · \`PUT /config\` · \`POST /config/test\` · \`GET /config/check-ffmpeg\`
  - Stats: \`GET /config/stats\` · \`DELETE /config/stats\`

### devglide-chat — Multi-LLM chat room
Shared chat room where user and multiple LLM instances communicate via @mention addressing.
Messages are delivered to LLMs via PTY injection when linked to a shell pane.
- \`chat_join\` — register as a chat participant (requires explicit \`paneId\`)
- \`chat_leave\` — leave the chat room
- \`chat_send\` — send a message (delivery is broadcast within the project; @mentions signal intent)
- \`chat_read\` — read message history (supports \`limit\`, \`since\`, \`topic\` filters)
- \`chat_members\` — list active participants with pane link status
- **Name assignment:** The server assigns a unique memorable name (e.g. "ada", "bob"). Always use the \`name\` returned by \`chat_join\` — it may differ from what you requested.
- **Broadcast delivery:** All messages are broadcast to every participant in the project. @mentions are a semantic signal (who should act), not a delivery filter. The \`to\` parameter is ignored for LLM senders.
- **Rules of Engagement:** On \`chat_join\`, you receive a \`rules\` field (markdown) defining when to respond vs. stay silent. **Follow these rules exactly.** Default: reply if @mentioned, or explicitly claim a clearly defined part of a global user request before acting. Do not let multiple LLMs answer the same global request uncoordinated. Rules can be customized per project.
- **\`submitKey\`:** Use \`"cr"\` (default) for all known clients including Claude Code and Codex. The submit key is sent after a short delay to avoid paste-burst detection in TUI frameworks. Only use \`"lf"\` if you have verified a specific client requires it.
- **Topics:** Include \`#topic-name\` in your message to tag it. Use \`chat_read(topic: "name")\` to filter.
- **Pane linking:** A valid \`paneId\` is required to receive messages. Read \`DEVGLIDE_PANE_ID\` from your shell session and pass it explicitly to \`chat_join\` every time. The pane must also be live and routable by the shell backend or \`chat_join\` will fail. If the env var is unavailable, chat cannot be used from that session. If your pane closes, you are removed from chat.
- **Limitations:** You cannot message yourself; participants are in-memory (rejoin after server restart); only same-project participants see each other.
- **REST API** (base: \`/api/chat\`):
  - Join: \`POST /join\` body \`{ name, model?, paneId, submitKey? }\`
  - Leave: \`POST /leave\` body \`{ name }\`
  - Send: \`POST /send\` body \`{ from, message, to? }\`
  - Members: \`GET /members\`
  - Messages: \`GET /messages?limit=&since=&topic=\`
  - Rules: \`GET /rules\` | \`PUT /rules\` body \`{ rules }\` | \`DELETE /rules\`
  - Clear: \`DELETE /messages\`

### devglide-log — Structured logging
- \`log_write\` — write a structured log entry
- \`log_read\` — read log entries
- \`log_clear\`, \`log_clear_all\` — clear logs

## Common Patterns

### Creating a feature
1. \`kanban_create_feature\` — create the feature board
2. \`kanban_create_item\` — add tasks to the feature's Todo column
3. Start working on items one by one

### Starting work on a task
1. \`kanban_move_item\` to In Progress
3. Implement changes
4. \`kanban_append_work_log\` — record what was done
5. \`kanban_move_item\` to In Review or Testing

### Running tests
1. Describe what to test in natural language — Claude generates scenarios automatically
2. \`test_list_saved\` — see existing test scenarios
3. \`test_run_saved\` — run a saved scenario, or \`test_run_scenario\` for ad-hoc
4. \`test_get_result\` — check results
${END}`;
}

const SECTION_RE = new RegExp(
  `${escapeRegex("<!-- DEVGLIDE:BEGIN")}[^>]*-->[\\s\\S]*?${escapeRegex(END)}`,
);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns true if the managed section exists in content. */
export function hasSection(content) {
  return SECTION_RE.test(content);
}

/** Idempotent insert or replace of the managed section. */
export function injectSection(existingContent, newSection) {
  if (hasSection(existingContent)) {
    return existingContent.replace(SECTION_RE, newSection.trim());
  }
  // Append with separator
  const separator = existingContent.length > 0 && !existingContent.endsWith("\n\n")
    ? existingContent.endsWith("\n") ? "\n" : "\n\n"
    : "";
  return existingContent + separator + newSection.trim() + "\n";
}

/** Remove the managed section cleanly. */
export function removeSection(existingContent) {
  if (!hasSection(existingContent)) return existingContent;
  return existingContent
    .replace(SECTION_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + (existingContent.trim().length > 0 ? "\n" : "");
}
