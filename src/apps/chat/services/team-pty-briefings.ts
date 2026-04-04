/**
 * PTY role briefing utilities.
 *
 * When a participant is assigned a team role (on team creation, or on role
 * change), a non-executable informational briefing is injected into their
 * pane. The briefing follows the same visual style as other system chat
 * notifications but is clearly marked as informational — it must not be
 * mistaken for a pipe instruction or an assignment with an action required.
 */

import type { TeamRoleTemplate } from './team-roles.js';

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format the PTY briefing that is injected when a participant joins a team
 * or their role changes.
 *
 * The message is:
 *   - Informational only (no `pipe_submit` or action directive)
 *   - Clearly attributed to the team system
 *   - Short enough to fit in a single PTY injection
 */
export function formatRoleBriefing(
  participantName: string,
  teamName: string,
  role: TeamRoleTemplate,
): string {
  const lines = [
    `[Team: ${teamName}] Role assigned — ${role.displayName}`,
    ``,
    role.description,
    ``,
    `Your instructions for this team:`,
    role.instructions,
    ``,
    `This is an informational briefing. No action is required now.`,
    `You will receive assignments via normal chat or pipe delivery when work starts.`,
  ];
  return lines.join('\n');
}

/**
 * Format a briefing for when a participant is removed from the team.
 */
export function formatRemovalBriefing(
  participantName: string,
  teamName: string,
  previousRoleDisplayName: string,
): string {
  return [
    `[Team: ${teamName}] Role removed`,
    ``,
    `You have been removed from the "${previousRoleDisplayName}" role in team "${teamName}".`,
    `You are no longer part of the active team configuration.`,
    `This is an informational notice. No action is required.`,
  ].join('\n');
}

/**
 * Format a briefing for when the team is disbanded.
 */
export function formatDisbandBriefing(teamName: string): string {
  return [
    `[Team: ${teamName}] Team disbanded`,
    ``,
    `The team "${teamName}" has been disbanded. All role assignments are now inactive.`,
    `Any in-progress runs have been cancelled.`,
    `This is an informational notice. No action is required.`,
  ].join('\n');
}

/**
 * Format a briefing for when a team run starts.
 * Sent to all assigned participants before the first pipe handoff.
 */
export function formatRunStartBriefing(
  teamName: string,
  playbook: string,
  prompt: string,
  participantRole: string,
  stageIndex: number,
  totalStages: number,
): string {
  return [
    `[Team: ${teamName}] Run started — ${playbook}`,
    ``,
    `Task: ${prompt}`,
    ``,
    `Your role: ${participantRole} (Stage ${stageIndex + 1} of ${totalStages})`,
    ``,
    `You will receive a pipe assignment when it is your turn.`,
    `This is an informational briefing. No action is required yet.`,
  ].join('\n');
}
