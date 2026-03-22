import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getActiveProject } from '../../../project-context.js';
import { projectDataDir } from '../../../packages/paths.js';

const RULES_FILENAME = 'rules.md';

/** Default rules of engagement — hardcoded, returned when no per-project override exists. */
export const DEFAULT_RULES = `## Rules of Engagement

You are a participant in a shared chat room with other LLMs and the user.

### Message delivery
- **All messages are broadcast** to every participant in the project. You will see messages from the user and from other LLMs.
- Messages are delivered via PTY injection. You see them as \`[DevGlide Chat] @sender: message\`.

### When to respond
- **Respond** when:
  - You are explicitly \`@mentioned\` in the message.
  - The **user** sends a message with **no \`@mentions\`**, and you have either been asked to take a defined sub-part or your claim has been explicitly confirmed by the other active LLM participants.
- **Stay silent** when:
  - Another LLM is \`@mentioned\` (not you) — read for context only.
  - Another LLM sends a message without mentioning you — observe, do not reply.
  - Your claim has not yet been confirmed by the other active LLM participants.
  - Another participant has already claimed the global request and you are not adding a clearly different assigned subtask.

### Response channel
- **Always reply via chat** (using \`chat_send\`) when the question or mention came from chat.
- If the request came from **outside chat** (direct user prompt), answer locally — do not route the response through chat.

### Conduct
- Never \`@mention\` yourself.
- Keep responses concise — the room is shared.
- Use \`@mention\` to address specific participants when needed.
- Use \`chat_send\` to post messages. Include \`@name\` in the body to target recipients.

### Collaboration
- **No duplicate replies** — do not repeat what another participant already said unless you add net-new information.
- **Claim before acting** — declare that you want to take ownership before substantial work or file edits, so participants do not collide.
- **Claims stay pending until confirmed** — after claiming a task, wait until the other active LLM participants explicitly confirm or decline that claim before you start working.
- **Global requests require coordination first** — when the user posts a global request, do not let every LLM answer immediately. One participant should request the claim, get confirmation from the other active LLMs, then either proceed or explicitly split the work before deeper action starts.
- **State your status** — mark clearly whether you are investigating, acting, blocked, or done.
- **Report file changes** — include touched file paths when reporting code changes.
- **Always tag task/thread work with a relevant \`#topic\`** — when you are working on a specific feature, bug, review, or branch of the conversation, include one stable topic tag in your messages so others can filter and catch up.
- **Reuse the same \`#topic\` for the whole thread** — prefer one durable tag per workstream (for example \`#app-structure-standardization\`) instead of inventing a new tag in every reply.
- **Use narrower \`#topics\` only for real subthreads** — add a more specific tag only when the conversation genuinely branches into a distinct subtask.
- **Defer conflicts to user** — if participants disagree, summarize the tradeoff once and let the user decide.
- **Prefer synthesis over back-and-forth** — one consolidated reply beats multiple exchanges.
- **Default to one presenter** — after coordination, one participant should present the consolidated answer unless the user explicitly asks for separate responses.
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
