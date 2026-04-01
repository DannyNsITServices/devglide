import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as pipeStore from './pipe-store.js';
import * as pipeReducer from './pipe-reducer.js';
import { parsePipeCommand, parseDuration } from './pipe-parser.js';

beforeEach(() => {
  pipeStore._resetForTest();
});

// ── parseDuration ────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('returns null for invalid input', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('0s')).toBeNull();
  });

  it('returns null for negative or zero values', () => {
    expect(parseDuration('0m')).toBeNull();
  });
});

// ── Pipe command flag parsing ────────────────────────────────────────────────

describe('pipe-parser timeout flags', () => {
  it('parses --timeout flag', () => {
    const result = parsePipeCommand('/linear-pipe --timeout 10m @alice @bob do something');
    expect(result).toMatchObject({
      mode: 'linear',
      assignees: ['alice', 'bob'],
      prompt: 'do something',
      stageTimeoutMs: 600_000,
    });
  });

  it('parses --on-timeout flag', () => {
    const result = parsePipeCommand('/linear-pipe --on-timeout escalate @alice @bob do something');
    expect(result).toMatchObject({
      mode: 'linear',
      assignees: ['alice', 'bob'],
      prompt: 'do something',
      timeoutPolicy: 'escalate',
    });
  });

  it('parses both flags together', () => {
    const result = parsePipeCommand('/merge-all-pipe --timeout 30s --on-timeout fail @alice @bob analyze this');
    expect(result).toMatchObject({
      mode: 'merge-all',
      stageTimeoutMs: 30_000,
      timeoutPolicy: 'fail',
      assignees: ['alice', 'bob'],
      prompt: 'analyze this',
    });
  });

  it('rejects invalid timeout duration', () => {
    const result = parsePipeCommand('/linear-pipe --timeout xyz @alice @bob do something');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid timeout duration');
  });

  it('rejects invalid timeout policy', () => {
    const result = parsePipeCommand('/linear-pipe --on-timeout destroy @alice @bob do something');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid timeout policy');
  });

  it('accepts commands without flags (backward compat)', () => {
    const result = parsePipeCommand('/linear-pipe @alice @bob do something');
    expect(result).toMatchObject({
      mode: 'linear',
      assignees: ['alice', 'bob'],
      prompt: 'do something',
    });
    expect(result).not.toHaveProperty('stageTimeoutMs');
    expect(result).not.toHaveProperty('timeoutPolicy');
  });

  it('stops flag parsing at unknown flags (treats as prompt)', () => {
    const result = parsePipeCommand('/linear-pipe --unknown value do something');
    expect(result).toMatchObject({
      mode: 'linear',
      assignees: [],
      prompt: '--unknown value do something',
    });
  });
});

// ── Pipe creation with timeout config ────────────────────────────────────────

describe('pipe-store timeout config', () => {
  it('creates a pipe with default timeout', () => {
    const pipe = pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    expect(pipe.stageTimeoutMs).toBe(pipeStore.DEFAULT_STAGE_TIMEOUT_MS);
    expect(pipe.timeoutPolicy).toBe('fail');
  });

  it('creates a pipe with custom timeout', () => {
    const pipe = pipeStore.createPipe('pipe-2', 'linear', ['alice', 'bob'], 'test', 'proj-1', {
      stageTimeoutMs: 30_000,
      timeoutPolicy: 'escalate',
    });
    expect(pipe.stageTimeoutMs).toBe(30_000);
    expect(pipe.timeoutPolicy).toBe('escalate');
  });

  it('creates a pipe with zero timeout (disabled)', () => {
    const pipe = pipeStore.createPipe('pipe-3', 'linear', ['alice', 'bob'], 'test', 'proj-1', {
      stageTimeoutMs: 0,
    });
    expect(pipe.stageTimeoutMs).toBe(0);
  });
});

// ── Lease deadline ───────────────────────────────────────────────────────────

