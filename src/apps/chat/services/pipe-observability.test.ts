import { describe, it, expect, beforeEach } from 'vitest';
import * as pipeStore from './pipe-store.js';
import * as provenanceStore from './pipe-provenance.js';

describe('Pipe Observability', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    pipeStore._resetForTest();
    provenanceStore._resetForTest();
  });

  // ── Timing Summary ──────────────────────────────────────────────────

  describe('getPipeTimingSummary', () => {
    it('returns undefined for non-existent pipe', () => {
      expect(pipeStore.getPipeTimingSummary('nope', projectId)).toBeUndefined();
    });

    it('returns timing for a running linear pipe', () => {
      pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
      const timing = pipeStore.getPipeTimingSummary('p1', projectId);
      expect(timing).toBeDefined();
      expect(timing!.pipeId).toBe('p1');
      expect(timing!.mode).toBe('linear');
      expect(timing!.status).toBe('running');
      expect(timing!.stages).toHaveLength(2);
      expect(timing!.completedAt).toBeNull();
      expect(timing!.totalDurationMs).toBeNull();
    });

    it('tracks submissions in timing stages', () => {
      pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
      pipeStore.grantLease('p1', 'alice', projectId);
      pipeStore.submitStage('p1', 'alice', 'output1', projectId, true);
      pipeStore.grantLease('p1', 'bob', projectId);
      pipeStore.submitStage('p1', 'bob', 'output2', projectId, true);
      pipeStore.markPipeStatus('p1', 'completed', projectId);

      const timing = pipeStore.getPipeTimingSummary('p1', projectId);
      expect(timing!.status).toBe('completed');
      expect(timing!.completedAt).toBeDefined();
      expect(timing!.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(timing!.stages.every(s => s.submittedAt !== null)).toBe(true);
    });

    it('calculates critical path for merge pipe', () => {
      pipeStore.createPipe('p1', 'merge', ['alice', 'bob', 'carol'], 'test', projectId);
      const timing = pipeStore.getPipeTimingSummary('p1', projectId);
      expect(timing!.stages.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Runtime Lease Statuses ──────────────────────────────────────────

  describe('getRuntimeLeaseStatuses', () => {
    it('returns empty array when no leases exist', () => {
      expect(pipeStore.getRuntimeLeaseStatuses(projectId)).toEqual([]);
    });

    it('returns active leases with timing fields', () => {
      pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId, {
        stageTimeoutMs: 30000,
      });
      pipeStore.grantLease('p1', 'alice', projectId);

      const statuses = pipeStore.getRuntimeLeaseStatuses(projectId);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].assignee).toBe('alice');
      expect(statuses[0].elapsedMs).toBeGreaterThanOrEqual(0);
      expect(statuses[0].remainingMs).toBeGreaterThan(0);
      expect(statuses[0].isOverdue).toBe(false);
      expect(statuses[0].deadline).toBeDefined();
    });

    it('handles leases without deadlines', () => {
      pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId, {
        stageTimeoutMs: 0,
      });
      pipeStore.grantLease('p1', 'alice', projectId);

      const statuses = pipeStore.getRuntimeLeaseStatuses(projectId);
      expect(statuses[0].deadline).toBeNull();
      expect(statuses[0].remainingMs).toBeNull();
      expect(statuses[0].isOverdue).toBe(false);
    });
  });

  // ── Dead Letter Entries ─────────────────────────────────────────────

  describe('getDeadLetterEntries', () => {
    it('returns empty array when no stuck assignments', () => {
      expect(pipeStore.getDeadLetterEntries(projectId)).toEqual([]);
    });

    it('does not flag fresh running pipes', () => {
      pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId, {
        stageTimeoutMs: 300000,
      });
      pipeStore.grantLease('p1', 'alice', projectId);
      const entries = pipeStore.getDeadLetterEntries(projectId);
      expect(entries).toHaveLength(0);
    });

    it('does not flag submitted slots', () => {
      pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId);
      pipeStore.grantLease('p1', 'alice', projectId);
      pipeStore.submitStage('p1', 'alice', 'done', projectId, true);

      const entries = pipeStore.getDeadLetterEntries(projectId);
      expect(entries).toHaveLength(0);
    });

    it('returns correct structure for dead-letter entries', () => {
      // Just verify the function returns a properly typed array
      const entries = pipeStore.getDeadLetterEntries(projectId);
      expect(Array.isArray(entries)).toBe(true);
    });
  });

  // ── List All Pipes ──────────────────────────────────────────────────

  describe('listAllPipes', () => {
    it('returns empty array when no pipes', () => {
      expect(pipeStore.listAllPipes(projectId)).toEqual([]);
    });

    it('includes running and terminal pipes with slot summaries', () => {
      pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
      pipeStore.createPipe('p2', 'merge', ['alice', 'bob', 'carol'], 'test2', projectId);
      pipeStore.markPipeStatus('p2', 'completed', projectId);

      const all = pipeStore.listAllPipes(projectId);
      expect(all).toHaveLength(2);

      const p1 = all.find(p => p.pipeId === 'p1')!;
      expect(p1.status).toBe('running');
      expect(p1.slotSummary.total).toBe(2);
      expect(p1.slotSummary.pending).toBe(2);

      const p2 = all.find(p => p.pipeId === 'p2')!;
      expect(p2.status).toBe('completed');
    });
  });

  // ── Provenance Store ────────────────────────────────────────────────

  describe('Provenance', () => {
    it('records and retrieves provenance for a pipe', () => {
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'created', actor: 'user', actorKind: 'user',
        metadata: { mode: 'linear' },
      });
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'stage-granted', actor: 'system', actorKind: 'system',
        stage: 1, metadata: { assignee: 'alice' },
      });

      const records = provenanceStore.getProvenanceForPipe('p1', projectId);
      expect(records).toHaveLength(2);
      expect(records[0].event).toBe('created');
      expect(records[1].event).toBe('stage-granted');
      expect(records[1].stage).toBe(1);
    });

    it('queries by actor', () => {
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'created', actor: 'user', actorKind: 'user',
      });
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'stage-submitted', actor: 'alice', actorKind: 'llm',
      });

      const userRecords = provenanceStore.queryProvenance(projectId, { actor: 'user' });
      expect(userRecords).toHaveLength(1);
      expect(userRecords[0].actor).toBe('user');
    });

    it('queries by event type', () => {
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'created', actor: 'user', actorKind: 'user',
      });
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p2', event: 'created', actor: 'user', actorKind: 'user',
      });
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'completed', actor: 'system', actorKind: 'system',
      });

      const created = provenanceStore.queryProvenance(projectId, { event: 'created' });
      expect(created).toHaveLength(2);
    });

    it('retrieves provenance for participant across pipes', () => {
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'stage-submitted', actor: 'alice', actorKind: 'llm',
      });
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p2', event: 'stage-submitted', actor: 'alice', actorKind: 'llm',
      });

      const aliceRecords = provenanceStore.getProvenanceForParticipant('alice', projectId);
      expect(aliceRecords).toHaveLength(2);
    });

    it('cleans up provenance for terminal pipes', () => {
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p1', event: 'created', actor: 'user', actorKind: 'user',
      });
      provenanceStore.recordProvenance(projectId, {
        pipeId: 'p2', event: 'created', actor: 'user', actorKind: 'user',
      });

      provenanceStore.cleanupProvenance(['p1'], projectId);
      expect(provenanceStore.getProvenanceForPipe('p1', projectId)).toHaveLength(0);
      expect(provenanceStore.getProvenanceForPipe('p2', projectId)).toHaveLength(1);
    });
  });
});
