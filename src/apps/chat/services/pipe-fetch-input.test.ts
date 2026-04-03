import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPipe, computeStageInput, submitStage, markPipeStatus, _resetForTest,
} from './pipe-store.js';

describe('computeStageInput', () => {
  beforeEach(() => _resetForTest());

  // ── Linear pipes ──────────────────────────────────────────────────────

  describe('linear pipes', () => {
    it('stage 1 returns original prompt with hash', () => {
      createPipe('p1', 'linear', ['alice', 'bob', 'carol'], 'analyze this', null);
      const result = computeStageInput('p1', 1, 'alice', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('prompt');
      expect(result.input.content).toBe('analyze this');
      expect(result.input.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.input.contentVersion).toBe(1);
      expect(result.input.stage).toBe(1);
      expect(result.input.totalStages).toBe(3);
      expect(result.input.assignee).toBe('alice');
    });

    it('stage 2 returns upstream output after submission', () => {
      createPipe('p1', 'linear', ['alice', 'bob'], 'analyze this', null);
      submitStage('p1', 'alice', 'stage 1 output', null, false);
      const result = computeStageInput('p1', 2, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('upstream-output');
      expect(result.input.content).toBe('stage 1 output');
      expect(result.input.sources).toEqual([{ from: 'alice', content: 'stage 1 output' }]);
      expect(result.input.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.input.contentVersion).toBe(1);
      expect(result.input.prompt).toBe('analyze this');
    });

    it('stage 2 returns null content before upstream submits', () => {
      createPipe('p1', 'linear', ['alice', 'bob'], 'analyze this', null);
      const result = computeStageInput('p1', 2, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('upstream-output');
      expect(result.input.content).toBeNull();
      expect(result.input.contentHash).toBeNull();
      expect(result.input.contentVersion).toBe(0);
    });

    it('infers stage from assignee position when stage is omitted', () => {
      createPipe('p1', 'linear', ['alice', 'bob', 'carol'], 'test', null);
      const result = computeStageInput('p1', undefined, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.stage).toBe(2);
    });

    it('rejects invalid stage number', () => {
      createPipe('p1', 'linear', ['alice', 'bob'], 'test', null);
      const result = computeStageInput('p1', 5, 'alice', null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Invalid stage');
    });
  });

  // ── Merge pipes ──────────────────────────────────────────────────────

  describe('merge pipes', () => {
    it('fan-out participant receives prompt', () => {
      createPipe('p1', 'merge', ['alice', 'bob', 'carol'], 'compare approaches', null);
      const result = computeStageInput('p1', undefined, 'alice', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-prompt');
      expect(result.input.content).toBe('compare approaches');
      expect(result.input.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('synthesizer receives fan-out outputs after all submit', () => {
      createPipe('p1', 'merge', ['alice', 'bob', 'carol'], 'compare', null);
      submitStage('p1', 'alice', 'alice output', null, false);
      submitStage('p1', 'bob', 'bob output', null, false);
      const result = computeStageInput('p1', undefined, 'carol', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-outputs');
      expect(result.input.sources).toHaveLength(2);
      expect(result.input.sources![0].from).toBe('alice');
      expect(result.input.sources![1].from).toBe('bob');
      expect(result.input.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('synthesizer gets empty content before fan-outs submit', () => {
      createPipe('p1', 'merge', ['alice', 'bob', 'carol'], 'compare', null);
      const result = computeStageInput('p1', undefined, 'carol', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-outputs');
      expect(result.input.content).toBeNull();
      expect(result.input.contentHash).toBeNull();
    });
  });

  // ── Merge-all pipes ──────────────────────────────────────────────────

  describe('merge-all pipes', () => {
    it('synthesizer in fan-out phase receives prompt', () => {
      createPipe('p1', 'merge-all', ['alice', 'bob'], 'explain this', null);
      const result = computeStageInput('p1', undefined, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-prompt');
    });

    it('synthesizer stays in fan-out phase until their own fan-out is submitted', () => {
      createPipe('p1', 'merge-all', ['alice', 'bob'], 'explain this', null);
      submitStage('p1', 'alice', 'alice analysis', null, false);
      const result = computeStageInput('p1', undefined, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-prompt');
      expect(result.input.content).toBe('explain this');
    });

    it('synthesizer in synthesis phase receives fan-out outputs (excluding self)', () => {
      createPipe('p1', 'merge-all', ['alice', 'bob'], 'explain this', null);
      submitStage('p1', 'alice', 'alice analysis', null, false);
      submitStage('p1', 'bob', 'bob analysis', null, false);
      // Now bob is in synthesis phase
      const result = computeStageInput('p1', undefined, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-outputs');
      expect(result.input.sources).toHaveLength(1);
      expect(result.input.sources![0].from).toBe('alice');
    });
  });

  describe('merge-all style teaching pipes', () => {
    it('explain keeps the synthesizer in prompt mode until their fan-out is submitted', () => {
      createPipe('p1', 'explain', ['alice', 'bob'], 'teach me this', null);
      submitStage('p1', 'alice', 'alice explanation', null, false);
      const result = computeStageInput('p1', undefined, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-prompt');
      expect(result.input.content).toBe('teach me this');
    });

    it('summarize keeps the synthesizer in prompt mode until their fan-out is submitted', () => {
      createPipe('p1', 'summarize', ['alice', 'bob'], 'summarize this', null);
      submitStage('p1', 'alice', 'alice summary', null, false);
      const result = computeStageInput('p1', undefined, 'bob', null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input.role).toBe('fan-out-prompt');
      expect(result.input.content).toBe('summarize this');
    });
  });

  // ── Error cases ──────────────────────────────────────────────────────

  describe('error cases', () => {
    it('returns error for non-existent pipe', () => {
      const result = computeStageInput('nonexistent', 1, 'alice', null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('PIPE_NOT_FOUND');
    });

    it('returns error for non-assignee', () => {
      createPipe('p1', 'linear', ['alice', 'bob'], 'test', null);
      const result = computeStageInput('p1', 1, 'eve', null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('PIPE_NOT_ASSIGNED');
    });

    it('returns error for closed pipe', () => {
      createPipe('p1', 'linear', ['alice', 'bob'], 'test', null);
      markPipeStatus('p1', 'completed', null);
      const result = computeStageInput('p1', 1, 'alice', null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('PIPE_CLOSED');
    });

    it('content hash is deterministic for same content', () => {
      createPipe('p1', 'linear', ['alice', 'bob'], 'same prompt', null);
      createPipe('p2', 'linear', ['alice', 'bob'], 'same prompt', null);
      const r1 = computeStageInput('p1', 1, 'alice', null);
      const r2 = computeStageInput('p2', 1, 'alice', null);
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.input.contentHash).toBe(r2.input.contentHash);
    });
  });
});
