import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../../packages/mcp-utils/src/index.js';
import * as store from '../services/chat-store.js';
import { getEffectiveRules } from '../services/chat-rules.js';

const UNIFIED_BASE = `http://localhost:${process.env.PORT ?? 7000}`;

export interface ChatSessionEntry { name: string; projectId: string | null }

/** Maps each per-session McpServer instance to its tracked chat participant(s).
 *  New code keeps this to a single entry per MCP session, but the array shape is retained
 *  so onSessionClose can safely clean up stale sessions from older builds. */
export const chatServerSessions = new WeakMap<McpServer, ChatSessionEntry[]>();

interface ChatStatusPayload {
  joined?: boolean;
  detached?: boolean;
  paneId?: string | null;
  error?: string;
}

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
        '- Use `chat_join` to register as a participant. Provide your `name` (e.g. "claude", "codex") and optionally `model` (e.g. "claude-sonnet-4-6", "gpt-5").',
        '- **Name assignment:** The server derives your chat alias from `name` + pane number (e.g. "claude-1" for name "claude" on pane 1). The `name` param is the identity base — use a stable agent label, not the backend model. **Always use the `name` returned by `chat_join`** — that is your identity for the session.',
        '- `"user"` and `"system"` are **reserved names** — do not use them.',
        '- `chat_join` requires an explicit `paneId`. Read `DEVGLIDE_PANE_ID` from your shell session and pass it as `paneId` every time. Do not use `"auto"` and do not rely on MCP process env inheritance.',
        '- If your paneId collides with another participant, **both participants are disconnected** and a collision error is broadcast. Both must re-read `$DEVGLIDE_PANE_ID` and rejoin.',
        '- **`submitKey` parameter:** Controls the character sent after PTY-injected messages to trigger input submission. Use `"cr"` (carriage return, default) for all known clients including Claude Code and Codex. The submit key is sent after a short delay to avoid paste-burst detection in TUI frameworks like crossterm.',
        '- Each MCP session may own only one chat participant. Use `chat_leave()` first, or create a separate MCP session for another agent.',
        '',
        '### Rules of Engagement',
        '- On `chat_join`, you receive a `rules` field containing the project\'s **Rules of Engagement** (markdown).',
        '- **Follow these rules exactly** — they define when you should respond and when to stay silent.',
        '- Default rule: reply if @mentioned, or if the user makes a global request only after your claim has been explicitly confirmed by the other active LLM participants. Do not let multiple LLMs answer the same global request uncoordinated.',
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
        '- Use `chat_members` to list active participants and check their pane link status (`paneId: null` means disconnected).',
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
        '- `chat_join(name, model?, paneId, submitKey?)` — register. `paneId` is required and must come from `DEVGLIDE_PANE_ID` in your shell (never `"auto"`). Check returned `name` (server assigns it). `"user"`/`"system"` reserved. `submitKey`: `"cr"` (default, correct for all known clients including Claude Code and Codex).',
        '- `chat_leave()` — unregister from the chat room.',
        '- `chat_send(message, to?)` — send a message. Delivery is broadcast within the project; use `@mentions` only to signal who should respond. Messages that start with `#pipe-` or reference a currently running `#pipe-*` are rejected — use `pipe_submit` instead.',
        '- `pipe_submit(pipeId, content)` — submit your output for a pipe stage. Use this instead of `chat_send` when responding to a `#pipe-` prompt.',
        '- `chat_read(limit?, since?)` — read message history.',
        '- `chat_members()` — list active participants with pane link status.',
      ],
    },
  );

  // Track the participant currently owned by this MCP session.
  let sessionEntry: ChatSessionEntry | null = null;
  let joinInFlight = false;

  function setSessionEntry(entry: ChatSessionEntry | null): void {
    sessionEntry = entry;
    if (entry) {
      chatServerSessions.set(server, [{ ...entry }]);
      return;
    }
    chatServerSessions.delete(server);
  }

  function getSessionProjectId(): string | null {
    return sessionEntry?.projectId ?? null;
  }

  function getSessionName(): string | null {
    return sessionEntry?.name ?? null;
  }

  async function readTrackedParticipantStatus(entry: ChatSessionEntry): Promise<{ ok: boolean; status: number; data: ChatStatusPayload } | null> {
    const query = `?name=${encodeURIComponent(entry.name)}${entry.projectId ? `&projectId=${encodeURIComponent(entry.projectId)}` : ''}`;
    try {
      const res = await chatApi(`/status${query}`);
      return { ok: res.ok, status: res.status, data: (res.data as ChatStatusPayload) ?? {} };
    } catch {
      return null;
    }
  }

  async function ensureSessionCanJoin(): Promise<{ ok: true } | { ok: false; result: ReturnType<typeof errorResult> }> {
    if (!sessionEntry) return { ok: true };

    const status = await readTrackedParticipantStatus(sessionEntry);
    if (!status) {
      return {
        ok: false,
        result: errorResult(
          `This MCP session is already joined as "${sessionEntry.name}", and its current state could not be verified. Use chat_leave first or create a separate MCP session for another participant.`,
        ),
      };
    }
    if (!status.ok) {
      if (status.status === 404) {
        setSessionEntry(null);
        return { ok: true };
      }
      return {
        ok: false,
        result: errorResult(
          `This MCP session is already joined as "${sessionEntry.name}". Status check failed: ${status.data.error ?? 'unknown error'}. Use chat_leave first or create a separate MCP session for another participant.`,
        ),
      };
    }

    if (status.data.joined === false || status.data.detached || !status.data.paneId) {
      setSessionEntry(null);
      return { ok: true };
    }

    return {
      ok: false,
      result: errorResult(
        `This MCP session is already joined as "${sessionEntry.name}". Use chat_leave first or create a separate MCP session for another participant.`,
      ),
    };
  }

  // ── 1. chat_join ──────────────────────────────────────────────────────

  server.tool(
    'chat_join',
    'Join the chat room as a participant. Requires explicit paneId — read $DEVGLIDE_PANE_ID from your shell session and pass it directly. Do not use "auto" or omit paneId.',
    {
      name: z.string().describe('Stable agent identity label used as the base for your chat alias (e.g. "claude", "codex", "cursor"). Do not pass the backend model here — use a consistent short name.'),
      model: z.string().optional().describe('Backend model identifier for display (e.g. "claude-sonnet-4-6", "gpt-5"). Not used for name derivation — use `name` for identity.'),
      paneId: z.string().describe('Shell pane ID for PTY delivery. Read DEVGLIDE_PANE_ID from your shell session and pass it directly. Do not use "auto" — the server will not guess your pane.'),
      submitKey: z.enum(['cr', 'lf']).optional().describe('Character to trigger submit after PTY injection: "cr" (default, correct for all known clients including Claude Code and Codex). Only use "lf" if you have verified a specific client requires it'),
    },
    async ({ name, model, paneId, submitKey }) => {
      if (name === 'user') return errorResult('"user" is reserved for the dashboard user');
      if (name === 'system') return errorResult('"system" is reserved');

      // Reject "auto" — LLMs must pass their actual pane ID
      if (paneId === 'auto') {
        return errorResult(
          'chat_join requires an explicit paneId for LLM participants. ' +
          'Run "echo $DEVGLIDE_PANE_ID" in your shell and pass the result as paneId. ' +
          'Do not use "auto" — the server cannot reliably guess your pane.',
        );
      }

      if (joinInFlight) {
        return errorResult(
          'chat_join is already in progress for this MCP session. Wait for it to finish, or use a separate MCP session for another agent.',
        );
      }
      joinInFlight = true;
      try {
        const sessionCheck = await ensureSessionCanJoin();
        if (sessionCheck.ok === false) return sessionCheck.result;
        const res = await chatApi('/join', { name, model: model ?? null, paneId, submitKey: submitKey ?? undefined });
        if (!res.ok) {
          const data = res.data as { error?: string; diagnostics?: unknown };
          const errMsg = data?.error ?? 'Join failed';
          const diag = data?.diagnostics;
          if (diag) {
            return errorResult(`${errMsg}\n\nDiagnostics: ${JSON.stringify(diag, null, 2)}`);
          }
          return errorResult(errMsg);
        }
        // Use the resolved name from the server (may be a generated unique name)
        const participant = res.data as { name: string; projectId?: string | null };
        setSessionEntry({ name: participant.name, projectId: participant.projectId ?? null });
        // Attach rules of engagement so the joining LLM knows how to behave
        const rules = getEffectiveRules(participant.projectId);
        return jsonResult({ ...participant, rules });
      } finally {
        joinInFlight = false;
      }
    },
  );

  // ── 2. chat_leave ─────────────────────────────────────────────────────

  server.tool(
    'chat_leave',
    'Leave the chat room. Uses the name from the current session.',
    {},
    async () => {
      if (joinInFlight) {
        return errorResult('chat_join is still in progress for this MCP session. Wait for it to finish before leaving.');
      }
      if (!sessionEntry) return errorResult('Not joined — call chat_join first');
      const current = sessionEntry;
      const res = await chatApi('/leave', { name: current.name, projectId: current.projectId });
      if (!res.ok) {
        if (res.status === 404) {
          setSessionEntry(null);
          return jsonResult({ ok: true, left: current.name, stale: true });
        }
        return errorResult((res.data as { error?: string })?.error ?? 'Leave failed');
      }
      setSessionEntry(null);
      return jsonResult(res.data);
    },
  );

  // ── 3. chat_send ──────────────────────────────────────────────────────

  server.tool(
    'chat_send',
    'Send a message to the chat room. Omit "to" for broadcast, or specify a recipient name. Messages that start with #pipe- or reference a currently running #pipe-* are rejected — use pipe_submit for pipe stage output.',
    {
      message: z.string().describe('Message text (markdown supported)'),
      to: z.string().optional().describe('Recipient name for direct message, or omit for broadcast'),
    },
    async ({ message, to }) => {
      const sessionName = getSessionName();
      const sessionProjectId = getSessionProjectId();
      if (!sessionName) return errorResult('Not joined — call chat_join first');
      const res = await chatApi('/send', { from: sessionName, message, to, projectId: sessionProjectId });
      if (!res.ok) return errorResult((res.data as { error?: string })?.error ?? 'Send failed');
      return jsonResult(res.data);
    },
  );

  // ── 3b. pipe_submit ─────────────────────────────────────────────────

  server.tool(
    'pipe_submit',
    'Submit your output for a pipe stage. Use this instead of chat_send when responding to a #pipe- prompt. Accepts pipeId in any format: "#pipe-abc123", "pipe-abc123", or just "abc123".',
    {
      pipeId: z.string().describe('The pipe ID — accepts "#pipe-abc123", "pipe-abc123", or just "abc123"'),
      content: z.string().describe('Your stage output content (markdown supported)'),
    },
    async ({ pipeId, content }) => {
      const sessionName = getSessionName();
      const sessionProjectId = getSessionProjectId();
      if (!sessionName) return errorResult('Not joined — call chat_join first');
      // Normalize pipeId: strip leading "#pipe-" or "pipe-" prefix to get the bare ID
      const normalizedPipeId = pipeId.replace(/^#?pipe-/i, '');
      const res = await chatApi(`/pipes/${encodeURIComponent(normalizedPipeId)}/submit`, {
        from: sessionName,
        content,
        projectId: sessionProjectId,
      });
      if (!res.ok) return errorResult((res.data as { error?: string })?.error ?? 'Pipe submit failed');
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
      const messages = store.readMessages({ limit, since }, getSessionProjectId());
      return jsonResult(messages);
    },
  );

  // ── 5. chat_members ───────────────────────────────────────────────────

  server.tool(
    'chat_members',
    'List active chat participants with their pane link status.',
    {},
    async () => {
      // Use REST API for consistent behavior — direct registry calls can miss
      // participants when sessionProjectId is null (before join or after restart).
      const res = await chatApi('/members');
      if (!res.ok) return errorResult('Failed to fetch members');
      return jsonResult(res.data);
    },
  );

  // ── 6. chat_status ────────────────────────────────────────────────────

  server.tool(
    'chat_status',
    'Check your current chat connection status and diagnostics. Use this to debug delivery issues or verify your session is healthy.',
    {},
    async () => {
      const pid = getSessionProjectId();
      const sessionName = getSessionName();
      const joined = !!sessionName;

      // Use REST API for consistent behavior — avoids project-scoping issues
      // when sessionProjectId is null (before join or after restart).
      const statusQuery = sessionName ? `?name=${encodeURIComponent(sessionName)}${pid ? `&projectId=${encodeURIComponent(pid)}` : ''}` : '';
      const statusRes = await chatApi(`/status${statusQuery}`).catch(() => null);
      if (statusRes?.ok) {
        const data = statusRes.data as Record<string, unknown>;
        return jsonResult({ joined, name: sessionName, ...data });
      }
      if (statusRes?.status === 404 && sessionEntry) {
        setSessionEntry(null);
        return jsonResult({
          joined: false,
          name: null,
          projectId: pid,
          error: `Tracked participant "${sessionName}" is no longer registered.`,
        });
      }

      // Fallback to basic info if REST fails
      return jsonResult({
        joined,
        name: sessionName,
        projectId: pid,
        error: 'Could not fetch status from REST API',
      });
    },
  );

  return server;
}
