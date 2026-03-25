import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types.js';
import {
  derivePipeState,
  computeNextActions,
  matchResponse,
  findActivePipesForParticipant,
  _hasUnfinishedWork as hasUnfinishedWork,
} from './pipe-reducer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function msg(overrides: Partial<ChatMessage> & { from: string; body: string }): ChatMessage {
  return {
    id: `msg-${++seq}`,
    ts: new Date(Date.now() + seq * 1000).toISOString(),
    to: null,
    type: 'message',
    ...overrides,
  };
}

function sysMsg(body: string, pipe: ChatMessage['pipe']): ChatMessage {
  return msg({ from: 'system', body, type: 'system', pipe });
}

// ── derivePipeState ──────────────────────────────────────────────────────────

describe('derivePipeState', () => {
  it('returns null for unknown pipeId', () => {
    expect(derivePipeState([], 'nope')).toBeNull();
  });

  it('derives running state from start message', () => {
    const messages = [
      sysMsg('Pipe started', {
        pipeId: 'abc', mode: 'linear', role: 'start',
        assignees: ['a', 'b'], prompt: 'solve X',
      }),
    ];
    const state = derivePipeState(messages, 'abc');
    expect(state).not.toBeNull();
    expect(state!.status).toBe('running');
    expect(state!.prompt).toBe('solve X');
    expect(state!.assignees).toEqual(['a', 'b']);
  });

  it('reads prompt from pipe metadata, not message body', () => {
    const messages = [
      sysMsg('#pipe-abc Pipe started (linear): @a → @b', {
        pipeId: 'abc', mode: 'linear', role: 'start',
        assignees: ['a', 'b'], prompt: 'the real prompt',
      }),
    ];
    const state = derivePipeState(messages, 'abc');
    expect(state!.prompt).toBe('the real prompt');
  });

  it('marks completed on final role', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'done', pipe: { pipeId: 'abc', mode: 'linear', role: 'final', stage: 1 } }),
    ];
    const state = derivePipeState(messages, 'abc');
    expect(state!.status).toBe('completed');
    expect(state!.hasFinal).toBe(true);
  });

  it('marks failed on failed role', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('unavail', { pipeId: 'abc', mode: 'merge', role: 'assignee-unavailable', targetAssignee: 'a', reason: 'left' }),
      sysMsg('failed', { pipeId: 'abc', mode: 'merge', role: 'failed', reason: 'left' }),
    ];
    const state = derivePipeState(messages, 'abc');
    expect(state!.status).toBe('failed');
  });

  it('marks cancelled on cancelled role', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('cancelled', { pipeId: 'abc', mode: 'linear', role: 'cancelled', reason: 'cancelled-by-user' }),
    ];
    const state = derivePipeState(messages, 'abc');
    expect(state!.status).toBe('cancelled');
  });
});

// ── computeNextActions — idempotency ─────────────────────────────────────────

describe('computeNextActions — linear', () => {
  it('emits initial handoff to first assignee', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('handoff');
    expect(actions[0].targetAssignee).toBe('a');
    expect(actions[0].stage).toBe(1);
  });

  it('does not duplicate handoff if already emitted', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    expect(actions).toHaveLength(0); // waiting for a's response
  });

  it('emits handoff to next stage after output', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'output A', pipe: { pipeId: 'abc', mode: 'linear', role: 'stage-output', stage: 1 } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('handoff');
    expect(actions[0].targetAssignee).toBe('b');
    expect(actions[0].stage).toBe(2);
  });

  it('emits nothing after terminal state', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'done', pipe: { pipeId: 'abc', mode: 'linear', role: 'final', stage: 1 } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(computeNextActions(state)).toHaveLength(0);
  });
});

describe('computeNextActions — merge', () => {
  it('emits fan-out requests to all fan-out assignees', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    expect(actions).toHaveLength(2);
    expect(actions.map(a => a.targetAssignee).sort()).toEqual(['a', 'b']);
  });

  it('emits synth-request when all fan-out replies are in', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fan-out-req a', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fan-out-req b', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A output', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B output', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('synth-request');
    expect(actions[0].targetAssignee).toBe('s');
  });

  it('merge-all: emits fan-out requests to ALL assignees (including synthesizer)', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge-all', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    expect(actions).toHaveLength(2);
    expect(actions.map(a => a.targetAssignee).sort()).toEqual(['a', 'b']);
  });

  it('merge-all: emits synth-request only after ALL fan-outs (including synthesizer) are in', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge-all', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('fo a', { pipeId: 'abc', mode: 'merge-all', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'merge-all', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'merge-all', role: 'fan-out' } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    
    // b (synthesizer) hasn't sent its fan-out yet
    expect(computeNextActions(state)).toHaveLength(0);

    // b sends fan-out
    messages.push(msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'merge-all', role: 'fan-out' } }));
    const nextState = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(nextState);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('synth-request');
    expect(actions[0].targetAssignee).toBe('b');
    expect(actions[0].body).toContain('--- @a output ---');
    expect(actions[0].body).not.toContain('--- @b output ---');
  });

  it('does not duplicate synth-request', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo a', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      sysMsg('synth', { pipeId: 'abc', mode: 'merge', role: 'synth-request', targetAssignee: 's' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(computeNextActions(state)).toHaveLength(0);
  });

  it('emits nothing after failed state', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo a', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('unavail', { pipeId: 'abc', mode: 'merge', role: 'assignee-unavailable', targetAssignee: 'a', reason: 'left' }),
      sysMsg('failed', { pipeId: 'abc', mode: 'merge', role: 'failed', reason: 'left' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(computeNextActions(state)).toHaveLength(0);
  });
});

