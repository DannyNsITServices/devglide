import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

/** Format a JSON-serializable value as an MCP text result. */
export function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Format an error message as an MCP error result. */
export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function createDevglideMcpServer(
  name: string,
  version: string,
  description?: string,
  options?: { instructions?: string | string[] }
): McpServer {
  const serverOpts = options
    ? {
        ...options,
        instructions: Array.isArray(options.instructions)
          ? options.instructions.join('\n')
          : options.instructions,
      }
    : undefined;
  return new McpServer(
    { name, version, ...(description && { description }) },
    ...(serverOpts ? [serverOpts] : [])
  );
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(
      (msg) =>
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).method === "initialize"
    );
  }
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).method === "initialize"
  );
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessed: number;
}

/** HTTP request with parsed body — compatible with Express and Node http.IncomingMessage. */
type McpHttpRequest = IncomingMessage & { body?: unknown };

/**
 * Mount an MCP StreamableHTTP endpoint on an Express-compatible app.
 * Each session gets its own McpServer instance via the factory function.
 */
export function mountMcpHttp(
  app: {
    post: (path: string, handler: (req: McpHttpRequest, res: ServerResponse) => void | Promise<void>) => void;
    get: (path: string, handler: (req: McpHttpRequest, res: ServerResponse) => void | Promise<void>) => void;
    delete: (path: string, handler: (req: McpHttpRequest, res: ServerResponse) => void | Promise<void>) => void;
  },
  serverFactory: () => McpServer,
  path: string = "/mcp",
  options?: { onSessionOpen?: (sessionId: string, server: McpServer) => void; onSessionClose?: (server: McpServer, sessionId?: string) => void }
): void {
  const sessions = new Map<string, McpSession>();

  // TTL cleanup: remove sessions not accessed in 30 minutes
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const ttlTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.lastAccessed < cutoff) {
        // Delete from the map first so transport.close() -> onclose doesn't
        // find the session and invoke onSessionClose a second time.
        sessions.delete(id);
        options?.onSessionClose?.(session.server, id);
        session.transport.close?.();
      }
    }
  }, 5 * 60 * 1000);
  ttlTimer.unref();

  // Express does not await async handlers — a rejection from
  // transport.handleRequest would surface as a process-level
  // unhandledRejection instead of a 500. Funnel through this guard.
  const guard =
    (fn: (req: McpHttpRequest, res: ServerResponse) => Promise<void>) =>
    async (req: McpHttpRequest, res: ServerResponse) => {
      try {
        await fn(req, res);
      } catch (err) {
        console.error("[mcp-http] handler error:", err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            })
          );
        } else {
          try { res.end(); } catch { /* socket already gone */ }
        }
      }
    };

  app.post(path, guard(async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastAccessed = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, server, lastAccessed: Date.now() });
          options?.onSessionOpen?.(id, server);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          const closingSession = sessions.get(transport.sessionId);
          if (closingSession) options?.onSessionClose?.(closingSession.server, transport.sessionId);
          sessions.delete(transport.sessionId);
        }
      };

      const server = serverFactory();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null,
      })
    );
  }));

  app.get(path, guard(async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        })
      );
      return;
    }
    const getSession = sessions.get(sessionId)!;
    getSession.lastAccessed = Date.now();
    await getSession.transport.handleRequest(req, res);
  }));

  app.delete(path, guard(async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        })
      );
      return;
    }
    const delSession = sessions.get(sessionId)!;
    delSession.lastAccessed = Date.now();
    await delSession.transport.handleRequest(req, res);
  }));
}

/**
 * Run an MCP server in stdio mode (for Claude Desktop / CLI usage).
 */
export async function runStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
