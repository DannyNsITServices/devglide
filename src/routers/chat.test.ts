import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMock = vi.hoisted(() => ({
  send: vi.fn(),
  listParticipants: vi.fn(() => []),
  join: vi.fn(),
  leave: vi.fn(() => true),
  clearHistory: vi.fn(),
  setChatNsp: vi.fn(),
  getChatNsp: vi.fn(() => null),
  getActivePipes: vi.fn(() => []),
  getPipeRun: vi.fn(() => null),
  getPipeStoreStatus: vi.fn(() => null),
  submitPipeStage: vi.fn(),
  cancelPipeRun: vi.fn(),
  restoreParticipants: vi.fn(() => ({ restored: [], failed: [] })),
  restorePipes: vi.fn(() => []),
}));

const storeMock = vi.hoisted(() => ({
  readMessages: vi.fn(() => []),
  appendMessage: vi.fn((_msg: unknown, _pid?: string | null) => ({
    id: 'sys-msg-1',
    ts: '2026-03-23T00:00:00.000Z',
    from: 'system',
    to: null,
    body: 'collision message',
    type: 'system',
  })),
}));

const rulesMock = vi.hoisted(() => ({
  getEffectiveRules: vi.fn(() => '## Rules\n\nOnly reply when asked.'),
  getDefaultRules: vi.fn(() => '## Default Rules'),
  saveProjectRules: vi.fn(),
  deleteProjectRules: vi.fn(() => true),
  hasProjectRules: vi.fn(() => false),
}));

const projectContextMock = vi.hoisted(() => ({
  getActiveProject: vi.fn(() => ({ id: 'project-1', name: 'Test Project', path: '/tmp/project-1' })),
  onProjectChange: vi.fn(),
}));

vi.mock('../apps/chat/services/chat-registry.js', () => registryMock);
vi.mock('../apps/chat/services/chat-store.js', () => storeMock);
vi.mock('../apps/chat/services/chat-rules.js', () => rulesMock);
vi.mock('../project-context.js', () => projectContextMock);
const pane1PtyWrite = vi.fn();
const shellStateMock = vi.hoisted(() => ({
  globalPtys: null as unknown as Map<string, unknown>,
  dashboardState: null as unknown as { panes: Array<Record<string, unknown>>; activeTab: string; activePaneId: string },
}));

let paneIdCounter = 100;
vi.mock('../apps/shell/src/runtime/shell-state.js', () => {
  const globalPtys = new Map([
    ['pane-1', { ptyProcess: { write: pane1PtyWrite }, chunks: [], totalLen: 0 }],
  ]);
  const dashboardState = {
    panes: [{ id: 'pane-1', projectId: 'project-1', num: 1, title: '1', shellType: 'default', cwd: '/tmp' }],
    activeTab: 'grid',
    activePaneId: 'pane-1',
  };
  shellStateMock.globalPtys = globalPtys;
  shellStateMock.dashboardState = dashboardState;
  return {
    globalPtys,
    dashboardState,
    getShellNsp: vi.fn(() => null),
    nextPaneId: vi.fn(() => `pane-${++paneIdCounter}`),
    nextNumForProject: vi.fn(() => 2),
    MAX_PANES: 10,
    panesForProject: vi.fn(() => 1),
  };
});
vi.mock('../apps/shell/src/runtime/pty-manager.js', () => ({
  spawnGlobalPty: vi.fn(),
}));
vi.mock('../apps/shell/src/runtime/shell-config.js', () => ({
  SHELL_CONFIGS: {
    bash: { command: '/bin/bash', args: [], env: {} },
    'git-bash': { command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [], env: {} },
  },
}));

const execSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: execSyncMock };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock('../apps/chat/mcp.js', () => ({
  createChatMcpServer: vi.fn(),
  chatServerSessions: new WeakMap(),
}));

