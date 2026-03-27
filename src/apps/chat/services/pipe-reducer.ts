import { randomUUID } from 'crypto';
import type { ChatMessage, PipeMode, PipeRole, PipeMessageMeta, PipeStatus } from '../types.js';
import type { ParsedPipeCommand } from './pipe-parser.js';
import type { StoredPipe } from './pipe-store.js';

// ── Reducer state ────────────────────────────────────────────────────────────

export interface PipeState {
  pipeId: string;
  mode: PipeMode;
  status: PipeStatus;
  assignees: string[];        // ordered list from start message
  prompt: string;
  /** Linear: which stage-output roles exist (by stage number). */
  stageOutputs: Map<number, { from: string; body: string }>;
  /** Merge: which fan-out roles exist (by assignee name). */
  fanOutOutputs: Map<string, string>;
  /** Roles already emitted by system (for idempotency). */
  emittedRoles: Set<string>;  // keys like "handoff:2", "synth-request", "failed"
  hasHandoffs: Set<number>;   // stage numbers that have handoff messages
  hasSynthRequest: boolean;
  hasFinal: boolean;
  hasFailed: boolean;
  hasCancelled: boolean;
}

/** Unique key for idempotency checks on system emissions. */
function emissionKey(role: PipeRole, stage?: number, targetAssignee?: string): string {
  if (stage !== undefined) return `${role}:${stage}`;
  if (targetAssignee) return `${role}:${targetAssignee}`;
  return role;
}

// ── Scan log to derive pipe state ────────────────────────────────────────────
// Note: buildStateFromStore (pipe store) is the primary state source in production.
// This function is used as a fallback for legacy/recovery pipes not in the store.

export function derivePipeState(messages: ChatMessage[], pipeId: string): PipeState | null {
  let state: PipeState | null = null;

  for (const msg of messages) {
    if (!msg.pipe || msg.pipe.pipeId !== pipeId) continue;
    const p = msg.pipe;

    if (p.role === 'start') {
      state = {
        pipeId,
        mode: p.mode,
        status: 'running',
        assignees: p.assignees ?? [],
        prompt: p.prompt ?? msg.body,
        stageOutputs: new Map(),
        fanOutOutputs: new Map(),
        emittedRoles: new Set(),
        hasHandoffs: new Set(),
        hasSynthRequest: false,
        hasFinal: false,
        hasFailed: false,
        hasCancelled: false,
      };
      continue;
    }

    if (!state) continue;

    switch (p.role) {
      case 'handoff':
        if (p.stage !== undefined) state.hasHandoffs.add(p.stage);
        state.emittedRoles.add(emissionKey('handoff', p.stage));
        break;
      case 'fan-out-request':
        state.emittedRoles.add(emissionKey('fan-out-request', undefined, p.targetAssignee));
        break;
      case 'stage-output':
        if (p.stage !== undefined) {
          state.stageOutputs.set(p.stage, { from: msg.from, body: msg.body });
        }
        break;
      case 'fan-out':
        state.fanOutOutputs.set(msg.from, msg.body);
        break;
      case 'synth-request':
        state.hasSynthRequest = true;
        state.emittedRoles.add('synth-request');
        break;
      case 'final':
        state.hasFinal = true;
        state.status = 'completed';
        break;
      case 'assignee-unavailable':
        // Don't set status yet — 'failed' message does that
        break;
      case 'failed':
        state.hasFailed = true;
        state.status = 'failed';
        break;
      case 'cancelled':
        state.hasCancelled = true;
        state.status = 'cancelled';
        break;
    }
  }

  return state;
}

/** Build PipeState directly from the pipe store — no log scanning needed.
 *  This is the primary state builder for store-tracked pipes. */
export function buildStateFromStore(pipe: StoredPipe): PipeState {
  const state: PipeState = {
    pipeId: pipe.pipeId,
    mode: pipe.mode,
    status: pipe.status === 'running' ? 'running' : pipe.status,
    assignees: pipe.assignees,
    prompt: pipe.prompt,
    stageOutputs: new Map(),
    fanOutOutputs: new Map(),
    emittedRoles: new Set(),
    hasHandoffs: new Set(pipe.emittedHandoffs),
    hasSynthRequest: pipe.emittedSynthRequest,
    hasFinal: false,
    hasFailed: pipe.status === 'failed',
    hasCancelled: pipe.status === 'cancelled',
  };

  // Populate emittedRoles from store tracking
  for (const stage of pipe.emittedHandoffs) {
    state.emittedRoles.add(`handoff:${stage}`);
  }
  for (const assignee of pipe.emittedFanOutRequests) {
    state.emittedRoles.add(`fan-out-request:${assignee}`);
  }
  if (pipe.emittedSynthRequest) {
    state.emittedRoles.add('synth-request');
  }

  // Populate outputs from store slots
  for (const [assignee, slotList] of pipe.slots) {
    for (const slot of slotList) {
      if (slot.status === 'submitted' && slot.content) {
        if (slot.stage !== undefined && slot.role !== 'final') {
          state.stageOutputs.set(slot.stage, { from: assignee, body: slot.content });
        }
        if (slot.role === 'fan-out') {
          state.fanOutOutputs.set(assignee, slot.content);
        }
        if (slot.role === 'final') {
          state.hasFinal = true;
        }
      }
    }
  }

  return state;
}

