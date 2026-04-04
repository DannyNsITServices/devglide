/**
 * Independence and detached-member safeguards for team runs.
 *
 * Rules enforced:
 * 1. Self-review: A participant CANNOT hold both implementer and reviewer
 *    roles in the same run — that violates the independence policy.
 * 2. Detached members: A participant marked `detached: true` cannot be
 *    assigned an active stage — the run must wait or be reassigned.
 * 3. Null assignees: A stage with no assigned member blocks the run from
 *    starting unless the missing role is non-blocking (kanban).
 * 4. Disband safety: Disbanding a team with an active run requires the run
 *    to be cancelled first; this function returns the warning text.
 */

import type { TeamRunStage } from './team-run-store.js';
import type { ActiveTeam } from './team-store.js';
import type { ChatParticipant } from '../types.js';

// ── Role independence policy ───────────────────────────────────────────────────

/**
 * Pairs of roles that must NOT be held by the same participant in the same run.
 * Each tuple is [roleA, roleB] — the pair is symmetric.
 */
const INDEPENDENCE_PAIRS: [string, string][] = [
  ['implementer', 'reviewer'],
  ['implementer', 'tester'],
  ['tech-lead', 'reviewer'], // tech-lead should not self-review either
];

export interface SafeguardError {
  code: string;
  message: string;
}

/**
 * Check whether a set of compiled stages violates the independence policy.
 * Returns an error if any prohibited role pair is held by the same participant,
 * or null if the stages are safe.
 */
export function checkRunIndependence(stages: TeamRunStage[]): SafeguardError | null {
  // Build a map from assignee → list of roles they hold
  const assigneeRoles = new Map<string, string[]>();
  for (const stage of stages) {
    if (!stage.assignee) continue;
    const roles = assigneeRoles.get(stage.assignee) ?? [];
    roles.push(stage.roleSlug);
    assigneeRoles.set(stage.assignee, roles);
  }

  for (const [assignee, roles] of assigneeRoles) {
    for (const [a, b] of INDEPENDENCE_PAIRS) {
      if (roles.includes(a) && roles.includes(b)) {
        return {
          code: 'SELF_REVIEW_VIOLATION',
          message: `@${assignee} is assigned both "${a}" and "${b}" roles in this run. These roles require independent participants. Reassign one role to a different agent.`,
        };
      }
    }
  }

  return null;
}

/**
 * Check whether any stage assignee is currently detached.
 * Returns an error listing all detached assignees, or null if all are live.
 */
export function checkDetachedAssignees(
  stages: TeamRunStage[],
  participants: Map<string, ChatParticipant>,
): SafeguardError | null {
  const detached: string[] = [];

  for (const stage of stages) {
    if (!stage.assignee) continue;
    const p = participants.get(stage.assignee);
    if (p && p.detached) {
      detached.push(stage.assignee);
    }
  }

  if (detached.length === 0) return null;

  return {
    code: 'DETACHED_ASSIGNEES',
    message: `The following assignees are detached (MCP session closed): ${detached.map(n => `@${n}`).join(', ')}. They must reconnect before the run can start.`,
  };
}

/** Roles that are non-blocking when unassigned (run can proceed without them). */
const NON_BLOCKING_ROLES = new Set(['kanban']);

/**
 * Check whether any required stage lacks an assignee.
 * Returns an error if a blocking role has no assignee, or null if safe.
 */
export function checkMissingAssignees(stages: TeamRunStage[]): SafeguardError | null {
  const missing: string[] = [];

  for (const stage of stages) {
    if (stage.assignee === null && !NON_BLOCKING_ROLES.has(stage.roleSlug)) {
      missing.push(stage.roleSlug);
    }
  }

  if (missing.length === 0) return null;

  return {
    code: 'MISSING_ASSIGNEES',
    message: `The following roles have no assigned participant: ${missing.join(', ')}. Assign team members before starting the run.`,
  };
}

/**
 * Run all pre-start safeguards in order.
 * Returns the first error found, or null if all checks pass.
 */
export function validateRunSafeguards(
  stages: TeamRunStage[],
  participants: Map<string, ChatParticipant>,
): SafeguardError | null {
  return (
    checkMissingAssignees(stages) ??
    checkRunIndependence(stages) ??
    checkDetachedAssignees(stages, participants)
  );
}

/**
 * Check whether it is safe to disband the team given a potentially active run.
 * Returns a warning message if an active run will be cancelled, or null if clean.
 */
export function getDisbandWarning(team: ActiveTeam, activeRunId: string | null): string | null {
  if (!activeRunId) return null;
  return `Team "${team.name}" has an active run in progress. Disbanding will cancel it. Proceed with caution.`;
}

/**
 * Return a filtered copy of stages with null-assignee non-blocking roles removed.
 * This allows a run to proceed without optional roles like kanban.
 */
export function stripNonBlockingUnassignedStages(stages: TeamRunStage[]): TeamRunStage[] {
  return stages.filter(s => !(s.assignee === null && NON_BLOCKING_ROLES.has(s.roleSlug)));
}
