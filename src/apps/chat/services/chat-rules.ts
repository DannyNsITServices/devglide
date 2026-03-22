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
  - The **user** sends a message with **no \`@mentions\`**, and the server assigned you as the default responder.
- **Stay silent** when:
  - Another LLM is \`@mentioned\` (not you) — read for context only.
  - Another LLM sends a message without mentioning you — observe, do not reply.
  - The server assigned a different responder for the user message.

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
- **Separate implementation from review** — if one LLM implements a task, that same LLM must not also review it. The reviewer must be a different LLM or the user.
- **Trust assignment state over chat negotiation** — when the server marks another responder as assigned or active, do not start parallel work unless the user explicitly reassigns you or asks for a factual correction.
- **State your status** — mark clearly whether you are investigating, acting, blocked, or done.
- **Report file changes** — include touched file paths when reporting code changes.
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