// ── matchResponse — reply disambiguation ─────────────────────────────────────

describe('matchResponse', () => {
  it('matches linear stage-output for prompted assignee', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const meta = matchResponse(state, 'a');
    expect(meta).not.toBeNull();
    expect(meta!.role).toBe('stage-output');
    expect(meta!.stage).toBe(1);
  });

  it('does not match unprompted assignee', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      // no handoff emitted yet
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(matchResponse(state, 'a')).toBeNull();
  });

  it('does not match already-responded assignee', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'done', pipe: { pipeId: 'abc', mode: 'linear', role: 'stage-output', stage: 1 } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(matchResponse(state, 'a')).toBeNull();
  });

  it('matches final for last linear assignee', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'linear', role: 'stage-output', stage: 1 } }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 2, targetAssignee: 'b' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const meta = matchResponse(state, 'b');
    expect(meta!.role).toBe('final');
  });

  it('matches merge fan-out response', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const meta = matchResponse(state, 'a');
    expect(meta!.role).toBe('fan-out');
  });

  it('matches merge synthesizer final response', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo a', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      sysMsg('synth', { pipeId: 'abc', mode: 'merge', role: 'synth-request', targetAssignee: 's' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const meta = matchResponse(state, 's');
    expect(meta!.role).toBe('final');
  });

  it('does not match non-participant', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(matchResponse(state, 'z')).toBeNull();
  });
});

// ── hasUnfinishedWork — fail-fast membership ─────────────────────────────────

describe('hasUnfinishedWork (fail-fast membership)', () => {
  it('linear: unfinished if no stage-output yet', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(hasUnfinishedWork(state, 'a')).toBe(true);
  });

  it('linear: finished after producing stage-output', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'done', pipe: { pipeId: 'abc', mode: 'linear', role: 'stage-output', stage: 1 } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(hasUnfinishedWork(state, 'a')).toBe(false);
  });

  it('merge fan-out: finished after producing fan-out reply', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(hasUnfinishedWork(state, 'a')).toBe(false);
  });

  it('merge synthesizer: unfinished during fan-out (before synth-request)', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    // Synthesizer has no synth-request yet, but is still needed
    expect(hasUnfinishedWork(state, 's')).toBe(true);
  });

  it('merge synthesizer: unfinished after synth-request, before final', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo a', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      sysMsg('synth', { pipeId: 'abc', mode: 'merge', role: 'synth-request', targetAssignee: 's' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(hasUnfinishedWork(state, 's')).toBe(true);
  });

  it('merge synthesizer: finished after final', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
      sysMsg('fo a', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'merge', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'merge', role: 'fan-out' } }),
      sysMsg('synth', { pipeId: 'abc', mode: 'merge', role: 'synth-request', targetAssignee: 's' }),
      msg({ from: 's', body: 'final', pipe: { pipeId: 'abc', mode: 'merge', role: 'final' } }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    expect(hasUnfinishedWork(state, 's')).toBe(false);
  });
});

// ── findActivePipesForParticipant ────────────────────────────────────────────

describe('findActivePipesForParticipant', () => {
  it('returns empty for non-participant', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
    ];
    expect(findActivePipesForParticipant(messages, 'z')).toHaveLength(0);
  });

  it('returns pipe for unfinished participant', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
    ];
    const result = findActivePipesForParticipant(messages, 'a');
    expect(result).toHaveLength(1);
    expect(result[0].pipeId).toBe('abc');
  });

  it('does not return pipe for finished participant', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'done', pipe: { pipeId: 'abc', mode: 'linear', role: 'stage-output', stage: 1 } }),
    ];
    expect(findActivePipesForParticipant(messages, 'a')).toHaveLength(0);
  });

  it('does not return completed pipe', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a'], prompt: 'X' }),
      sysMsg('handoff', { pipeId: 'abc', mode: 'linear', role: 'handoff', stage: 1, targetAssignee: 'a' }),
      msg({ from: 'a', body: 'done', pipe: { pipeId: 'abc', mode: 'linear', role: 'final', stage: 1 } }),
    ];
    expect(findActivePipesForParticipant(messages, 'a')).toHaveLength(0);
  });

  it('returns pipe for merge synthesizer during fan-out phase', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'merge', role: 'start', assignees: ['a', 'b', 's'], prompt: 'X' }),
    ];
    const result = findActivePipesForParticipant(messages, 's');
    expect(result).toHaveLength(1);
    expect(result[0].pipeId).toBe('abc');
  });
});
