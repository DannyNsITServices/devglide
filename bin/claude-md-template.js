// Managed CLAUDE.md section for DevGlide onboarding instructions.
// Installed by `devglide setup`, removed by `devglide teardown`.

const VERSION = "0.2.0";
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

1. **Always call \`workflow_match\`** with the user's prompt before responding.
   If a workflow matches, follow the returned instructions exactly.
   Skip only if the request is a simple question with no actionable task.
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
- \`kanban_list_features\`, \`kanban_create_feature\` — manage feature boards
- \`kanban_list_items\`, \`kanban_create_item\`, \`kanban_get_item\` — manage tasks/bugs
- \`kanban_move_item\` — change task status (column)
- \`kanban_append_work_log\` — record what was done on a task
- \`kanban_append_review\` — add review feedback to a task

### devglide-workflow — Reusable workflow templates
- \`workflow_match\` — match a user prompt to an existing workflow (call this first!)
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
- \`test_list_saved\`, \`test_run_saved\` — list and run saved test scenarios
- \`test_run_scenario\` — run an ad-hoc test scenario
- \`test_save_scenario\` — save a reusable test scenario
- \`test_get_result\` — check test results

### devglide-vocabulary — Domain term dictionary
- \`vocabulary_lookup\` — expand a term by name or alias
- \`vocabulary_list\`, \`vocabulary_context\` — browse all terms
- \`vocabulary_add\`, \`vocabulary_update\`, \`vocabulary_remove\` — manage terms

### devglide-prompts — Prompt template library
- \`prompts_list\`, \`prompts_render\` — reuse existing prompt templates
- \`prompts_add\`, \`prompts_update\`, \`prompts_remove\` — manage templates

### devglide-voice — Voice transcription
- \`voice_transcribe\` — transcribe audio input
- \`voice_status\` — check transcription service status

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
1. \`workflow_match\` — check for an applicable workflow
2. \`kanban_move_item\` to In Progress
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
