import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types.js';
import {
  derivePipeState,
  computeNextActions,
  matchResponse,
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

  it('includes compact prompt with pipe_submit in handoff body', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'linear', role: 'start', assignees: ['a', 'b'], prompt: 'X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const actions = computeNextActions(state);
    const body = actions[0].body;
    expect(body).toContain('#pipe-abc [linear | stage 1/2 | @a]');
    expect(body).toContain('pipe_submit(pipeId="abc"');
    expect(body).toContain('Do not use chat_send');
    expect(body).toContain('next stage');
    expect(body).toContain('Prompt: X');
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

    // Synthesizer's fan-out should warn about dual-role
    const bFanOut = actions.find(a => a.targetAssignee === 'b')!;
    expect(bFanOut.body).toContain('You have 2 stages');
    expect(bFanOut.body).toContain('Synthesis comes next');
    // Non-synthesizer should not have the warning
    const aFanOut = actions.find(a => a.targetAssignee === 'a')!;
    expect(aFanOut.body).not.toContain('You have 2 stages');
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
    expect(actions[0].body).toContain('pipe_read_output(pipeId="abc")');
    expect(actions[0].body).toContain('pipe_submit(pipeId="abc"');
    expect(actions[0].body).toContain('Do not use chat_send');
  });

  it('explain: emits teaching fan-out requests and a teaching synth request', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'explain', role: 'start', assignees: ['a', 'b'], prompt: 'Teach me X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const fanOutActions = computeNextActions(state);
    expect(fanOutActions).toHaveLength(2);
    expect(fanOutActions[0].body).toContain('Explain independently');
    expect(fanOutActions[0].body).toContain('Simplest explanation');
    expect(fanOutActions[0].body).toContain('pipe_submit(pipeId="abc"');
    expect(fanOutActions[0].body).toContain('Do not use chat_send');

    messages.push(
      sysMsg('fo a', { pipeId: 'abc', mode: 'explain', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'explain', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'explain', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'explain', role: 'fan-out' } }),
    );

    const nextState = derivePipeState(messages, 'abc')!;
    const synthActions = computeNextActions(nextState);
    expect(synthActions).toHaveLength(1);
    expect(synthActions[0].targetAssignee).toBe('b');
    expect(synthActions[0].body).toContain('Common misunderstandings');
    expect(synthActions[0].body).toContain('pipe_read_output(pipeId="abc")');
    expect(synthActions[0].body).toContain('pipe_submit(pipeId="abc"');
  });

  it('summarize: emits concise fan-out requests and a compact synth request', () => {
    const messages = [
      sysMsg('start', { pipeId: 'abc', mode: 'summarize', role: 'start', assignees: ['a', 'b'], prompt: 'Summarize topic X' }),
    ];
    const state = derivePipeState(messages, 'abc')!;
    const fanOutActions = computeNextActions(state);
    expect(fanOutActions).toHaveLength(2);
    expect(fanOutActions[0].body).toContain('Summarize independently');
    expect(fanOutActions[0].body).toContain('TL;DR');
    expect(fanOutActions[0].body).toContain('pipe_submit(pipeId="abc"');
    expect(fanOutActions[0].body).toContain('Do not use chat_send');

    messages.push(
      sysMsg('fo a', { pipeId: 'abc', mode: 'summarize', role: 'fan-out-request', targetAssignee: 'a' }),
      sysMsg('fo b', { pipeId: 'abc', mode: 'summarize', role: 'fan-out-request', targetAssignee: 'b' }),
      msg({ from: 'a', body: 'A', pipe: { pipeId: 'abc', mode: 'summarize', role: 'fan-out' } }),
      msg({ from: 'b', body: 'B', pipe: { pipeId: 'abc', mode: 'summarize', role: 'fan-out' } }),
    );

    const nextState = derivePipeState(messages, 'abc')!;
    const synthActions = computeNextActions(nextState);
    expect(synthActions).toHaveLength(1);
    expect(synthActions[0].targetAssignee).toBe('b');
    expect(synthActions[0].body).toContain('1. TL;DR');
    expect(synthActions[0].body).toContain('Caveat (only if important)');
    expect(synthActions[0].body).toContain('pipe_read_output(pipeId="abc")');
    expect(synthActions[0].body).toContain('pipe_submit(pipeId="abc"');
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


