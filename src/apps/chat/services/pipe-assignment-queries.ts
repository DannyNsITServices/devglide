/**
 * Pipe assignment query functions for lease-aware authorization.
 *
 * Re-exports getAssignmentsForParticipant from pipe-store (authoritative)
 * and adds getAssignmentForPipe for single-pipe lookups.
 * Used by pipe_list_assignments and pipe_get_assignment MCP tools/REST endpoints.
 */
import type { PipeMode, PipeStatus } from '../types.js';
import type { PipeSlot } from './pipe-store.js';
import * as pipeStore from './pipe-store.js';

// Re-export the authoritative type and list function from pipe-store
export type { ParticipantAssignment } from './pipe-store.js';
export { getAssignmentsForParticipant } from './pipe-store.js';

/** Get a single assignment's details for a participant on a specific pipe.
 *  Returns the most relevant slot (leased > pending > submitted). */
export function getAssignmentForPipe(
  pipeId: string,
  assignee: string,
  projectId: string | null,
): pipeStore.ParticipantAssignment | undefined {
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

  let leaseStatus: pipeStore.ParticipantAssignment['leaseStatus'] = 'none';
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