describe('pipe-store lease deadline', () => {
  it('sets deadline on lease when timeout is configured', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1', {
      stageTimeoutMs: 60_000,
    });
    const result = pipeStore.grantLease('pipe-1', 'alice', 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.lease).toBeDefined();
    expect(result.lease!.deadline).toBeDefined();
    expect(result.lease!.deadline).not.toBeNull();

    // Deadline should be ~60s from now
    const deadline = new Date(result.lease!.deadline!).getTime();
    const now = Date.now();
    expect(deadline - now).toBeGreaterThan(55_000);
    expect(deadline - now).toBeLessThan(65_000);
  });

  it('sets no deadline when timeout is 0', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1', {
      stageTimeoutMs: 0,
    });
    const result = pipeStore.grantLease('pipe-1', 'alice', 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.lease!.deadline).toBeNull();
  });
});

// ── getAllActiveLeases ────────────────────────────────────────────────────────

describe('pipe-store getAllActiveLeases', () => {
  it('returns empty map when no leases', () => {
    expect(pipeStore.getAllActiveLeases().size).toBe(0);
  });

  it('returns active leases after grant', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    pipeStore.grantLease('pipe-1', 'alice', 'proj-1');
    const leases = pipeStore.getAllActiveLeases();
    expect(leases.size).toBe(1);
    const lease = [...leases.values()][0];
    expect(lease.pipeId).toBe('pipe-1');
    expect(lease.assignee).toBe('alice');
  });

  it('removes lease after submit', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    pipeStore.grantLease('pipe-1', 'alice', 'proj-1');
    pipeStore.submitStage('pipe-1', 'alice', 'output', 'proj-1', true);
    expect(pipeStore.getAllActiveLeases().size).toBe(0);
  });
});

// ── Terminal pipe cleanup ────────────────────────────────────────────────────

describe('pipe-store cleanupTerminalPipes', () => {
  it('does not remove running pipes', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    const removed = pipeStore.cleanupTerminalPipes('proj-1', 0); // TTL=0 means remove everything
    expect(removed).toEqual([]);
  });

  it('removes completed pipes older than TTL', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    pipeStore.markPipeStatus('pipe-1', 'completed', 'proj-1');
    const removed = pipeStore.cleanupTerminalPipes('proj-1', 0);
    expect(removed).toEqual(['pipe-1']);
    expect(pipeStore.getPipe('pipe-1', 'proj-1')).toBeUndefined();
  });

  it('removes failed pipes older than TTL', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    pipeStore.markPipeStatus('pipe-1', 'failed', 'proj-1');
    const removed = pipeStore.cleanupTerminalPipes('proj-1', 0);
    expect(removed).toEqual(['pipe-1']);
  });

  it('removes cancelled pipes older than TTL', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    pipeStore.markPipeStatus('pipe-1', 'cancelled', 'proj-1');
    const removed = pipeStore.cleanupTerminalPipes('proj-1', 0);
    expect(removed).toEqual(['pipe-1']);
  });

  it('does not remove terminal pipes within TTL', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-1');
    pipeStore.markPipeStatus('pipe-1', 'completed', 'proj-1');
    const removed = pipeStore.cleanupTerminalPipes('proj-1', 999_999_999); // huge TTL
    expect(removed).toEqual([]);
  });
});

// ── Rehydration from events ──────────────────────────────────────────────────

