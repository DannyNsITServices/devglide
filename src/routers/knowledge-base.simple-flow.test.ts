import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { router as kbRouter, resetBuilderLlmClient } from './knowledge-base.js';
import { KnowledgeBaseStore } from '../apps/knowledge-base/services/knowledge-base-store.js';
import { errorHandler } from '../packages/error-middleware.js';

let server: http.Server;
let baseUrl: string;
let tmpRoot: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-base', kbRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/knowledge-base`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-router-simple-flow-'));
  KnowledgeBaseStore.resetForTests(tmpRoot);
});

afterEach(async () => {
  resetBuilderLlmClient();
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(url: string, body?: object): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function put(url: string, body: object): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('REST /api/knowledge-base simple compose flow', () => {
  it('POST /compose creates a wiki from ingested raw notes without any LLM setup', async () => {
    const raw = await post(`${baseUrl}/ingest`, {
      content: '# Route Note\n\nImportant raw details.',
      source: 'manual',
    });
    expect(raw.status).toBe(201);

    const rawId = raw.body.note.id;
    const composed = await post(`${baseUrl}/compose`, {
      pagePath: 'notes/simple-flow/overview',
      title: 'Simple Flow Wiki',
      sourceIds: [rawId],
    });

    expect(composed.status).toBe(201);
    expect(composed.body.note.id).toMatch(/^kb_/);
    expect(composed.body.note.kind).toBe('wiki');
    expect(composed.body.note.sourceRefs).toEqual([rawId]);
    expect(composed.body.note.lastComposedBodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof composed.body.note.body).toBe('string');
    expect(composed.body.note.body.length).toBeGreaterThan(0);

    const rawAfter = await get(`${baseUrl}/notes/${rawId}`);
    expect(rawAfter.status).toBe(200);
    expect(rawAfter.body.note.consumedBy).toContain(composed.body.note.id);

    const derivatives = await get(`${baseUrl}/trace/derivatives/${rawId}`);
    expect(derivatives.status).toBe(200);
    expect(derivatives.body.derivatives.map((note: any) => note.id)).toContain(composed.body.note.id);
  });

  it('POST /compose/rebuild/:pageId rejects manual edits and force rebuild succeeds', async () => {
    const raw = await post(`${baseUrl}/ingest`, {
      content: '# Raw For Rebuild\n\nOriginal source body.',
      source: 'manual',
    });
    expect(raw.status).toBe(201);

    const rawId = raw.body.note.id;
    const composed = await post(`${baseUrl}/compose`, {
      pagePath: 'notes/rebuild-flow/overview',
      title: 'Rebuild Flow Wiki',
      sourceIds: [rawId],
    });
    expect(composed.status).toBe(201);

    const pageId = composed.body.note.id;
    const originalBody = composed.body.note.body;
    const originalHash = composed.body.note.lastComposedBodyHash;

    const edited = await put(`${baseUrl}/notes/${pageId}`, {
      content: `${originalBody}\n\nManual edit that rebuild must not overwrite silently.`,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.note.body).toContain('Manual edit');
    expect(edited.body.note.lastComposedBodyHash).toBe(originalHash);

    const blocked = await post(`${baseUrl}/compose/rebuild/${pageId}`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('manual_edits_present');

    const unchanged = await get(`${baseUrl}/notes/${pageId}`);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.note.body).toContain('Manual edit');
    expect(unchanged.body.note.lastComposedBodyHash).toBe(originalHash);

    const rebuilt = await post(`${baseUrl}/compose/rebuild/${pageId}`, { force: true });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.note.id).toBe(pageId);
    expect(rebuilt.body.note.kind).toBe('wiki');
    expect(rebuilt.body.note.sourceRefs).toEqual([rawId]);
    expect(rebuilt.body.note.body).not.toContain('Manual edit');
    expect(rebuilt.body.note.lastComposedBodyHash).toBe(originalHash);

    const tracedSources = await get(`${baseUrl}/trace/sources/${pageId}`);
    expect(tracedSources.status).toBe(200);
    expect(tracedSources.body.sources.map((note: any) => note.id)).toEqual([rawId]);

    const rawAfter = await get(`${baseUrl}/notes/${rawId}`);
    expect(rawAfter.status).toBe(200);
    expect(rawAfter.body.note.consumedBy).toContain(pageId);
  });
});
