import * as assignmentStore from './assignment-store.js';
import * as payloadStore from './payload-store.js';
import type { PipeMode, AssignmentStatus } from '../types.js';

/** Result of materializing assignments for a pipe action. */
export interface MaterializedAssignment {
  assignmentId: string;
  payloadId: string;
  stageId: string;
  assignee: string;
  role: 'stage-output' | 'fan-out' | 'final';
  stage?: number;
  notification: assignmentStore.AssignmentNotification;
}

/**
 * Materialize an assignment + payload for a pipe action.
 * Called by the reducer orchestration when an action is emitted.
 * Creates the payload first (content), then the assignment (referencing payloadId).
 * Returns the materialized assignment or null if creation failed.
 */
export function materializeAssignment(
  pipeId: string,
  mode: PipeMode,
  action: {
    type: 'handoff' | 'fan-out-request' | 'synth-request';
    targetAssignee: string;
    stage?: number;
    body: string;
  },
  projectId: string | null,
): MaterializedAssignment | null {
  // Derive role from action type
  const role = actionTypeToRole(action.type);
  const stageId = assignmentStore.deriveStageId(mode, role, {
    stage: action.stage,
    assignee: action.targetAssignee,
  });

  // Create payload first
  const payloadResult = payloadStore.createPayload(pipeId, stageId, action.body, projectId, {
    sourceStage: action.stage ? action.stage - 1 : undefined,
  });
  if (!payloadResult.ok || !payloadResult.payload) return null;

  // Create assignment referencing the payload
  const assignResult = assignmentStore.createAssignment(
    pipeId, stageId, payloadResult.payload.payloadId,
    action.targetAssignee, role, projectId,
    { stage: action.stage },
  );
  if (!assignResult.ok || !assignResult.assignment) return null;

  const a = assignResult.assignment;
  return {
    assignmentId: a.assignmentId,
    payloadId: payloadResult.payload.payloadId,
    stageId,
    assignee: a.assignee,
    role,
    stage: a.stage,
    notification: {
      assignmentId: a.assignmentId,
      pipeId,
      stageId,
      role,
      stage: a.stage,
      attempt: a.attempt,
      payloadId: payloadResult.payload.payloadId,
    },
  };
}

/**
 * Materialize all assignments for a newly created pipe.
 * For merge/merge-all modes, creates fan-out assignments upfront.
 * For linear, only the first stage assignment is created (rest on demand).
 */
