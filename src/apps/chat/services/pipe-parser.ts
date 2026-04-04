import type { PipeMode, PipeTimeoutPolicy } from '../types.js';

export interface ParsedPipeCommand {
  mode: PipeMode;
  assignees: string[];
  prompt: string;
  stageTimeoutMs?: number;
  timeoutPolicy?: PipeTimeoutPolicy;
}

export interface PipeParseError {
  error: string;
}

export type PipeParseResult = ParsedPipeCommand | PipeParseError;

const PIPE_COMMANDS = ['linear-pipe', 'merge-pipe', 'merge-all-pipe', 'explain', 'explain-pipe', 'summarize', 'summarize-pipe'] as const;
const PIPE_CMD_RE = /^\/(linear-pipe|merge-pipe|merge-all-pipe|explain(?:-pipe)?|summarize(?:-pipe)?)\s+/;

function commandLabel(mode: PipeMode): string {
  switch (mode) {
    case 'linear':
      return '/linear-pipe';
    case 'merge':
      return '/merge-pipe';
    case 'merge-all':
      return '/merge-all-pipe';
    case 'explain':
      return '/explain';
    case 'summarize':
      return '/summarize';
    default:
      return '/merge-all-pipe';
  }
}

export function validatePipeAssigneeCount(mode: PipeMode, assigneeCount: number): string | null {
  if (mode === 'linear' && assigneeCount < 2) {
    return `${commandLabel(mode)} requires at least 2 assignees.`;
  }
  if (mode === 'merge' && assigneeCount < 3) {
    return `${commandLabel(mode)} requires at least 3 assignees (last one synthesizes).`;
  }
  if ((mode === 'merge-all' || mode === 'explain' || mode === 'summarize') && assigneeCount < 2) {
    return `${commandLabel(mode)} requires at least 2 assignees.`;
  }
  return null;
}

export function isPipeCommand(body: string): boolean {
  return PIPE_CMD_RE.test(body.trim());
}

/** Parse a human-friendly duration string (e.g. "5m", "30s", "1h") to milliseconds. */
export function parseDuration(s: string): number | null {
  const match = s.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (value <= 0) return null;
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return null;
}

const VALID_TIMEOUT_POLICIES = ['fail', 'reassign', 'escalate'] as const;

export function parsePipeCommand(
  body: string,
  isKnownAssignee?: (name: string) => boolean,
): PipeParseResult {
  const trimmed = body.trim();
  const cmdMatch = trimmed.match(/^\/(linear-pipe|merge-pipe|merge-all-pipe|explain(?:-pipe)?|summarize(?:-pipe)?)\s+([\s\S]+)$/);
  if (!cmdMatch) {
    return { error: `Invalid pipe command. Use ${PIPE_COMMANDS.map(cmd => `/${cmd}`).join(', ')}.` };
  }

  const cmd = cmdMatch[1];
  let mode: PipeMode;
  if (cmd === 'linear-pipe') mode = 'linear';
  else if (cmd === 'merge-pipe') mode = 'merge';
  else if (cmd === 'merge-all-pipe') mode = 'merge-all';
  else if (cmd === 'explain' || cmd === 'explain-pipe') mode = 'explain';
  else mode = 'summarize';

  let remaining = cmdMatch[2].trim();

  // Parse optional flags (--timeout <duration>, --on-timeout <policy>) before @assignees
  let stageTimeoutMs: number | undefined;
  let timeoutPolicy: PipeTimeoutPolicy | undefined;

  while (true) {
    const flagMatch = remaining.match(/^--([\w-]+)\s+(\S+)\s*/);
    if (!flagMatch) break;

    const flagName = flagMatch[1];
    const flagValue = flagMatch[2];

    if (flagName === 'timeout') {
      const ms = parseDuration(flagValue);
      if (ms === null) return { error: `Invalid timeout duration: ${flagValue}. Use e.g. 5m, 30s, 1h.` };
      stageTimeoutMs = ms;
    } else if (flagName === 'on-timeout') {
      if (!(VALID_TIMEOUT_POLICIES as readonly string[]).includes(flagValue)) {
        return { error: `Invalid timeout policy: ${flagValue}. Use fail, reassign, or escalate.` };
      }
      timeoutPolicy = flagValue as PipeTimeoutPolicy;
    } else {
      break; // Unknown flag — stop flag parsing, rest is @mentions/prompt
    }

    remaining = remaining.slice(flagMatch[0].length);
  }

  const assignees: string[] = [];

  while (true) {
    const match = remaining.match(/^@([\w-]+)(?=\s|:|$)/);
    if (!match) break;

    const name = match[1];
    if (isKnownAssignee && !isKnownAssignee(name)) break;

    assignees.push(name);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  if (remaining.startsWith(':')) {
    remaining = remaining.slice(1).trimStart();
  }

  const prompt = remaining.trim();
  if (!prompt) {
    return { error: 'Prompt cannot be empty.' };
  }

  const unique = new Set(assignees);
  if (unique.size !== assignees.length) {
    return { error: 'Duplicate assignees not allowed.' };
  }

  return {
    mode,
    assignees,
    prompt,
    ...(stageTimeoutMs !== undefined ? { stageTimeoutMs } : {}),
    ...(timeoutPolicy !== undefined ? { timeoutPolicy } : {}),
  };
}

export function isPipeParseError(result: PipeParseResult): result is PipeParseError {
  return 'error' in result;
}

// ── Team command detection ────────────────────────────────────────────────────

/** Returns true if the message is a /team slash command. */
export function isTeamCommand(body: string): boolean {
  return /^\/team(\s|$)/.test(body.trim());
}

// ── Brainstorm command parsing ────────────────────────────────────────────────

const BRAINSTORM_CMD_RE = /^\/brainstorm\s+/;

export interface ParsedBrainstormCommand {
  assignees: string[];
  prompt: string;
}

export function isBrainstormCommand(body: string): boolean {
  return BRAINSTORM_CMD_RE.test(body.trim());
}

export function parseBrainstormCommand(
  body: string,
  isKnownAssignee?: (name: string) => boolean,
): ParsedBrainstormCommand | PipeParseError {
  const trimmed = body.trim();
  const cmdMatch = trimmed.match(/^\/brainstorm\s+([\s\S]+)$/);
  if (!cmdMatch) {
    return { error: 'Invalid brainstorm command. Usage: /brainstorm @agent1 @agent2 : topic' };
  }

  let remaining = cmdMatch[1].trim();
  const assignees: string[] = [];
  let stoppedAtUnknown: string | null = null;

  while (true) {
    const match = remaining.match(/^@([\w-]+)(?=\s|:|$)/);
    if (!match) break;
    const name = match[1];
    if (isKnownAssignee && !isKnownAssignee(name)) {
      stoppedAtUnknown = name;
      break;
    }
    assignees.push(name);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  // If no valid assignees were parsed but user wrote @names, the first was unknown
  if (stoppedAtUnknown && assignees.length === 0) {
    return { error: `Unknown assignee @${stoppedAtUnknown}. All assignees must be connected LLM participants.` };
  }

  if (remaining.startsWith(':')) {
    remaining = remaining.slice(1).trimStart();
  }

  const prompt = remaining.trim();
  if (!prompt) {
    return { error: 'Brainstorm prompt cannot be empty.' };
  }

  const unique = new Set(assignees);
  if (unique.size !== assignees.length) {
    return { error: 'Duplicate assignees not allowed.' };
  }

  return { assignees, prompt };
}