describe('pipe-store rehydrateFromEvents', () => {
  it('recreates a pipe from start event', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      {
        type: 'start',
        pipeId: 'pipe-r1',
        mode: 'linear',
        assignees: ['alice', 'bob'],
        prompt: 'test prompt',
        stageTimeoutMs: 60_000,
        timeoutPolicy: 'escalate',
      },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual(['pipe-r1']);

    const pipe = pipeStore.getPipe('pipe-r1', 'proj-1');
    expect(pipe).toBeDefined();
    expect(pipe!.mode).toBe('linear');
    expect(pipe!.status).toBe('running');
    expect(pipe!.assignees).toEqual(['alice', 'bob']);
    expect(pipe!.stageTimeoutMs).toBe(60_000);
    expect(pipe!.timeoutPolicy).toBe('escalate');
  });

  it('replays submissions', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      {
        type: 'start',
        pipeId: 'pipe-r2',
        mode: 'linear',
        assignees: ['alice', 'bob'],
        prompt: 'test',
      },
      {
        type: 'stage-output',
        pipeId: 'pipe-r2',
        from: 'alice',
        content: 'alice output',
      },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual(['pipe-r2']);

    const pipe = pipeStore.getPipe('pipe-r2', 'proj-1');
    expect(pipe).toBeDefined();
    const aliceSlot = pipe!.slots.get('alice')![0];
    expect(aliceSlot.status).toBe('submitted');
    expect(aliceSlot.content).toBe('alice output');
  });

  it('marks terminal pipes correctly', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      {
        type: 'start',
        pipeId: 'pipe-r3',
        mode: 'merge-all',
        assignees: ['alice', 'bob'],
        prompt: 'test',
      },
      { type: 'complete', pipeId: 'pipe-r3' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual([]);

    const pipe = pipeStore.getPipe('pipe-r3', 'proj-1');
    expect(pipe).toBeDefined();
    expect(pipe!.status).toBe('completed');
  });

  it('marks failed pipes correctly', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      {
        type: 'start',
        pipeId: 'pipe-r4',
        mode: 'linear',
        assignees: ['alice', 'bob'],
        prompt: 'test',
      },
      { type: 'failed', pipeId: 'pipe-r4' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual([]);

    const pipe = pipeStore.getPipe('pipe-r4', 'proj-1');
    expect(pipe!.status).toBe('failed');
  });

  it('marks cancelled pipes correctly', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      {
        type: 'start',
        pipeId: 'pipe-r5',
        mode: 'linear',
        assignees: ['alice', 'bob'],
        prompt: 'test',
      },
      { type: 'cancel', pipeId: 'pipe-r5' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual([]);

    const pipe = pipeStore.getPipe('pipe-r5', 'proj-1');
    expect(pipe!.status).toBe('cancelled');
  });

  it('skips events without a start event', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'stage-output', pipeId: 'pipe-orphan', from: 'alice', content: 'output' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual([]);
    expect(pipeStore.getPipe('pipe-orphan', 'proj-1')).toBeUndefined();
  });

  it('handles multiple pipes in one batch', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'p1', mode: 'linear', assignees: ['alice', 'bob'], prompt: 'first' },
      { type: 'start', pipeId: 'p2', mode: 'merge-all', assignees: ['alice', 'bob'], prompt: 'second' },
      { type: 'stage-output', pipeId: 'p1', from: 'alice', content: 'done' },
      { type: 'complete', pipeId: 'p2' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual(['p1']);

    expect(pipeStore.getPipe('p1', 'proj-1')!.status).toBe('running');
    expect(pipeStore.getPipe('p2', 'proj-1')!.status).toBe('completed');
  });

  it('does not duplicate pipes already in store', () => {
    pipeStore.createPipe('existing', 'linear', ['alice', 'bob'], 'already here', 'proj-1');
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'existing', mode: 'linear', assignees: ['alice', 'bob'], prompt: 'duplicate' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, 'proj-1');
    expect(running).toEqual([]);
    // Original prompt should be preserved
    expect(pipeStore.getPipe('existing', 'proj-1')!.prompt).toBe('already here');
  });
});

// ── Emission state rebuild on recovery ───────────────────────────────────────

