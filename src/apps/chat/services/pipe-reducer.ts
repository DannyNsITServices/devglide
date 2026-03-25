import { randomUUID } from 'crypto';
import type { ChatMessage, PipeMode, PipeRole, PipeMessageMeta, PipeStatus } from '../types.js';
import type { ParsedPipeCommand } from './pipe-parser.js';

// ── Reducer state (derived from log scan) ────────────────────────────────────

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

// ── Reducer: compute next actions ────────────────────────────────────────────

export interface PipeAction {
  type: 'handoff' | 'fan-out-request' | 'synth-request';
  targetAssignee: string;
  stage?: number;
  body: string;
  pipe: PipeMessageMeta;
}

export function computeNextActions(state: PipeState): PipeAction[] {
  // Guard: terminal state → no actions
  if (state.hasFinal || state.hasFailed || state.hasCancelled) return [];

  if (state.mode === 'linear') return computeLinearActions(state);
  if (state.mode === 'merge' || state.mode === 'merge-all') return computeMergeActions(state);
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
      body: formatLinearHandoff(state, 1, null),
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
      body: formatLinearHandoff(state, nextStage, output.body),
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
  const isMergeAll = state.mode === 'merge-all';
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

function formatLinearHandoff(state: PipeState, stage: number, previousOutput: string | null): string {
  const target = state.assignees[stage - 1];
  const total = state.assignees.length;
  const isLast = stage === total;
  const header = `#pipe-${state.pipeId} [linear | stage ${stage}/${total} | @${target}]`;

  let instruction: string;
  if (isLast) {
    instruction = 'You are the final stage. Your response will be delivered to the user.';
  } else if (stage === 1) {
    instruction = 'Your output will be passed to the next stage.';
  } else {
    instruction = 'Refine or build on the previous output. Your result goes to the next stage.';
  }

  let body = `${header}\n${instruction}\nPrompt: ${state.prompt}`;
  if (previousOutput) {
    body += `\n\n--- Previous stage output ---\n${previousOutput}`;
  }
  return body;
}

function formatFanOutRequest(state: PipeState, assignee: string): string {
  const header = `#pipe-${state.pipeId} [${state.mode} | fan-out | @${assignee}]`;
  const instruction = 'Provide your independent analysis. Other participants answer in parallel.';
  return `${header}\n${instruction}\nPrompt: ${state.prompt}`;
}

function formatSynthRequest(state: PipeState): string {
  const synthesizer = state.assignees[state.assignees.length - 1];
  const header = `#pipe-${state.pipeId} [${state.mode} | synthesizer | @${synthesizer}]`;
  const instruction = 'Synthesize the outputs below into a unified response for the user.';

  let context = '';
  for (const [assignee, output] of state.fanOutOutputs) {
    if (state.mode === 'merge-all' && assignee === synthesizer) continue;
    context += `\n--- @${assignee} output ---\n${output}\n`;
  }

  return `${header}\n${instruction}\nPrompt: ${state.prompt}${context}`;
}

// ── Pipe start description ───────────────────────────────────────────────────

export function generatePipeId(): string {
  return randomUUID().substring(0, 8);
}

export function getStartDescription(cmd: ParsedPipeCommand): string {
  if (cmd.mode === 'linear') {
    return cmd.assignees.map(a => `@${a}`).join(' \u2192 ');
  }
  const isMergeAll = cmd.mode === 'merge-all';
  const fanOutList = isMergeAll ? cmd.assignees : cmd.assignees.slice(0, -1);
  const fanOut = fanOutList.map(a => `@${a}`).join(', ');
  const synthesizer = `@${cmd.assignees[cmd.assignees.length - 1]}`;
  return `[${fanOut}] \u2192 ${synthesizer}`;
}

// ── Pipe membership check (for fail-fast) ────────────────────────────────────

export interface ActivePipeInfo {
  pipeId: string;
  mode: PipeMode;
  assignee: string;
}

/**
 * Check if a participant is an active assignee in any running pipe.
 * Scans the log for pipes where this participant is expected but the pipe
 * is not yet terminal.
 */
export function findActivePipesForParticipant(
  messages: ChatMessage[],
  participantName: string,
): ActivePipeInfo[] {
  // Collect all pipeIds from messages
  const pipeIds = new Set<string>();
  for (const msg of messages) {
    if (msg.pipe?.pipeId) pipeIds.add(msg.pipe.pipeId);
  }

  const result: ActivePipeInfo[] = [];
  for (const pipeId of pipeIds) {
    const state = derivePipeState(messages, pipeId);
    if (!state || state.status !== 'running') continue;
    if (!state.assignees.includes(participantName)) continue;

    // Only include if participant still has pending work in this pipe
    if (!hasUnfinishedWork(state, participantName)) continue;

    result.push({ pipeId, mode: state.mode, assignee: participantName });
  }
  return result;
}

/** Check if a participant still has unfinished work in a pipe.
 *  For merge synthesizer: always unfinished while pipe is running and no final
 *  exists — even before synth-request is emitted, because they will be needed. */
function hasUnfinishedWork(state: PipeState, name: string): boolean {
  if (state.mode === 'linear') {
    const stageIdx = state.assignees.indexOf(name);
    if (stageIdx === -1) return false;
    const stage = stageIdx + 1;
    // Finished if they already produced stage-output (or final for last stage)
    return !state.stageOutputs.has(stage) && !state.hasFinal;
  }

  if (state.mode === 'merge' || state.mode === 'merge-all') {
    const isMergeAll = state.mode === 'merge-all';
    const fanOutAssignees = isMergeAll ? state.assignees : state.assignees.slice(0, -1);
    const synthesizer = state.assignees[state.assignees.length - 1];

    if (fanOutAssignees.includes(name) && !state.fanOutOutputs.has(name)) {
      return true;
    }
    if (name === synthesizer) {
      // Synthesizer is needed as long as pipe is running and has no final output —
      // even before synth-request is emitted (during fan-out phase).
      return !state.hasFinal;
    }
  }

  return false;
}

// Export for testing
export { hasUnfinishedWork as _hasUnfinishedWork };

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

  if (state.mode === 'merge' || state.mode === 'merge-all') {
    const isMergeAll = state.mode === 'merge-all';
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
