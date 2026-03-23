import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ChatMessage, DeliveryInfo } from '../types.js';
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

export function appendMessage(msg: Omit<ChatMessage, 'id' | 'ts'>, projectId?: string | null): ChatMessage {
  const full: ChatMessage = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...msg,
  };

  const filePath = getMessagesPath(projectId);
  if (filePath) {
    appendFileSync(filePath, JSON.stringify(full) + '\n');
  }

  return full;
}

export function readMessages(opts?: { limit?: number; since?: string }, projectId?: string | null): ChatMessage[] {
  const filePath = getMessagesPath(projectId);
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

/** Update the delivery status for a message in the JSONL store.
 *  Rewrites the specific line with the updated delivery array. */
export function updateMessageDelivery(messageId: string, info: DeliveryInfo, projectId?: string | null): void {
  const filePath = getMessagesPath(projectId);
  if (!filePath || !existsSync(filePath)) return;

  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const msg = JSON.parse(lines[i]) as ChatMessage;
      if (msg.id === messageId) {
        if (!msg.delivery) msg.delivery = [];
        const existing = msg.delivery.findIndex(d => d.target === info.target);
        if (existing >= 0) {
          msg.delivery[existing] = info;
        } else {
          msg.delivery.push(info);
        }
        lines[i] = JSON.stringify(msg);
        updated = true;
        break;
      }
    } catch { /* skip malformed lines */ }
  }

  if (updated) {
    writeFileSync(filePath, lines.join('\n'));
  }
}

export function clearMessages(projectId?: string | null): void {
  const filePath = getMessagesPath(projectId);
  if (filePath && existsSync(filePath)) {
    writeFileSync(filePath, '');
  }
}
