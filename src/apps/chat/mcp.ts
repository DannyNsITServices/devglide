import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../packages/mcp-utils/src/index.js';
import * as store from './services/chat-store.js';
import { getEffectiveRules } from './services/chat-rules.js';

const UNIFIED_BASE = `http://localhost:${process.env.PORT ?? 7000}`;

/** Maps each per-session McpServer instance to all participant names it owns.
 *  Tracks every name joined during the session so onSessionClose can clean up
 *  all of them — even if a prior /leave failed and the name was not removed. */
export const chatServerSessions = new WeakMap<McpServer, Set<string>>();

/** POST/GET helper for the unified server's chat REST API. */
async function chatApi(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const opts: RequestInit = {
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${UNIFIED_BASE}/api/chat${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export function createChatMcpServer(): McpServer {
  const server = createDevglideMcpServer(
    'devglide-chat',
    '0.1.0',
    'Multi-LLM chat room for cross-agent communication',
    {
      instructions: [
        '## Chat — Usage Conventions',
        '',
        '### Purpose',
        '- Chat provides a shared room where the user and multiple LLM instances communicate.',
        '- Messages are **broadcast within the active project** so every participant stays current.',
        '- LLMs receive messages via PTY injection when linked to a shell pane.',
        '',
        '### Joining',
        '- Use `chat_join` to register as a participant. Provide your `name` (e.g. "claude-code") and optionally `model` (e.g. "claude", "gpt-5").',
        '- **Name assignment:** The server derives your name from `model` + pane number (e.g. "claude-1" for model "claude" on pane-1). **Always use the `name` returned by `chat_join`** — that is your identity for the session.',
        '- `"user"` and `"system"` are **reserved names** — do not use them.',
        '- `chat_join` requires an explicit `paneId`. Read `DEVGLIDE_PANE_ID` from your shell session and pass it as `paneId` every time. Do not rely on MCP process env inheritance.',
        '- **`submitKey` parameter:** Controls the character sent after PTY-injected messages to trigger input submission. Use `"cr"` (carriage return, default) for all known clients including Claude Code and Codex. The submit key is sent after a short delay to avoid paste-burst detection in TUI frameworks like crossterm.',
        '- If you call `chat_join` while already joined, the previous session is automatically cleaned up (re-join is safe).',
        '',
        '### Rules of Engagement',
        '- On `chat_join`, you receive a `rules` field containing the project\'s **Rules of Engagement** (markdown).',
        '- **Follow these rules exactly** — they define when you should respond and when to stay silent.',
        '- Default rule: reply if @mentioned, or if the server assigned you as the responder for an unaddressed user message (`assignedTo`).',
        '- If another responder is assigned, stay silent unless the user explicitly asks you or you need to correct a clear factual error.',
        '- Implementation and review must stay separate: the implementing LLM cannot be its own reviewer.',
        '- Rules can be customized per project. Always follow the rules returned by `chat_join`.',
        '',
        '### Sending messages',
        '- Use `chat_send` to send a message. Use **@mentions in the message body** to address specific participants (e.g. `@user check this`).',
        '- **All messages are broadcast** to every participant in the project. @mentions are a semantic signal (who should act), not a delivery filter.',
        '- Never @mention yourself — messages are never delivered back to the sender.',
        '- Markdown is supported in message bodies.',
        '',
        '### Reading history',
        '- Use `chat_read` to read recent message history. Supports `limit` and `since` filters.',
        '- Use `chat_members` to list active participants and check their pane link status (`paneId: null` means disconnected). `isAssigned` / `assignmentStatus` show the current responder state.',
        '',
        '### Pane linking',
        '- A valid `paneId` is required to receive messages via PTY injection.',
        '- `chat_join` now fails if the supplied pane is missing or not routable by the shell backend.',
        '- If your pane closes, you are automatically removed from the chat.',
        '',
        '### Limitations',
        '- You cannot send messages to yourself (self-mentions are ignored).',
        '- Only participants in the same project see each other and can exchange messages.',
        '- The `to` parameter on `chat_send` is only effective for user senders. LLMs should rely on the returned rules of engagement and message-body intent.',
        '- Participants are in-memory only — if the server restarts, everyone must rejoin.',
        '',
        '### Quick reference — commonly confused parameters',
        '- `chat_join(name, model?, paneId, submitKey?)` — register. `paneId` is required and should come from `DEVGLIDE_PANE_ID` in your shell. Check returned `name` (server assigns it). `"user"`/`"system"` reserved. `submitKey`: `"cr"` (default, correct for all known clients including Claude Code and Codex).',
        '- `chat_leave()` — unregister from the chat room.',
        '- `chat_send(message, to?)` — send a message. Delivery is broadcast within the project; use `@mentions` only to signal who should respond.',
        '- `chat_read(limit?, since?)` — read message history.',
        '- `chat_members()` — list active participants with pane link status.',
      ],
    },
  );

  // Track the name this MCP session joined as
  let sessionName: string | null = null;

  // ── 1. chat_join ──────────────────────────────────────────────────────

  server.tool(
    'chat_join',
    'Join the chat room as a participant. Requires explicit paneId from DEVGLIDE_PANE_ID in your shell, and that pane must be live/routable by the shell backend.',
    {
      name: z.string().describe('Your participant name (e.g. "claude-code", "cursor")'),
      model: z.string().optional().describe('Model/tool identifier shown next to name (e.g. "claude", "cursor", "codex")'),
      paneId: z.string().optional().describe('Shell pane ID for PTY delivery. Read DEVGLIDE_PANE_ID from your shell and pass it explicitly. The pane must be live and routable by the shell backend.'),
      submitKey: z.enum(['cr', 'lf']).optional().describe('Character to trigger submit after PTY injection: "cr" (default, correct for all known clients including Claude Code and Codex). Only use "lf" if you have verified a specific client requires it'),
    },
    async ({ name, model, paneId, submitKey }) => {
      if (name === 'user') return errorResult('"user" is reserved for the dashboard user');
      if (name === 'system') return errorResult('"system" is reserved');

      // Leave previous session if re-joining (prevents orphaned participants).
      // Use full leave here (not detach) since the same MCP session is explicitly
      // re-joining — the old alias is no longer needed for reclaim.
      if (sessionName) {
        const leaveRes = await chatApi('/leave', { name: sessionName }).catch(() => null);
        if (leaveRes?.ok) {
          chatServerSessions.get(server)?.delete(sessionName);
        }
        sessionName = null;
      }

      if (!paneId) {
        const envPaneId = process.env.DEVGLIDE_PANE_ID;
        if (envPaneId) {
          return errorResult(
            `chat_join requires explicit paneId. Read DEVGLIDE_PANE_ID from your shell and call chat_join with paneId: "${envPaneId}".`,
          );
        }
        return errorResult(
          'chat_join requires explicit paneId, and DEVGLIDE_PANE_ID is not available in this MCP process. Chat cannot be used until you read DEVGLIDE_PANE_ID from your shell environment and pass it as paneId.',
        );
      }

      const res = await chatApi('/join', { name, model: model ?? null, paneId, submitKey: submitKey ?? undefined });
      if (!res.ok) return errorResult((res.data as { error?: string })?.error ?? 'Join failed');
      // Use the resolved name from the server (may be a generated unique name)
      const participant = res.data as { name: string; projectId?: string | null };
      sessionName = participant.name;
      if (!chatServerSessions.has(server)) chatServerSessions.set(server, new Set());
      chatServerSessions.get(server)!.add(sessionName);
      // Attach rules of engagement so the joining LLM knows how to behave
      const rules = getEffectiveRules(participant.projectId);
      return jsonResult({ ...participant, rules });
    },
  );

  // ── 2. chat_leave ─────────────────────────────────────────────────────

  server.tool(
    'chat_leave',
    'Leave the chat room. Uses the name from the current session.',
    {},
    async () => {
      if (!sessionName) return errorResult('Not joined — call chat_join first');
      const res = await chatApi('/leave', { name: sessionName });
      if (!res.ok) return errorResult((res.data as { error?: string })?.error ?? 'Leave failed');
      chatServerSessions.get(server)?.delete(sessionName);
      sessionName = null;
      return jsonResult(res.data);
    },
  );

  // ── 3. chat_send ──────────────────────────────────────────────────────

  server.tool(
    'chat_send',
    'Send a message to the chat room. Omit "to" for broadcast, or specify a recipient name.',
    {
      message: z.string().describe('Message text (markdown supported)'),
      to: z.string().optional().describe('Recipient name for direct message, or omit for broadcast'),
    },
    async ({ message, to }) => {
      if (!sessionName) return errorResult('Not joined — call chat_join first');
      const res = await chatApi('/send', { from: sessionName, message, to });
      if (!res.ok) return errorResult((res.data as { error?: string })?.error ?? 'Send failed');
      return jsonResult(res.data);
    },
  );

  // ── 4. chat_read ──────────────────────────────────────────────────────

  server.tool(
    'chat_read',
    'Read recent chat message history.',
    {
      limit: z.number().optional().describe('Max messages to return (default 50)'),
      since: z.string().optional().describe('ISO timestamp — only return messages after this time'),
    },
    async ({ limit, since }) => {
      const messages = store.readMessages({ limit, since });
      return jsonResult(messages);
    },
  );

  // ── 5. chat_members ───────────────────────────────────────────────────

  server.tool(
    'chat_members',
    'List active chat participants with their pane link status.',
    {},
    async () => {
      const res = await chatApi('/members');
      if (!res.ok) return errorResult('Failed to fetch members');
      return jsonResult(res.data);
    },
  );

  return server;
}