const { router } = await import('./chat.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = makeApp();
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('chat router rules of engagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readMessages.mockReturnValue([]);
    registryMock.listParticipants.mockReturnValue([]);
    registryMock.getPipeStoreStatus.mockReturnValue(null);
    registryMock.getPipeRun.mockReturnValue(null);
  });

  afterEach(() => {
    registryMock.join.mockReset();
    registryMock.send.mockReset();
    registryMock.leave.mockReset();
    registryMock.submitPipeStage.mockReset();
    rulesMock.getEffectiveRules.mockClear();
    rulesMock.getDefaultRules.mockClear();
    rulesMock.saveProjectRules.mockClear();
    rulesMock.deleteProjectRules.mockClear();
    rulesMock.hasProjectRules.mockClear();
    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-1', name: 'Test Project', path: '/tmp/project-1' });
  });

  it('returns effective rules in the join response', async () => {
    registryMock.join.mockReturnValue({
      name: 'vera',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'codex', model: 'codex', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        name: 'vera',
        paneId: 'pane-1',
        rules: '## Rules\n\nOnly reply when asked.',
      });
      expect(registryMock.join).toHaveBeenCalledWith('codex', 'llm', 'pane-1', 'codex', '\r', 'project-1');
    });
  });

  it('joins the pane project even when the active project is different', async () => {
    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-2', name: 'Other Project', path: '/tmp/project-2' });
    registryMock.join.mockReturnValue({
      name: 'codex-1',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'codex', model: 'codex', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.join).toHaveBeenCalledWith('codex', 'llm', 'pane-1', 'codex', '\r', 'project-1');
    });
  });

  it('rejects paneId "auto" for LLM participants', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'auto' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/explicit paneId/i);
      expect(registryMock.join).not.toHaveBeenCalled();
    });
  });

  it('returns 409 and disconnects existing claimer on pane collision', async () => {
    // Set up: pane-1 is already claimed by 'codex-1'
    registryMock.listParticipants.mockReturnValue([
      {
        name: 'codex-1',
        kind: 'llm',
        model: 'codex',
        paneId: 'pane-1',
        projectId: 'project-1',
        submitKey: '\r',
        joinedAt: '2026-03-23T00:00:00.000Z',
        lastSeen: '2026-03-23T00:00:00.000Z',
        detached: false,
      },
    ]);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toMatch(/collision/i);
      expect(data.collision).toEqual({
        paneId: 'pane-1',
        disconnected: 'codex-1',
      });

      // Existing claimer should be disconnected
      expect(registryMock.leave).toHaveBeenCalledWith('codex-1', 'project-1');

      // System message should be recorded in the collided pane's project
      expect(storeMock.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'system',
          type: 'system',
          body: expect.stringContaining('collision'),
        }),
        'project-1',
      );

      // Collision error should be written to the pane's PTY
      expect(pane1PtyWrite).toHaveBeenCalledWith(
        expect.stringContaining('paneId collision on pane-1'),
      );

      // join should NOT be called — collision prevents it
      expect(registryMock.join).not.toHaveBeenCalled();
    });
  });

  it('uses the collided pane project for cross-project collision events', async () => {
    // Active project is project-2, but pane-1 belongs to project-1
    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-2', name: 'Other Project', path: '/tmp/project-2' });
    registryMock.listParticipants.mockReturnValue([
      {
        name: 'codex-1',
        kind: 'llm',
        model: 'codex',
        paneId: 'pane-1',
        projectId: 'project-1',
        submitKey: '\r',
        joinedAt: '2026-03-23T00:00:00.000Z',
        lastSeen: '2026-03-23T00:00:00.000Z',
        detached: false,
      },
    ]);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(409);

      // leave and appendMessage should use the pane's project (project-1), not active (project-2)
      expect(registryMock.leave).toHaveBeenCalledWith('codex-1', 'project-1');
      expect(storeMock.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'system', type: 'system' }),
        'project-1',
      );
    });
  });

  it('rejects #pipe- prefixed messages on POST /send with 422', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '#pipe-abc123 my analysis here' }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error).toMatch(/pipe.*submit/i);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('rejects #pipe- prefixed messages with leading whitespace on POST /send', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '  #pipe-abc123 my analysis here' }),
      });

      expect(response.status).toBe(422);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('allows normal messages on POST /send', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-1',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'claude-1',
      to: null,
      body: 'Hello everyone',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: 'Hello everyone' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalled();
    });
  });

  it('allows messages mentioning pipes without the #pipe- prefix on POST /send', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-2',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'claude-1',
      to: null,
      body: 'I submitted to pipe-abc123 already',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: 'I submitted to pipe-abc123 already' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalled();
    });
  });

  it('rejects messages that reference a currently running pipe on POST /send', async () => {
    registryMock.getPipeStoreStatus.mockReturnValue({ pipeId: 'abc123', status: 'running' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '@user update on #pipe-abc123 is blocked' }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error).toMatch(/currently running pipes/i);
      expect(data.error).toMatch(/#pipe-abc123/i);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('allows messages that reference non-running pipes on POST /send', async () => {
    registryMock.getPipeStoreStatus.mockReturnValue({ pipeId: 'abc123', status: 'completed' });
    registryMock.send.mockResolvedValue({
      id: 'msg-2b',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'claude-1',
      to: null,
      body: '@user the work on #pipe-abc123 is complete',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '@user the work on #pipe-abc123 is complete' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalled();
    });
  });

  it('returns effective/default rules metadata from GET /rules', async () => {
    rulesMock.hasProjectRules.mockReturnValue(true);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/rules`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        rules: '## Rules\n\nOnly reply when asked.',
        isDefault: false,
        defaultRules: '## Default Rules',
      });
    });
  });

  it('accepts pipe submissions through POST /pipes/:id/submit', async () => {
    registryMock.submitPipeStage.mockResolvedValue({
      ok: true,
      message: {
        id: 'pipe-msg-1',
        ts: '2026-03-25T00:00:00.000Z',
        from: 'claude-1',
        to: null,
        body: '#pipe-abc123 my analysis',
        type: 'message',
        pipe: { pipeId: 'abc123', mode: 'merge-all', role: 'fan-out' },
      },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/pipes/abc123/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', content: 'my analysis' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.message.pipe.pipeId).toBe('abc123');
      expect(registryMock.submitPipeStage).toHaveBeenCalledWith('abc123', 'claude-1', 'my analysis', 'project-1');
    });
  });

  it('rejects running pipe references on POST /messages (dashboard user endpoint)', async () => {
    registryMock.getPipeRun.mockReturnValue({ pipeId: 'abc123', mode: 'merge-all', status: 'running', projectId: 'project-1' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '@claude-1 please check #pipe-abc123' }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error).toMatch(/currently running pipes/i);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('allows non-running pipe references on POST /messages (dashboard user endpoint)', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-3',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'user',
      to: null,
      body: '@claude-1 pipe #pipe-abc123 is archived',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '@claude-1 pipe #pipe-abc123 is archived' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalledWith('user', '@claude-1 pipe #pipe-abc123 is archived', undefined);
    });
  });

});

describe('chat router invite permission modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && (cmd.startsWith('claude') || cmd.startsWith('codex'))) return '';
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(false);
  });

  it('GET /invite/available returns modes per CLI', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite/available?rescan=true`);
      expect(response.status).toBe(200);
      const data = await response.json();

      const claude = data.find((l: { cli: string }) => l.cli === 'claude');
      expect(claude).toBeDefined();
      expect(claude.modes).toContain('supervised');
      expect(claude.modes).toContain('auto-accept');

      const codex = data.find((l: { cli: string }) => l.cli === 'codex');
      expect(codex).toBeDefined();
      expect(codex.modes).toContain('supervised');
      expect(codex.modes).toContain('auto-accept');
    });
  });

  it('POST /invite accepts mode parameter and returns it', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.mode).toBe('auto-accept');
    });
  });

  it('POST /invite defaults to supervised when mode is omitted', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.mode).toBe('supervised');
    });
  });

  it('POST /invite rejects unsupported mode for a CLI', async () => {
    // gemini is not installed in this mock, so use claude with 'unrestricted' which it doesn't support
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'unrestricted' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/does not support/i);
    });
  });

  it('POST /invite stores permissionMode on pane info', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // Verify the pane was added to dashboardState with permissionMode
      const pane = shellStateMock.dashboardState.panes.find(
        (p: { id: string }) => p.id === data.paneId,
      );
      expect(pane).toBeDefined();
      expect(pane.permissionMode).toBe('auto-accept');
    });
  });
});
