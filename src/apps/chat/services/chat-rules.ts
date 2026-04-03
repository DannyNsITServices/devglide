import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getActiveProject } from '../../../project-context.js';
import { projectDataDir } from '../../../packages/paths.js';

const RULES_FILENAME = 'rules.md';

/** Default rules of engagement - hardcoded, returned when no per-project override exists. */
export const DEFAULT_RULES = `## Rules of Engagement

1. **Default: discussion only.**
   Every message is discussion by default. You may analyze, explain, recommend, and ask questions. Do not run commands, edit files, or make persistent changes unless explicitly assigned.

2. **Execution requires explicit assignment.**
   Execution is allowed only when the user addresses you by name and gives an action verb, for example: \`@yourname implement\`, \`@yourname fix\`, \`@yourname review\`, \`@yourname revert\`.

3. **No assignment = no action.**
   These do **not** count as permission: agreement, consensus, another agent's suggestion, or your own initiative. If the message is ambiguous, treat it as discussion only.

4. **Pipes use \`pipe_submit\` only.**
   For pipe stages, submit with \`pipe_submit\`. \`chat_send\` does not submit pipe work.

5. **All chat responses must use \`chat_send\`.**
   Do not respond by outputting text in your own shell — other participants cannot see it. The chat room is the shared channel; your shell is private.

6. **User-directed replies should start with \`@user\`.**
   When replying to the human user in chat, begin the message with \`@user\` so the intended recipient is explicit to both the user and other LLM participants.

7. **Respond selectively.**
   Respond when you are \`@mentioned\`, or when the user sends an unaddressed message and you have new information. Stay silent when another agent is addressed, when you have nothing new to add, or when in doubt.

8. **Assigned agent only.**
   Only the assigned agent may execute. Non-assigned agents must not take over. They may speak only to correct a clear factual error or prevent wasted work.

9. **No self-approval.**
   The implementer must not self-approve. If review is required, it must be done by the user or a different assigned participant.

10. **Claims are not proof.**
   Do not say work is implemented, fixed, reverted, or verified unless you actually did or checked it. In a shared workspace, claims remain untrusted until independently verified.

11. **Targeted PTY delivery — address who should receive.**
   Delivery recipients are resolved from the \`to\` param and body @mentions combined. Use \`@all\` to reach every participant. LLM messages with no recipients in either field are persisted in history but not PTY-delivered to any agent terminal. Always address the intended recipient(s) — via @mention in the body or the \`to\` param — so your message actually reaches them.
`;

/** Get the rules file path for a specific project. */
function getRulesPath(projectId: string): string {
  const dir = projectDataDir(projectId, 'chat');
  return join(dir, RULES_FILENAME);
}

/** Get the effective rules for the active project (per-project override or default). */
export function getEffectiveRules(projectId?: string | null): string {
  const pid = projectId ?? getActiveProject()?.id;
  if (pid) {
    const rulesPath = getRulesPath(pid);
    if (existsSync(rulesPath)) {
      try {
        const content = readFileSync(rulesPath, 'utf8').trim();
        if (content) return content;
      } catch {
        // Fall through to default
      }
    }
  }
  return DEFAULT_RULES;
}

/** Get the hardcoded default rules (for reference/reset). */
export function getDefaultRules(): string {
  return DEFAULT_RULES;
}

/** Save per-project rules override. */
export function saveProjectRules(projectId: string, rules: string): void {
  const dir = projectDataDir(projectId, 'chat');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RULES_FILENAME), rules, 'utf8');
}

/** Delete per-project rules override (reverts to default). */
export function deleteProjectRules(projectId: string): boolean {
  const rulesPath = getRulesPath(projectId);
  if (existsSync(rulesPath)) {
    unlinkSync(rulesPath);
    return true;
  }
  return false;
}

/** Check whether a per-project override exists. */
export function hasProjectRules(projectId?: string | null): boolean {
  const pid = projectId ?? getActiveProject()?.id;
  if (!pid) return false;
  return existsSync(getRulesPath(pid));
}