// ── Reducer: compute next actions ────────────────────────────────────────────

export interface PipeAction {
  type: 'handoff' | 'fan-out-request' | 'synth-request';
  targetAssignee: string;
  stage?: number;
  body: string;
  pipe: PipeMessageMeta;
}

function isMergeAllStyleMode(mode: PipeMode): boolean {
  return mode === 'merge-all' || mode === 'explain' || mode === 'summarize';
}

export function computeNextActions(state: PipeState): PipeAction[] {
  // Guard: terminal state → no actions
  if (state.hasFinal || state.hasFailed || state.hasCancelled) return [];

  if (state.mode === 'linear') return computeLinearActions(state);
  if (state.mode === 'merge' || isMergeAllStyleMode(state.mode)) return computeMergeActions(state);
  return [];
}

function computeLinearActions(state: PipeState): PipeAction[] {
  const actions: PipeAction[] = [];
  const totalStages = state.assignees.length;

  // Check if stage 1 handoff needs to be emitted (initial delivery)
  if (!state.hasHandoffs.has(1)) {
    const target = state.assignees[0];
    actions.push({
      type: 'handoff',
      targetAssignee: target,
      stage: 1,
      body: formatLinearHandoff(state, 1),
      pipe: {
        pipeId: state.pipeId,
        mode: 'linear',
        role: 'handoff',
        stage: 1,
        targetAssignee: target,
        expectedAssignees: [target],
      },
    });
    return actions; // Only emit one action at a time
  }

  // Check each stage: if output exists and next handoff missing → emit
  for (let stage = 1; stage < totalStages; stage++) {
    const output = state.stageOutputs.get(stage);
    if (!output) continue; // stage not responded yet

    const nextStage = stage + 1;
    const key = emissionKey('handoff', nextStage);
    if (state.emittedRoles.has(key)) continue; // already emitted

    const target = state.assignees[nextStage - 1];
    const isLast = nextStage === totalStages;
    actions.push({
      type: 'handoff',
      targetAssignee: target,
      stage: nextStage,
      body: formatLinearHandoff(state, nextStage),
      pipe: {
        pipeId: state.pipeId,
        mode: 'linear',
        role: 'handoff',
        stage: nextStage,
        targetAssignee: target,
        expectedAssignees: [target],
      },
    });
    return actions; // One action at a time for linear
  }

  return actions;
}

