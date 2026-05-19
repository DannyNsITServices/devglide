import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const builderStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  match: vi.fn(),
  getCompiledInstructions: vi.fn(),
}));

const runManagerMock = vi.hoisted(() => ({
  startRun: vi.fn(),
  listRuns: vi.fn(() => []),
  getRun: vi.fn(),
  addClient: vi.fn(),
  removeClient: vi.fn(),
  cancelRun: vi.fn(),
}));

vi.mock('../apps/workflow/services/workflow-store.js', () => ({
  WorkflowStore: {
    getInstance: () => builderStoreMock,
  },
}));

vi.mock('../apps/workflow/services/run-manager.js', () => ({
  RunManager: {
    getInstance: () => runManagerMock,
  },
}));

vi.mock('../apps/workflow/engine/node-registry.js', () => ({
  getRegisteredTypes: () => ['trigger', 'action:shell', 'action:kanban', 'decision', 'loop'],
}));

vi.mock('../apps/workflow/engine/executors/index.js', () => ({
  registerAllExecutors: vi.fn(),
}));

vi.mock('../project-context.js', () => ({
  getActiveProject: () => ({ id: 'project-1', name: 'Test', path: '/tmp/project-1' }),
}));

const { router } = await import('./workflow.js');

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

describe('workflow router graph validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    builderStoreMock.get.mockReset();
    builderStoreMock.save.mockReset();
  });

  it('rejects invalid workflow creation before save', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Broken workflow',
          nodes: [{ id: 'a1', type: 'action:shell', label: 'No trigger', config: {}, position: { x: 0, y: 0 } }],
          edges: [],
        }),
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'Invalid workflow graph',
        validationErrors: ['Workflow must have at least one trigger node', 'Node "No trigger" (a1) is disconnected from the graph'],
      });
    });

    expect(builderStoreMock.save).not.toHaveBeenCalled();
  });

  it('rejects invalid merged graph updates before save', async () => {
    builderStoreMock.get.mockResolvedValue({
      id: 'wf-1',
      name: 'Existing workflow',
      description: '',
      version: 1,
      projectId: 'project-1',
      tags: [],
      nodes: [
        { id: 't1', type: 'trigger', label: 'Trigger', config: {}, position: { x: 0, y: 0 } },
        { id: 'a1', type: 'action:shell', label: 'Action', config: {}, position: { x: 100, y: 0 } },
      ],
      edges: [{ id: 't1-a1', source: 't1', target: 'a1' }],
      variables: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/workflows/wf-1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          edges: [{ id: 'bad-edge', source: 't1', target: 'missing-node' }],
        }),
      });

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toBe('Invalid workflow graph');
      expect(body.validationErrors).toContain('Edge "bad-edge" references non-existent target node "missing-node"');
    });

    expect(builderStoreMock.save).not.toHaveBeenCalled();
  });
});