export function materializePipeAssignments(
  pipeId: string,
  mode: PipeMode,
  assignees: string[],
  prompt: string,
  projectId: string | null,
): MaterializedAssignment[] {
  const results: MaterializedAssignment[] = [];

  if (mode === 'linear') {
    // Linear: only materialize stage 1 — subsequent stages are created on submission
    const result = materializeAssignment(pipeId, mode, {
      type: 'handoff',
      targetAssignee: assignees[0],
      stage: 1,
      body: prompt,
    }, projectId);
    if (result) results.push(result);
  } else {
    // Merge / merge-all / explain / summarize: materialize all fan-out assignments
    const isMergeAll = mode === 'merge-all' || mode === 'explain' || mode === 'summarize';
    const fanOutAssignees = isMergeAll ? assignees : assignees.slice(0, -1);

    for (const assignee of fanOutAssignees) {
      const result = materializeAssignment(pipeId, mode, {
        type: 'fan-out-request',
        targetAssignee: assignee,
        body: prompt,
      }, projectId);
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Transition an assignment through the delivery lifecycle.
 * Returns the updated assignment or null if transition failed.
 */
export function transitionAssignmentStatus(
  assignmentId: string,
  newStatus: AssignmentStatus,
  projectId: string | null,
): assignmentStore.Assignment | null {
  const result = assignmentStore.transitionAssignment(assignmentId, newStatus, projectId);
  return result.ok ? (result.assignment ?? null) : null;
}

/**
 * Handle submission: walk assignment through any needed intermediate transitions
 * to reach 'submitted', then archive the payload.
 * Handles cases where assignee submits without explicit fetch (legacy path).
 */
export function completeAssignment(
  assignmentId: string,
  projectId: string | null,
): boolean {
  const assignment = assignmentStore.getAssignment(assignmentId, projectId);
  if (!assignment) return false;

  // Walk through intermediate states if needed (legacy path: submit without fetch)
  const stepsToSubmitted: import('../types.js').AssignmentStatus[] = [
    'notified', 'acknowledged', 'payload_fetched', 'submitted',
  ];
  const currentIdx = stepsToSubmitted.indexOf(assignment.status);
  const targetIdx = stepsToSubmitted.indexOf('submitted');

  if (assignment.status === 'assigned') {
    // Fast-forward from assigned through all intermediate states
    for (const step of stepsToSubmitted) {
      const r = assignmentStore.transitionAssignment(assignmentId, step, projectId);
      if (!r.ok) return false;
    }
  } else if (currentIdx >= 0 && currentIdx < targetIdx) {
    // Walk from current position to submitted
    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const r = assignmentStore.transitionAssignment(assignmentId, stepsToSubmitted[i], projectId);
      if (!r.ok) return false;
    }
  } else if (assignment.status !== 'submitted') {
    // Direct transition attempt
    const r = assignmentStore.transitionAssignment(assignmentId, 'submitted', projectId);
    if (!r.ok) return false;
  }

  payloadStore.archivePayload(assignment.payloadId, projectId);
  return true;
}

/**
 * Cancel all assignments for a pipe (on pipe cancel/failure).
 * Also archives all associated payloads.
 * Returns the cancelled assignmentIds.
 */
export function cancelPipeAssignments(
  pipeId: string,
  projectId: string | null,
): string[] {
  const cancelled = assignmentStore.cancelPipeAssignments(pipeId, projectId);
  payloadStore.archivePipePayloads(pipeId, projectId);
  return cancelled;
}

/**
 * Materialize the next assignment when a linear stage completes.
 * Called after a stage submission to create the assignment for the next stage.
 */
export function materializeNextLinearAssignment(
  pipeId: string,
  completedStage: number,
  assignees: string[],
  body: string,
  projectId: string | null,
): MaterializedAssignment | null {
  const nextStage = completedStage + 1;
  if (nextStage > assignees.length) return null;

  return materializeAssignment(pipeId, 'linear', {
    type: 'handoff',
    targetAssignee: assignees[nextStage - 1],
    stage: nextStage,
    body,
  }, projectId);
}

/**
 * Materialize the synthesizer assignment after all fan-outs complete.
 */
export function materializeSynthAssignment(
  pipeId: string,
  mode: PipeMode,
  synthesizer: string,
  synthBody: string,
  projectId: string | null,
): MaterializedAssignment | null {
  return materializeAssignment(pipeId, mode, {
    type: 'synth-request',
    targetAssignee: synthesizer,
    body: synthBody,
  }, projectId);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function actionTypeToRole(
  actionType: 'handoff' | 'fan-out-request' | 'synth-request',
): 'stage-output' | 'fan-out' | 'final' {
  if (actionType === 'synth-request') return 'final';
  if (actionType === 'fan-out-request') return 'fan-out';
  return 'stage-output';
}

/**
 * Get the assignment notification envelope for an existing assignment.
 * Used for re-delivery after reconnect.
 */
export function getAssignmentNotification(
  assignmentId: string,
  projectId: string | null,
): assignmentStore.AssignmentNotification | null {
  const assignment = assignmentStore.getAssignment(assignmentId, projectId);
  if (!assignment) return null;
  return assignmentStore.toNotification(assignment);
}

/**
 * Get active (non-terminal) assignments for a participant on a specific pipe.
 * Used during submission to find the assignment to complete.
 */
export function getActiveAssignmentsForParticipant(
  assignee: string,
  pipeId: string,
  projectId: string | null,
): assignmentStore.Assignment[] {
  const all = assignmentStore.getAssignmentsByPipe(pipeId, projectId);
  return all.filter((a: assignmentStore.Assignment) => a.assignee === assignee && !isTerminal(a.status));
}

function isTerminal(status: import('../types.js').AssignmentStatus): boolean {
  return ['submitted', 'expired', 'reassigned', 'superseded', 'cancelled'].includes(status);
}
