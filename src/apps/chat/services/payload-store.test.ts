import { describe, it, expect, beforeEach } from 'vitest';
import * as payloadStore from './payload-store.js';
import { createTestClock } from './clock.js';

beforeEach(() => {
  payloadStore._resetForTest();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestPayload(overrides?: {
  pipeId?: string;
  stageId?: string;
  content?: string;
  producedBy?: string;
  sourceStage?: number;
}) {
  return payloadStore.createPayload(
    overrides?.pipeId ?? 'pipe-1',
    overrides?.stageId ?? 'linear:1',
    overrides?.content ?? 'test payload content',
    'proj-1',
    {
      producedBy: overrides?.producedBy ?? 'alice',
      sourceStage: overrides?.sourceStage,
    },
  );
}

// ── createPayload ────────────────────────────────────────────────────────────

describe('createPayload', () => {
  it('creates a payload with correct initial state', () => {
    const result = createTestPayload();
    expect(result.ok).toBe(true);
    expect(result.payload).toBeDefined();

    const p = result.payload!;
    expect(p.pipeId).toBe('pipe-1');
    expect(p.stageId).toBe('linear:1');
    expect(p.content).toBe('test payload content');
    expect(p.contentVersion).toBe(1);
    expect(p.status).toBe('active');
    expect(p.producedBy).toBe('alice');
    expect(p.archivedAt).toBeNull();
    expect(p.deletedAt).toBeNull();
  });

  it('computes SHA-256 content hash', () => {
    const result = createTestPayload();
    const p = result.payload!;
    expect(p.contentHash).toBeTruthy();
    expect(p.contentHash).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it('computes byte length correctly', () => {
    const result = createTestPayload({ content: 'hello' });
    expect(result.payload!.sizeBytes).toBe(5);
  });

  it('handles multi-byte characters in size calculation', () => {
    const result = createTestPayload({ content: '日本語' }); // 3 chars, 9 bytes in UTF-8
    expect(result.payload!.sizeBytes).toBe(9);
  });

  it('rejects payload exceeding size limit', () => {
    payloadStore.setMaxPayloadBytes(10);
    const result = createTestPayload({ content: 'this exceeds the limit' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('indexes payload by stage', () => {
    createTestPayload();
    const found = payloadStore.getPayloadByStage('pipe-1', 'linear:1', 'proj-1');
    expect(found).toBeDefined();
    expect(found!.content).toBe('test payload content');
  });
});

// ── getPayload ───────────────────────────────────────────────────────────────

describe('getPayload', () => {
  it('returns payload by ID', () => {
    const { payload } = createTestPayload();
    const found = payloadStore.getPayload(payload!.payloadId, 'proj-1');
    expect(found).toBeDefined();
    expect(found!.payloadId).toBe(payload!.payloadId);
  });

  it('returns undefined for deleted payloads', () => {
    const { payload } = createTestPayload();
    payloadStore.deletePayload(payload!.payloadId, 'proj-1');
    expect(payloadStore.getPayload(payload!.payloadId, 'proj-1')).toBeUndefined();
  });

  it('returns undefined for nonexistent IDs', () => {
    expect(payloadStore.getPayload('nonexistent', 'proj-1')).toBeUndefined();
  });
});

// ── getPayloadMeta ───────────────────────────────────────────────────────────

describe('getPayloadMeta', () => {
  it('returns metadata with content redacted', () => {
    const { payload } = createTestPayload();
    const meta = payloadStore.getPayloadMeta(payload!.payloadId, 'proj-1');
    expect(meta).toBeDefined();
    expect(meta!.content).toBe('[redacted]');
    expect(meta!.pipeId).toBe('pipe-1');
  });

  it('returns metadata even for deleted payloads', () => {
    const { payload } = createTestPayload();
    payloadStore.deletePayload(payload!.payloadId, 'proj-1');
    const meta = payloadStore.getPayloadMeta(payload!.payloadId, 'proj-1');
    expect(meta).toBeDefined();
    expect(meta!.status).toBe('deleted');
  });
});

// ── fetchPayloadContent ──────────────────────────────────────────────────────

describe('fetchPayloadContent', () => {
  it('returns content with integrity verification', () => {
    const { payload } = createTestPayload();
    const result = payloadStore.fetchPayloadContent(payload!.payloadId, 'proj-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('test payload content');
    expect(result.contentHash).toBe(payload!.contentHash);
    expect(result.contentVersion).toBe(1);
  });

  it('rejects fetch for deleted payloads', () => {
    const { payload } = createTestPayload();
    payloadStore.deletePayload(payload!.payloadId, 'proj-1');
    const result = payloadStore.fetchPayloadContent(payload!.payloadId, 'proj-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PAYLOAD_DELETED');
  });

  it('rejects fetch for nonexistent payloads', () => {
    const result = payloadStore.fetchPayloadContent('nonexistent', 'proj-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PAYLOAD_NOT_FOUND');
  });
});

// ── updatePayloadContent ─────────────────────────────────────────────────────

describe('updatePayloadContent', () => {
  it('updates content and increments version', () => {
    const { payload } = createTestPayload();
    const result = payloadStore.updatePayloadContent(
      payload!.payloadId, 'updated content', 'proj-1',
    );
    expect(result.ok).toBe(true);
    expect(result.payload!.content).toBe('updated content');
    expect(result.payload!.contentVersion).toBe(2);
    expect(result.payload!.contentHash).not.toBe(payload!.contentHash);
  });

  it('rejects update on deleted payload', () => {
    const { payload } = createTestPayload();
    payloadStore.deletePayload(payload!.payloadId, 'proj-1');
    const result = payloadStore.updatePayloadContent(
      payload!.payloadId, 'new', 'proj-1',
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAYLOAD_DELETED');
  });

  it('rejects update exceeding size limit', () => {
    const { payload } = createTestPayload();
    payloadStore.setMaxPayloadBytes(10);
    const result = payloadStore.updatePayloadContent(
      payload!.payloadId, 'this is way too long', 'proj-1',
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

// ── archivePayload ───────────────────────────────────────────────────────────

describe('archivePayload', () => {
  it('marks payload as archived', () => {
    const { payload } = createTestPayload();
    const result = payloadStore.archivePayload(payload!.payloadId, 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.payload!.status).toBe('archived');
    expect(result.payload!.archivedAt).toBeTruthy();
  });

  it('archived payloads are still readable', () => {
    const { payload } = createTestPayload();
    payloadStore.archivePayload(payload!.payloadId, 'proj-1');
    const found = payloadStore.getPayload(payload!.payloadId, 'proj-1');
    expect(found).toBeDefined();
    expect(found!.content).toBe('test payload content');
  });

  it('rejects archive on deleted payload', () => {
    const { payload } = createTestPayload();
    payloadStore.deletePayload(payload!.payloadId, 'proj-1');
    const result = payloadStore.archivePayload(payload!.payloadId, 'proj-1');
    expect(result.ok).toBe(false);
  });
});

// ── deletePayload ────────────────────────────────────────────────────────────

describe('deletePayload', () => {
  it('soft-deletes payload (removes content, preserves metadata)', () => {
    const { payload } = createTestPayload();
    const result = payloadStore.deletePayload(payload!.payloadId, 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.payload!.status).toBe('deleted');
    expect(result.payload!.content).toBe('');
    expect(result.payload!.sizeBytes).toBe(0);
    expect(result.payload!.deletedAt).toBeTruthy();
  });
});

// ── archivePipePayloads ──────────────────────────────────────────────────────

describe('archivePipePayloads', () => {
  it('archives all active payloads for a pipe', () => {
    createTestPayload({ stageId: 'linear:1' });
    createTestPayload({ stageId: 'linear:2' });
    createTestPayload({ pipeId: 'pipe-2', stageId: 'linear:1' }); // different pipe

    const count = payloadStore.archivePipePayloads('pipe-1', 'proj-1');
    expect(count).toBe(2);

    // Different pipe should be unaffected
    const other = payloadStore.getPayloadByStage('pipe-2', 'linear:1', 'proj-1');
    expect(other!.status).toBe('active');
  });
});

// ── cleanupExpiredPayloads ───────────────────────────────────────────────────

describe('cleanupExpiredPayloads', () => {
  it('removes archived payloads older than TTL', () => {
    const clock = createTestClock();
    payloadStore.setClock(clock);

    const { payload } = createTestPayload();
    payloadStore.archivePayload(payload!.payloadId, 'proj-1');

    // Not enough time
    clock.advance(1000);
    expect(payloadStore.cleanupExpiredPayloads('proj-1', 5000)).toBe(0);

    // Enough time
    clock.advance(5000);
    expect(payloadStore.cleanupExpiredPayloads('proj-1', 5000)).toBe(1);
  });

  it('does not remove active payloads', () => {
    const clock = createTestClock();
    payloadStore.setClock(clock);

    createTestPayload();
    clock.advance(100_000);
    expect(payloadStore.cleanupExpiredPayloads('proj-1', 1000)).toBe(0);
  });

  it('removes deleted payloads after TTL', () => {
    const clock = createTestClock();
    payloadStore.setClock(clock);

    const { payload } = createTestPayload();
    payloadStore.deletePayload(payload!.payloadId, 'proj-1');

    clock.advance(10_000);
    expect(payloadStore.cleanupExpiredPayloads('proj-1', 5000)).toBe(1);
  });
});

// ── getStorageStats ──────────────────────────────────────────────────────────

describe('getStorageStats', () => {
  it('computes correct stats', () => {
    createTestPayload({ stageId: 'linear:1', content: 'hello' });     // 5 bytes
    createTestPayload({ stageId: 'linear:2', content: 'world!' });    // 6 bytes
    const { payload: p3 } = createTestPayload({ stageId: 'linear:3', content: 'test' }); // 4 bytes
    payloadStore.archivePayload(p3!.payloadId, 'proj-1');

    const stats = payloadStore.getStorageStats('proj-1');
    expect(stats.totalPayloads).toBe(3);
    expect(stats.activePayloads).toBe(2);
    expect(stats.archivedPayloads).toBe(1);
    expect(stats.deletedPayloads).toBe(0);
    expect(stats.activeBytes).toBe(11);
    expect(stats.totalBytes).toBe(15);
  });
});

// ── getPayloadsByPipe ────────────────────────────────────────────────────────

describe('getPayloadsByPipe', () => {
  it('lists active and archived payloads, excludes deleted', () => {
    createTestPayload({ stageId: 'linear:1' });
    const { payload: p2 } = createTestPayload({ stageId: 'linear:2' });
    payloadStore.archivePayload(p2!.payloadId, 'proj-1');
    const { payload: p3 } = createTestPayload({ stageId: 'linear:3' });
    payloadStore.deletePayload(p3!.payloadId, 'proj-1');

    const payloads = payloadStore.getPayloadsByPipe('pipe-1', 'proj-1');
    expect(payloads).toHaveLength(2); // active + archived, not deleted
  });
});

// ── Recovery ─────────────────────────────────────────────────────────────────

describe('rehydrateFromEvents', () => {
  it('recreates payload from creation event', () => {
    const events: payloadStore.PayloadRecoveryEvent[] = [
      {
        type: 'payload-created',
        payloadId: 'p-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        content: 'recovered content',
        producedBy: 'alice',
        sourceStage: 0,
      },
    ];

    const active = payloadStore.rehydrateFromEvents(events, 'proj-1');
    expect(active).toContain('p-001');

    const payload = payloadStore.getPayload('p-001', 'proj-1');
    expect(payload).toBeDefined();
    expect(payload!.content).toBe('recovered content');
    expect(payload!.producedBy).toBe('alice');
  });

  it('replays archive events', () => {
    const events: payloadStore.PayloadRecoveryEvent[] = [
      {
        type: 'payload-created',
        payloadId: 'p-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        content: 'test',
      },
      {
        type: 'payload-archived',
        payloadId: 'p-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
      },
    ];

    const active = payloadStore.rehydrateFromEvents(events, 'proj-1');
    expect(active).not.toContain('p-001');

    const payload = payloadStore.getPayload('p-001', 'proj-1');
    expect(payload!.status).toBe('archived');
  });
});

// ── Clock injection ──────────────────────────────────────────────────────────

describe('clock injection', () => {
  it('uses injected clock for timestamps', () => {
    const clock = createTestClock(1700000000000);
    payloadStore.setClock(clock);

    const { payload } = createTestPayload();
    expect(payload!.createdAt).toBe('2023-11-14T22:13:20.000Z');

    clock.advance(3000);
    payloadStore.updatePayloadContent(payload!.payloadId, 'updated', 'proj-1');

    const updated = payloadStore.getPayload(payload!.payloadId, 'proj-1');
    expect(updated!.updatedAt).toBe('2023-11-14T22:13:23.000Z');
  });
});
