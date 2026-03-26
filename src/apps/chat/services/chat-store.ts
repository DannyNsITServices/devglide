import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ChatMessage } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { projectDataDir } from '../../../packages/paths.js';

/**
 * Resolve the chat data directory for a given project.
 * An explicit projectId avoids relying on the global active-project singleton,
 * which can point to a different project when the user switches the dashboard.
 */
function getChatDir(projectId?: string | null): string | null {
  const pid = projectId ?? getActiveProject()?.id;
  if (!pid) return null;
  return projectDataDir(pid, 'chat');
}

function getMessagesPath(projectId?: string | null): string | null {
  const dir = getChatDir(projectId);
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, 'messages.jsonl');
}

function getPipeMessagesPath(pipeId: string, projectId?: string | null): string | null {
  const dir = getChatDir(projectId);
  if (!dir) return null;
  const pipesDir = join(dir, 'pipes');
  mkdirSync(pipesDir, { recursive: true });
  return join(pipesDir, `${pipeId}.jsonl`);
}

export function appendMessage(msg: Omit<ChatMessage, 'id' | 'ts'>, projectId?: string | null): ChatMessage {
  const full: ChatMessage = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...msg,
  };

  const line = JSON.stringify(full) + '\n';
  const filePath = getMessagesPath(projectId);
  if (filePath) {
    appendFileSync(filePath, line);
  }

  // Dual-write: pipe messages also go to a per-pipe JSONL file for fast scoped reads
  if (full.pipe?.pipeId) {
    const pipePath = getPipeMessagesPath(full.pipe.pipeId, projectId);
    if (pipePath) {
      appendFileSync(pipePath, line);
    }
  }

  return full;
}

export function readMessages(opts?: { limit?: number; since?: string; pipeId?: string }, projectId?: string | null): ChatMessage[] {
  // Fast path: read from per-pipe JSONL file when pipeId is specified.
  // Falls back to scanning the unified log if the per-pipe file doesn't exist
  // (backward compatibility with pipe data written before per-pipe storage).
  let filePath: string | null;
  let needsPipeFilter = false;
  if (opts?.pipeId) {
    const pipePath = getPipeMessagesPath(opts.pipeId, projectId);
    if (pipePath && existsSync(pipePath)) {
      filePath = pipePath;
    } else {
      filePath = getMessagesPath(projectId);
      needsPipeFilter = true;
    }
  } else {
    filePath = getMessagesPath(projectId);
  }
  if (!filePath || !existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  let messages: ChatMessage[] = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as ChatMessage; }
      catch { return null; }
    })
    .filter((m): m is ChatMessage => m !== null);

  // Fallback: filter by pipeId when reading from the unified log
  if (needsPipeFilter && opts?.pipeId) {
    messages = messages.filter((m) => m.pipe?.pipeId === opts.pipeId);
  }

  if (opts?.since) {
    const sinceDate = new Date(opts.since).getTime();
    messages = messages.filter((m) => new Date(m.ts).getTime() > sinceDate);
  }

  const limit = opts?.limit ?? 50;
  if (messages.length > limit) {
    messages = messages.slice(-limit);
  }

  return messages;
}


// ── Participant persistence ──────────────────────────────────────────────────

export interface PersistedParticipant {
  name: string;
  model: string | null;
  paneId: string | null;
  projectId: string | null;
  submitKey: string;
  joinedAt: string;
  lastSeen: string;
  permissionMode?: 'supervised' | 'auto-accept' | 'unrestricted' | null;
}

function getParticipantsPath(projectId?: string | null): string | null {
  const dir = getChatDir(projectId);
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, 'participants.json');
}

export function saveParticipants(participants: PersistedParticipant[], projectId?: string | null): void {
  const filePath = getParticipantsPath(projectId);
  if (!filePath) return;
  writeFileSync(filePath, JSON.stringify(participants, null, 2));
}

export function loadParticipants(projectId?: string | null): PersistedParticipant[] {
  const filePath = getParticipantsPath(projectId);
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as PersistedParticipant[];
  } catch {
    return [];
  }
}


export function clearMessages(projectId?: string | null): void {
  const filePath = getMessagesPath(projectId);
  if (filePath && existsSync(filePath)) {
    writeFileSync(filePath, '');
  }
  // Also clear per-pipe JSONL files
  const dir = getChatDir(projectId);
  if (dir) {
    const pipesDir = join(dir, 'pipes');
    if (existsSync(pipesDir)) {
      for (const file of readdirSync(pipesDir)) {
        if (file.endsWith('.jsonl')) {
          unlinkSync(join(pipesDir, file));
        }
      }
    }
  }
}


// ── Pipe message queries ─────────────────────────────────────────────────────

/** Read all messages that carry pipe metadata for a given pipeId.
 *  Uses the per-pipe JSONL file for O(pipe messages) instead of O(all messages). */
export function readPipeMessages(pipeId: string, projectId?: string | null): ChatMessage[] {
  return readMessages({ limit: 10000, pipeId }, projectId);
}
