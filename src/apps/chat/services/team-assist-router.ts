/**
 * Assist-mode proposal router.
 *
 * When a team is in 'assist' mode, unaddressed user imperative messages are
 * intercepted before PTY broadcast. A proposal is created instead of dispatching
 * immediately. The user can approve, reject, or dismiss via the REST API.
 *
 * This hook is purely additive — it has no effect when:
 *   - No active team exists for the project
 *   - The team is in 'manual' mode
 *   - The team is paused or disbanded
 *   - The message already has explicit @mention targets (it's addressed)
 *   - The message is from an LLM or system (user only)
 */

import type { PlaybookId } from './team-run-store.js';
import type { ActiveTeam } from './team-store.js';

// ── Intent classification ──────────────────────────────────────────────────────

/**
 * Imperative verbs that suggest a change-request playbook.
 * Order: more specific patterns first.
 */
const CHANGE_REQUEST_VERBS =
  /\b(implement|add|build|create|introduce|develop|scaffold|ship|write|migrate|upgrade|extend|integrate)\b/i;

/** Imperative verbs that suggest a bug-fix playbook. */
const BUG_FIX_VERBS =
  /\b(fix|debug|repair|resolve|patch|revert|investigate|diagnose|reproduce|root[\s-]cause)\b/i;

/**
 * Classify a message body into a playbook ID.
 * Returns 'change-request' or 'bug-fix' based on keyword matching,
 * defaulting to 'change-request' when intent is ambiguous.
 */
export function classifyIntent(body: string): PlaybookId {
  const lower = body.toLowerCase();
  // Bug-fix check first — "fix" is more specific than "implement"
  if (BUG_FIX_VERBS.test(lower)) return 'bug-fix';
  if (CHANGE_REQUEST_VERBS.test(lower)) return 'change-request';
  return 'change-request'; // default for ambiguous imperatives
}

// ── Imperative detection ───────────────────────────────────────────────────────

/**
 * Heuristic: does the message look like a user imperative (action request)?
 * Checks for:
 *   - Starts with an imperative verb (capitalized or not)
 *   - Contains a known action verb anywhere in the first 120 chars
 *   - Is not a question (ends with ?)
 *   - Is not a command starting with /
 */
const IMPERATIVE_START_RE =
  /^(implement|add|build|fix|debug|create|ship|write|migrate|upgrade|resolve|patch|revert|investigate|diagnose|extend|scaffold|introduce|develop|integrate)\b/i;

const IMPERATIVE_ANYWHERE_RE =
  /\b(implement|add|build|fix|debug|create|ship|write|migrate|upgrade|resolve|patch|revert|investigate|diagnose|extend|scaffold|introduce|develop|integrate)\b/i;

export function looksLikeImperative(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.startsWith('/')) return false;        // slash command
  if (trimmed.endsWith('?')) return false;           // question
  const preview = trimmed.slice(0, 200);
  return IMPERATIVE_START_RE.test(preview) || IMPERATIVE_ANYWHERE_RE.test(preview);
}

// ── Main hook ─────────────────────────────────────────────────────────────────

/**
 * Decide whether to intercept a user message and route it as a proposal.
 *
 * Returns true when ALL of the following hold:
 *   1. team is active (not paused, not disbanded)
 *   2. team mode would be 'assist' — but since mode is not on ActiveTeam yet,
 *      the caller passes `assistModeEnabled` explicitly
 *   3. message is from 'user'
 *   4. message has no @mention targets (targetTokens is empty)
 *   5. message looks like an imperative
 */
export function shouldIntercept(opts: {
  from: string;
  targetTokens: string[];
  body: string;
  team: ActiveTeam | null;
  assistModeEnabled: boolean;
}): boolean {
  const { from, targetTokens, body, team, assistModeEnabled } = opts;

  if (from !== 'user') return false;
  if (!team || team.status !== 'active') return false;
  if (!assistModeEnabled) return false;
  if (targetTokens.length > 0) return false; // message is already addressed
  if (!looksLikeImperative(body)) return false;

  return true;
}

/**
 * Build the proposal preview text shown to the user when a message is intercepted.
 */
export function formatProposalPreview(
  team: ActiveTeam,
  playbook: PlaybookId,
  prompt: string,
  stageDescriptions: string[],
): string {
  const stageList = stageDescriptions
    .map((d, i) => `  Stage ${i + 1}: ${d}`)
    .join('\n');

  return [
    `**Assist mode** — "${team.name}" intercepted your message.`,
    `Proposed playbook: **${playbook}**`,
    `Prompt: _${prompt}_`,
    '',
    'Planned stages:',
    stageList,
    '',
    'To proceed: **/team proposal approve <id>** or **/team proposal reject <id>**',
    'Or dismiss via the sidebar.',
  ].join('\n');
}