function computeMergeActions(state: PipeState): PipeAction[] {
  const actions: PipeAction[] = [];
  const isMergeAll = isMergeAllStyleMode(state.mode);
  const fanOutAssignees = isMergeAll ? state.assignees : state.assignees.slice(0, -1);
  const synthesizer = state.assignees[state.assignees.length - 1];

  // Check if fan-out requests need to be emitted
  for (const assignee of fanOutAssignees) {
    const key = emissionKey('fan-out-request', undefined, assignee);
    if (state.emittedRoles.has(key)) continue;
    actions.push({
      type: 'fan-out-request',
      targetAssignee: assignee,
      body: formatFanOutRequest(state, assignee),
      pipe: {
        pipeId: state.pipeId,
        mode: state.mode,
        role: 'fan-out-request',
        targetAssignee: assignee,
        expectedAssignees: fanOutAssignees,
      },
    });
  }
  if (actions.length > 0) return actions; // Emit fan-out first

  // Check if all fan-out replies are in and synth-request is missing
  const allFanOutDone = fanOutAssignees.every(a => state.fanOutOutputs.has(a));
  if (allFanOutDone && !state.hasSynthRequest) {
    actions.push({
      type: 'synth-request',
      targetAssignee: synthesizer,
      body: formatSynthRequest(state),
      pipe: {
        pipeId: state.pipeId,
        mode: state.mode,
        role: 'synth-request',
        targetAssignee: synthesizer,
        expectedAssignees: [synthesizer],
      },
    });
  }

  return actions;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function submitBlock(pipeId: string): string {
  return `Submit: pipe_submit(pipeId="${pipeId}", content="<your output>")\nDo not use chat_send. Submit once, then wait.`;
}

function formatLinearHandoff(state: PipeState, stage: number): string {
  const target = state.assignees[stage - 1];
  const total = state.assignees.length;
  const isLast = stage === total;
  const header = `#pipe-${state.pipeId} [linear | stage ${stage}/${total} | @${target}]`;

  const dest = isLast ? 'Final stage — your response goes to the user.' : 'Your output passes to the next stage.';
  let body = `${dest}\nPrompt: ${state.prompt}`;
  if (stage > 1) {
    body += `\n\nRead previous stage output: pipe_read_output(pipeId="${state.pipeId}")`;
  }

  return `${header}\n\n${body}\n\n${submitBlock(state.pipeId)}`;
}

function formatFanOutRequest(state: PipeState, assignee: string): string {
  const header = `#pipe-${state.pipeId} [${state.mode} | fan-out | @${assignee}]`;
  const mergeAll = isMergeAllStyleMode(state.mode);
  const synthesizer = state.assignees[state.assignees.length - 1];
  const isSynthesizer = mergeAll && assignee === synthesizer;

  let body: string;
  if (state.mode === 'explain') {
    body = `Explain independently (parallel). Respond with:
1. Problem  2. Simplest explanation  3. Mental model (≤5 steps)
4. Visual (Mermaid/ASCII/"No visual needed")  5. Key terms (≤5)
6. Common misunderstanding  7. Takeaway
Teach a smart beginner. Clarity over exhaustiveness.`;
  } else if (state.mode === 'summarize') {
    body = `Summarize independently (parallel). Respond with:
1. Topic  2. Key points (3–5 bullets)  3. Why it matters  4. TL;DR (1–2 sentences)
Compress, cut repetition, minimize jargon.`;
  } else {
    body = `Provide your independent analysis. Other participants answer in parallel.`;
  }

  body += `\nPrompt: ${state.prompt}`;
  if (isSynthesizer) {
    body += `\n\nYou have 2 stages. This is fan-out — submit your analysis now. Synthesis comes next.`;
  }

  return `${header}\n\n${body}\n\n${submitBlock(state.pipeId)}`;
}

function formatSynthRequest(state: PipeState): string {
  const synthesizer = state.assignees[state.assignees.length - 1];
  const header = `#pipe-${state.pipeId} [${state.mode} | synthesizer | @${synthesizer}]`;

  let body: string;
  if (state.mode === 'explain') {
    body = `Synthesize into one teaching response. Sections:
1. Problem  2. Simplest explanation  3. Mental model  4. Visual
5. Key terms  6. Common misunderstandings  7. Takeaway
Pick the clearest framing. At most one visual (Mermaid preferred).`;
  } else if (state.mode === 'summarize') {
    body = `Synthesize into one compact summary. Sections:
1. TL;DR  2. Key points  3. Why it matters  4. Caveat (only if important)
Pick the clearest framing. Drop redundant points.`;
  } else {
    body = `Synthesize the fan-out outputs into a unified response for the user.`;
  }

  body += `\nPrompt: ${state.prompt}`;
  body += `\n\nRead all fan-out outputs: pipe_read_output(pipeId="${state.pipeId}")`;

  return `${header}\n\n${body}\n\n${submitBlock(state.pipeId)}`;
}

// ── Pipe start description ───────────────────────────────────────────────────

export function generatePipeId(): string {
  return randomUUID().substring(0, 8);
}

export function getStartDescription(cmd: ParsedPipeCommand): string {
  if (cmd.mode === 'linear') {
    return cmd.assignees.map(a => `@${a}`).join(' \u2192 ');
  }
  const isMergeAll = isMergeAllStyleMode(cmd.mode);
  const fanOutList = isMergeAll ? cmd.assignees : cmd.assignees.slice(0, -1);
  const fanOut = fanOutList.map(a => `@${a}`).join(', ');
  const synthesizer = `@${cmd.assignees[cmd.assignees.length - 1]}`;
  return `[${fanOut}] \u2192 ${synthesizer}`;
}

/**
 * Determine the pipe role for an LLM response based on the current pipe state.
 * Returns the appropriate PipeMessageMeta if the sender is an expected assignee,
 * or null if the message is not a pipe response.
 */
export function matchResponse(
  state: PipeState,
  from: string,
): PipeMessageMeta | null {
  if (state.status !== 'running') return null;

  if (state.mode === 'linear') {
    // Find which stage is expecting a response from this sender
    for (let stage = 1; stage <= state.assignees.length; stage++) {
      if (state.assignees[stage - 1] !== from) continue;
      if (state.stageOutputs.has(stage)) continue; // already responded
      if (!state.hasHandoffs.has(stage)) continue; // not yet prompted

      const isLast = stage === state.assignees.length;
      return {
        pipeId: state.pipeId,
        mode: 'linear',
        role: isLast ? 'final' : 'stage-output',
        stage,
      };
    }
  }

  if (state.mode === 'merge' || isMergeAllStyleMode(state.mode)) {
    const isMergeAll = isMergeAllStyleMode(state.mode);
    const fanOutAssignees = isMergeAll ? state.assignees : state.assignees.slice(0, -1);
    const synthesizer = state.assignees[state.assignees.length - 1];

    // Fan-out response
    if (fanOutAssignees.includes(from) && !state.fanOutOutputs.has(from)) {
      return {
        pipeId: state.pipeId,
        mode: state.mode,
        role: 'fan-out',
      };
    }

    // Synthesizer response
    if (from === synthesizer && state.hasSynthRequest && !state.hasFinal) {
      return {
        pipeId: state.pipeId,
        mode: state.mode,
        role: 'final',
      };
    }
  }

  return null;
}
