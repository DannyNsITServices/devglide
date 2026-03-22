import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ChatMessage } from '../types.js';
import { getActiveProject } from '../../../project-context.js';
import { projectDataDir } from '../../../packages/paths.js';

function getChatDir(): string | null {
  const project = getActiveProject();
  if (!project) return null;
  return projectDataDir(project.id, 'chat');
}

function getMessagesPath(): string | null {
  const dir = getChatDir();
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, 'messages.jsonl');
}

export function appendMessage(msg: Omit<ChatMessage, 'id' | 'ts'>): ChatMessage {
  const full: ChatMessage = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...msg,
  };

  const filePath = getMessagesPath();
  if (filePath) {
    appendFileSync(filePath, JSON.stringify(full) + '\n');
  }

  return full;
}

export function readMessages(opts?: { limit?: number; since?: string }): ChatMessage[] {
  const filePath = getMessagesPath();
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

export function clearMessages(): void {
  const filePath = getMessagesPath();
  if (filePath && existsSync(filePath)) {
    writeFileSync(filePath, '');
  }
}
