/**
 * Pipe assignment query functions for lease-aware authorization.
 *
 * Provides participant-scoped views of active assignments across running pipes,
 * with lease status and deadline visibility. Used by pipe_list_assignments and
 * pipe_get_assignment MCP tools and REST endpoints.
 */
import type { PipeMode, PipeStatus } from '../types.js';
import type { PipeSlot } from './pipe-store.js';
import * as pipeStore from './pipe-store.js';

export interface ParticipantAssignment {
  pipeId: string;
  mode: PipeMode;
  role: PipeSlot['role'];
  stage?: number;
  slotStatus: PipeSlot['status'];
  leaseStatus: 'active' | 'expired' | 'none';
  deadline: string | null;
  grantedAt: string | null;
  pipeStatus: PipeStatus;
}

/** List all assignments (active, pending, and leased slots) for a participant across running pipes.
 *  Used by pipe_list_assignments to give participants visibility into their work queue. */
export function getAssignmentsForParticipant(
  assignee: string,
  projectId: string | null,
): ParticipantAssignment[] {
  const activePipeIds = pipeStore.getActivePipesForParticipant(assignee, projectId);
  const assignments: ParticipantAssignment[] = [];
  const lease = pipeStore.getActiveLease(assignee, projectId);

  for (const pipeId of activePipeIds) {
    const pipe = pipeStore.getPipe(pipeId, projectId);
    if (!pipe) continue;
    const slots = pipe.slots.get(assignee);
    if (!slots) continue;

    for (const slot of slots) {
      const isLeasedSlot = lease?.pipeId === pipeId
        && lease.slotRole === slot.role
        && (lease.stage === slot.stage || (lease.stage === undefined && slot.stage === undefined));

      let leaseStatus: ParticipantAssignment['leaseStatus'] = 'none';
      let deadline: string | null = null;
      let grantedAt: string | null = null;

      if (isLeasedSlot && lease) {
        leaseStatus = pipeStore.isLeaseExpired(lease) ? 'expired' : 'active';
        deadline = lease.deadline;
        grantedAt = lease.grantedAt;
      }

      assignments.push({
        pipeId, mode: pipe.mode, role: slot.role, stage: slot.stage,
        slotStatus: slot.status, leaseStatus, deadline, grantedAt, pipeStatus: pipe.status,
      });
    }
  }
  return assignments;
}

/** Get a single assignment's details for a participant on a specific pipe.
 *  Returns the most relevant slot (leased > pending > submitted). */
export function getAssignmentForPipe(
  pipeId: string,
  assignee: string,
  projectId: string | null,
): ParticipantAssignment | undefined {
  const pipe = pipeStore.getPipe(pipeId, projectId);
  if (!pipe) return undefined;
  const slots = pipe.slots.get(assignee);
  if (!slots || slots.length === 0) return undefined;

  const lease = pipeStore.getActiveLease(assignee, projectId);
  const sorted = [...slots].sort((a, b) => {
    const order: Record<string, number> = { leased: 0, pending: 1, submitted: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  const slot = sorted[0];
  const isLeasedSlot = lease?.pipeId === pipeId
    && lease.slotRole === slot.role
    && (lease.stage === slot.stage || (lease.stage === undefined && slot.stage === undefined));

  let leaseStatus: ParticipantAssignment['leaseStatus'] = 'none';
  let deadline: string | null = null;
  let grantedAt: string | null = null;

  if (isLeasedSlot && lease) {
    leaseStatus = pipeStore.isLeaseExpired(lease) ? 'expired' : 'active';
    deadline = lease.deadline;
    grantedAt = lease.grantedAt;
  }

  return {
    pipeId, mode: pipe.mode, role: slot.role, stage: slot.stage,
    slotStatus: slot.status, leaseStatus, deadline, grantedAt, pipeStatus: pipe.status,
  };
}
