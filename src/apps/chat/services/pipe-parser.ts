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

const PIPE_CMD_RE = /^\/(linear-pipe|merge-pipe)\s+/;

export function isPipeCommand(body: string): boolean {
  return PIPE_CMD_RE.test(body.trim());
}

export function parsePipeCommand(body: string): PipeParseResult {
  const trimmed = body.trim();
  const cmdMatch = trimmed.match(/^\/(linear-pipe|merge-pipe)\s+([\s\S]+)$/);
  if (!cmdMatch) {
    return { error: 'Invalid pipe command. Use /linear-pipe or /merge-pipe.' };
  }

  const mode: PipeMode = cmdMatch[1] === 'linear-pipe' ? 'linear' : 'merge';
  const rest = cmdMatch[2];

  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) {
    return { error: 'Missing ":" between assignees and prompt. Example: /linear-pipe @a @b: your prompt' };
  }

  const assigneePart = rest.substring(0, colonIdx).trim();
  const prompt = rest.substring(colonIdx + 1).trim();

  if (!prompt) {
    return { error: 'Prompt cannot be empty.' };
  }

  const assigneeMatches = assigneePart.match(/@[\w-]+/g);
  if (!assigneeMatches || assigneeMatches.length === 0) {
    return { error: 'No assignees found. Use @name to specify participants.' };
  }

  const assignees = assigneeMatches.map(a => a.substring(1));

  if (mode === 'linear' && assignees.length < 2) {
    return { error: '/linear-pipe requires at least 2 assignees.' };
  }
  if (mode === 'merge' && assignees.length < 3) {
    return { error: '/merge-pipe requires at least 3 assignees (last one synthesizes).' };
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
