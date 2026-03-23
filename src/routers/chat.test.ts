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
  return { globalPtys, dashboardState, getShellNsp: vi.fn(() => null) };
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
  });

  afterEach(() => {
    registryMock.join.mockReset();
    registryMock.send.mockReset();
    registryMock.leave.mockReset();
    rulesMock.getEffectiveRules.mockClear();
    rulesMock.getDefaultRules.mockClear();
    rulesMock.saveProjectRules.mockClear();
    rulesMock.deleteProjectRules.mockClear();
    rulesMock.hasProjectRules.mockClear();
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

});