describe('pipe-store emission rebuild on recovery', () => {
  it('rebuilds linear emission state: submitted stage-1 marks handoff-1 as emitted', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'lr1', mode: 'linear', assignees: ['alice', 'bob', 'carol'], prompt: 'test' },
      { type: 'stage-output', pipeId: 'lr1', from: 'alice', content: 'alice output' },
    ];
    pipeStore.rehydrateFromEvents(events, 'proj-1');
    const pipe = pipeStore.getPipe('lr1', 'proj-1')!;
    // Stage 1 (alice) was submitted, so handoff for stage 1 was emitted
    expect(pipe.emittedHandoffs.has(1)).toBe(true);
    // Handoff for stage 2 has NOT been emitted yet (bob hasn't started)
    expect(pipe.emittedHandoffs.has(2)).toBe(false);
  });

  it('rebuilds linear emission state: two submitted stages mark handoffs 1 and 2 as emitted', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'lr2', mode: 'linear', assignees: ['alice', 'bob', 'carol'], prompt: 'test' },
      { type: 'stage-output', pipeId: 'lr2', from: 'alice', content: 'alice output' },
      { type: 'stage-output', pipeId: 'lr2', from: 'bob', content: 'bob output' },
    ];
    pipeStore.rehydrateFromEvents(events, 'proj-1');
    const pipe = pipeStore.getPipe('lr2', 'proj-1')!;
    expect(pipe.emittedHandoffs.has(1)).toBe(true);
    expect(pipe.emittedHandoffs.has(2)).toBe(true);
    expect(pipe.emittedHandoffs.has(3)).toBe(false);
  });

  it('rebuilds merge-all emission state: submitted fan-out marks fan-out request as emitted', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'mr1', mode: 'merge-all', assignees: ['alice', 'bob'], prompt: 'test' },
      { type: 'stage-output', pipeId: 'mr1', from: 'alice', content: 'alice analysis' },
    ];
    pipeStore.rehydrateFromEvents(events, 'proj-1');
    const pipe = pipeStore.getPipe('mr1', 'proj-1')!;
    expect(pipe.emittedFanOutRequests.has('alice')).toBe(true);
    // Bob's fan-out was not submitted, but it should still be marked if we're recovering
    // (the fan-out request was sent to both participants at pipe start)
    // Actually, bob's fan-out slot is still pending, so the request may or may not have been emitted.
    // The safest approach: bob's fan-out is pending, so it's NOT marked as emitted.
    // The reducer will re-emit it, which is correct — bob didn't respond.
    expect(pipe.emittedFanOutRequests.has('bob')).toBe(false);
    expect(pipe.emittedSynthRequest).toBe(false);
  });

  it('rebuilds merge-all emission state: all fan-outs submitted but synth not started', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'mr2', mode: 'merge-all', assignees: ['alice', 'bob'], prompt: 'test' },
      { type: 'stage-output', pipeId: 'mr2', from: 'alice', content: 'alice analysis' },
      // bob is the synthesizer in merge-all, his fan-out slot submitted too
      { type: 'stage-output', pipeId: 'mr2', from: 'bob', content: 'bob analysis' },
    ];
    pipeStore.rehydrateFromEvents(events, 'proj-1');
    const pipe = pipeStore.getPipe('mr2', 'proj-1')!;
    expect(pipe.emittedFanOutRequests.has('alice')).toBe(true);
    expect(pipe.emittedFanOutRequests.has('bob')).toBe(true);
    // All fan-outs submitted but the final (synth) slot for bob is still pending
    // So synth request has NOT been emitted yet
    expect(pipe.emittedSynthRequest).toBe(false);
  });

  it('rebuilds no emissions for a pipe with no submissions', () => {
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'empty1', mode: 'linear', assignees: ['alice', 'bob'], prompt: 'test' },
    ];
    pipeStore.rehydrateFromEvents(events, 'proj-1');
    const pipe = pipeStore.getPipe('empty1', 'proj-1')!;
    expect(pipe.emittedHandoffs.size).toBe(0);
    expect(pipe.emittedFanOutRequests.size).toBe(0);
    expect(pipe.emittedSynthRequest).toBe(false);
  });

  it('linear recovery resumes at correct stage (does not re-emit submitted handoffs)', () => {
    // Simulate: 3-stage linear pipe where stage 1 (alice) already submitted
    // After recovery, the reducer should only emit handoff for stage 2, not stage 1
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'resume1', mode: 'linear', assignees: ['alice', 'bob', 'carol'], prompt: 'test' },
      { type: 'stage-output', pipeId: 'resume1', from: 'alice', content: 'alice done' },
    ];
    pipeStore.rehydrateFromEvents(events, 'proj-1');
    const pipe = pipeStore.getPipe('resume1', 'proj-1')!;

    // Verify emission state prevents duplicate handoffs
    expect(pipe.emittedHandoffs.has(1)).toBe(true);  // stage 1 already happened
    expect(pipe.emittedHandoffs.has(2)).toBe(false);  // stage 2 not yet

    // Now simulate what the reducer would do
    const state = pipeReducer.buildStateFromStore(pipe);
    const actions = pipeReducer.computeNextActions(state);

    // Should emit exactly one action: handoff for stage 2 (bob)
    expect(actions).toHaveLength(1);
    expect(actions[0].targetAssignee).toBe('bob');
    expect(actions[0].type).toBe('handoff');
    expect(actions[0].stage).toBe(2);
  });
});
