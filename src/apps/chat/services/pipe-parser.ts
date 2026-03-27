import type { PipeMode } from '../types.js';

export interface ParsedPipeCommand {
  mode: PipeMode;
  assignees: string[];
  prompt: string;
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

  return { mode, assignees, prompt };
}

export function isPipeParseError(result: PipeParseResult): result is PipeParseError {
  return 'error' in result;
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
