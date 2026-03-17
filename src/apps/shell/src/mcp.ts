import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createDevglideMcpServer } from '../../../packages/mcp-utils/src/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import type { McpState, PaneInfo } from './shell-types.js';
import { getActiveProject } from '../../../project-context.js';

/** Send SIGHUP, then SIGKILL after 2 s if still alive. */
function killPty(pty: { pid: number; kill(signal?: string): void }): void {
  try {
    pty.kill();
  } catch {
    return;
  }
  const { pid } = pty;
  setTimeout(() => {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch { /* already exited */ }
  }, 2000).unref();
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Create a shell MCP server with terminal management tools.
 */
export function createShellMcpServer(state: McpState): McpServer {
  const server = createDevglideMcpServer('devglide-shell', '0.1.0');

  server.tool(
    'shell_list_panes',
    'List active terminal panes with CWD',
    {},
    async () => {
      const panes = state.dashboardState.panes.map((p) => ({
        id: p.id,
        num: p.num,
        shellType: p.shellType,
        title: p.title,
        cwd: p.cwd,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(panes, null, 2) }],
      };
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
    async ({ shellType = 'default', cwd }) => {
      if (state.globalPtys.size >= state.MAX_PANES) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Maximum pane limit (${state.MAX_PANES}) reached`,
            },
          ],
          isError: true,
        };
      }

      const id = state.nextPaneId();
      const num = state.dashboardState.panes.length + 1;
      const title = String(num);
      const config = state.SHELL_CONFIGS[shellType] || state.SHELL_CONFIGS.default;
      let args = config.args;
      let startCwd = process.env.HOME || process.env.USERPROFILE || '/';

      if (cwd) {
        if (!path.isAbsolute(cwd) || cwd.includes('\0') || /\.\.[\\/]/.test(cwd)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid cwd: must be absolute without traversal or null bytes' }],
            isError: true,
          };
        }
        try {
          const stat = fs.statSync(cwd);
          if (!stat.isDirectory()) throw new Error('not a directory');
        } catch {
          return {
            content: [{ type: 'text' as const, text: 'cwd path does not exist or is not a directory' }],
            isError: true,
          };
        }
        startCwd = cwd;
      }

      try {
        console.log(`[shell:mcp] create_pane shell=${shellType} cwd=${startCwd}`);

        state.spawnGlobalPty(
          id,
          config.command,
          args,
          config.env,
          80,
          24,
          true,
          false,
          startCwd
        );

        const paneInfo: PaneInfo = { id, shellType, title, num, cwd: startCwd, projectId: getActiveProject()?.id || null };
        state.dashboardState.panes.push(paneInfo);
        state.dashboardState.activePaneId = id;
        state.io.emit('state:pane-added', paneInfo);
        state.io.emit('state:active-pane', { paneId: id });

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(paneInfo, null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            { type: 'text' as const, text: `Failed to start ${shellType}: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'shell_close_pane',
    'Close a terminal pane',
    {
      paneId: z.string().describe("Pane ID (e.g. 'pane-1')"),
    },
    async ({ paneId }) => {
      const entry = state.globalPtys.get(paneId);
      const existed = state.dashboardState.panes.some((p) => p.id === paneId);
      if (!entry && !existed) {
        return {
          content: [{ type: 'text' as const, text: 'Pane not found' }],
          isError: true,
        };
      }

      console.log(`[shell:mcp] close_pane pane=${paneId}`);

      if (entry) {
        killPty(entry.ptyProcess);
        state.globalPtys.delete(paneId);
      }

      // Find index of closing pane before removal so we can select the previous one
      const closedIdx = state.dashboardState.panes.findIndex(
        (p) => p.id === paneId
      );

      state.dashboardState.panes = state.dashboardState.panes.filter(
        (p) => p.id !== paneId
      );
      state.io.emit('state:pane-removed', { id: paneId });

      // Clean up resize arbitration
      state.paneActiveSocket.delete(paneId);
      if (state.socketDimensions) {
        for (const dims of state.socketDimensions.values()) dims.delete(paneId);
      }

      // Renumber remaining panes
      state.dashboardState.panes.forEach((p, i) => {
        p.num = i + 1;
        p.title = String(i + 1);
      });
      if (state.dashboardState.panes.length > 0) {
        state.io.emit(
          'state:panes-renumbered',
          state.dashboardState.panes.map(({ id, num }) => ({ id, num }))
        );
      }

      // Select the previous pane (or next if closing the first one)
      const prevIdx = Math.max(0, closedIdx - 1);
      const nextPane =
        state.dashboardState.panes.length > 0
          ? state.dashboardState.panes[prevIdx].id
          : null;

      if (state.dashboardState.activeTab === paneId) {
        // The closed pane was the focused tab — navigate to previous pane or back to grid
        const next = nextPane ?? 'grid';
        state.dashboardState.activeTab = next;
        state.dashboardState.activePaneId = nextPane;
        state.io.emit('state:active-tab', { tabId: next });
      }

      // Always update active pane highlight
      state.dashboardState.activePaneId = nextPane;
      state.io.emit('state:active-pane', { paneId: nextPane });

      return {
        content: [{ type: 'text' as const, text: `Pane ${paneId} closed.` }],
      };
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
      const entry = state.globalPtys.get(paneId);
      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: 'Pane not found' }],
          isError: true,
        };
      }

      console.log(`[shell:mcp] run_command pane=${paneId} command=${JSON.stringify(command.slice(0, 200))}`);

      const maxMs = Math.min((timeout ?? 3) * 1000, 30000);
      // Use tracked totalLen (O(1)) instead of joining all chunks (O(n)) for polling
      const beforeLen = entry.totalLen;

      entry.ptyProcess.write(command + '\r');

      // Poll for output quiescence instead of waiting the full timeout
      let lastLen = beforeLen;
      let stableCount = 0;
      const POLL_MS = 100;
      const STABLE_THRESHOLD = 3; // 300ms of no new output = done

      await new Promise<void>((resolve) => {
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += POLL_MS;
          const currentLen = entry.totalLen;
          if (currentLen > lastLen) {
            lastLen = currentLen;
            stableCount = 0;
          } else {
            stableCount++;
          }
          if (stableCount >= STABLE_THRESHOLD || elapsed >= maxMs) {
            clearInterval(interval);
            resolve();
          }
        }, POLL_MS);
      });

      // Join chunks once at the end to extract new output
      const fullOutput = entry.chunks.join('');
      let newOutput = fullOutput.slice(Math.min(beforeLen, fullOutput.length));

      // Strip the echoed command line (first line) and ANSI escape sequences
      const lines = newOutput.split('\n');
      if (lines.length > 1) lines.shift(); // remove echoed command
      newOutput = lines.join('\n').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

      return {
        content: [{ type: 'text' as const, text: newOutput || '(no output)' }],
      };
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
      const entry = state.globalPtys.get(paneId);
      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: 'Pane not found' }],
          isError: true,
        };
      }

      const limit = lines ?? 100;
      const fullOutput = entry.chunks.join('');
      const allLines = fullOutput.split('\n');
      const recent = allLines.slice(-limit).join('\n');

      return {
        content: [{ type: 'text' as const, text: recent || '(empty)' }],
      };
    }
  );

  return server;
}

/**
 * Mount MCP StreamableHTTP endpoint on an Express app.
 */
export function mountShellMcp(app: Express, state: McpState): void {
  const sessions = new Map<string, McpSession>();

  function isInitReq(body: unknown): boolean {
    if (Array.isArray(body))
      return body.some((m: unknown) => m && typeof m === 'object' && (m as Record<string, unknown>).method === 'initialize');
    return body !== null && typeof body === 'object' && (body as Record<string, unknown>).method === 'initialize';
  }

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitReq(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createShellMcpServer(state);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null,
      })
    );
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID' },
          id: null,
        })
      );
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID' },
          id: null,
        })
      );
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  });
}
