import { z } from 'zod';
import { createDevglideMcpServer, jsonResult, errorResult } from '../../../packages/mcp-utils/src/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const UNIFIED_BASE = `http://localhost:${process.env.DEVGLIDE_PORT ?? process.env.PORT ?? 7000}`;

/** Fetch helper that proxies to the unified server's shell REST API. */
async function shellApi(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${UNIFIED_BASE}/api/shell${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/**
 * Create a shell MCP server with terminal management tools.
 * All tools proxy to the unified HTTP server's REST API so they work
 * identically in both stdio and HTTP-transport modes.
 */
export function createShellMcpServer(): McpServer {
  const server = createDevglideMcpServer('devglide-shell', '0.1.0');

  server.tool(
    'shell_list_panes',
    'List active terminal panes with CWD',
    {},
    async () => {
      const { ok, data } = await shellApi('/panes');
      if (!ok) return errorResult(`Failed to list panes: ${JSON.stringify(data)}`);
      return jsonResult(data);
    }
  );

  server.tool(
    'shell_create_pane',
    'Create a new terminal pane (uses system default shell, or specify bash/cmd)',
    {
      shellType: z
        .enum(['default', 'bash', 'cmd'])
        .optional()
        .describe('Shell type (default: system shell from $SHELL, cmd on Windows)'),
      cwd: z.string().optional().describe('Working directory'),
    },
    async ({ shellType, cwd }) => {
      const { ok, data } = await shellApi('/panes', 'POST', { shellType, cwd });
      if (!ok) return errorResult(typeof data === 'object' && data && 'error' in data ? String((data as Record<string, unknown>).error) : JSON.stringify(data));
      return jsonResult(data);
    }
  );

  server.tool(
    'shell_close_pane',
    'Close a terminal pane',
    {
      paneId: z.string().describe("Pane ID (e.g. 'pane-1')"),
    },
    async ({ paneId }) => {
      const { ok, data } = await shellApi(`/panes/${encodeURIComponent(paneId)}`, 'DELETE');
      if (!ok) return errorResult(typeof data === 'object' && data && 'error' in data ? String((data as Record<string, unknown>).error) : JSON.stringify(data));
      return { content: [{ type: 'text' as const, text: `Pane ${paneId} closed.` }] };
    }
  );

  server.tool(
    'shell_run_command',
    'Send input to a terminal pane and return output after a timeout',
    {
      paneId: z.string().describe("Pane ID (e.g. 'pane-1')"),
      command: z.string().describe('Command to execute'),
      timeout: z
        .number()
        .optional()
        .describe('Seconds to wait for output (default: 3, max: 30)'),
    },
    async ({ paneId, command, timeout }) => {
      const { ok, data } = await shellApi(
        `/panes/${encodeURIComponent(paneId)}/run`,
        'POST',
        { command, timeout },
      );
      if (!ok) return errorResult(typeof data === 'object' && data && 'error' in data ? String((data as Record<string, unknown>).error) : JSON.stringify(data));
      const output = typeof data === 'object' && data && 'output' in data ? String((data as Record<string, unknown>).output) : JSON.stringify(data);
      return { content: [{ type: 'text' as const, text: output }] };
    }
  );

  server.tool(
    'shell_get_scrollback',
    'Get recent scrollback buffer from a terminal pane',
    {
      paneId: z.string().describe("Pane ID (e.g. 'pane-1')"),
      lines: z
        .number()
        .optional()
        .describe('Number of recent lines to return (default: 100)'),
    },
    async ({ paneId, lines }) => {
      const { ok, data } = await shellApi(
        `/panes/${encodeURIComponent(paneId)}/scrollback${lines ? `?lines=${lines}` : ''}`,
      );
      if (!ok) return errorResult(typeof data === 'object' && data && 'error' in data ? String((data as Record<string, unknown>).error) : JSON.stringify(data));
      const output = typeof data === 'object' && data && 'output' in data ? String((data as Record<string, unknown>).output) : JSON.stringify(data);
      return { content: [{ type: 'text' as const, text: output }] };
    }
  );

  return server;
}
