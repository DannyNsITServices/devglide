// Managed CLAUDE.md section for DevGlide onboarding instructions.
// Installed by `devglide setup`, removed by `devglide teardown`.

const VERSION = "0.1.0";
const BEGIN = `<!-- DEVGLIDE:BEGIN v${VERSION} -->`;
const END = "<!-- DEVGLIDE:END -->";

export function getClaudeMdContent() {
  return `${BEGIN}
# DevGlide — AI Workflow Toolkit

DevGlide gives you MCP tools for kanban boards, shell automation, test runners,
workflows, vocabulary, voice, prompts, logging, and documentation — all wired
into your coding assistant. Follow the rules below so the tools work together.

## Priority Rules

1. **Always call \`workflow_match\`** with the user's prompt before responding.
   If a workflow matches, follow its instructions exactly.
2. **Call \`vocabulary_lookup\`** when you encounter unfamiliar or ambiguous terms
   that could be domain jargon, project names, or abbreviations.
3. **Update kanban status** — move items to In Progress when starting work,
   to In Review / Testing when done. Never move items to Done (only the user can).
4. **Append a work log** via \`kanban_append_work_log\` after completing work
   on any kanban task.
5. **Pick tasks from the Todo column** by default unless told otherwise.

## MCP Servers

| Server          | Purpose                                      |
|-----------------|----------------------------------------------|
| devglide-kanban | Task boards — features, items, reviews, logs |
| devglide-shell  | Terminal pane management and command execution|
| devglide-test   | Browser automation test scenarios            |
| devglide-workflow | Reusable workflow templates and matching    |
| devglide-vocabulary | Domain term definitions and lookups       |
| devglide-voice  | Voice transcription                          |
| devglide-log    | Structured logging                           |
| devglide-prompts | Prompt templates                            |

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
1. \`test_list_saved\` — see existing test scenarios
2. \`test_run_saved\` — run a saved scenario, or \`test_run_scenario\` for ad-hoc
3. \`test_get_result\` — check results
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
