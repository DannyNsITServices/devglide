/**
 * Playbook compiler — maps a PlaybookId + team members to an ordered list
 * of TeamRunStages that can be dispatched as a linear pipe.
 *
 * MVP playbooks:
 *   change-request: tech-lead → implementer → reviewer → tester → kanban
 *   bug-fix:        tech-lead → implementer → reviewer → tester
 *   custom:         caller provides stages directly
 */

import type { PlaybookId, TeamRunStage } from './team-run-store.js';
import type { TeamMember } from './team-store.js';

// ── Playbook definitions ──────────────────────────────────────────────────────

interface PlaybookStageTemplate {
  roleSlug: string;
  description: string;
}

const PLAYBOOK_TEMPLATES: Record<Exclude<PlaybookId, 'custom'>, PlaybookStageTemplate[]> = {
  'change-request': [
    { roleSlug: 'tech-lead', description: 'Break down requirements and plan implementation' },
    { roleSlug: 'implementer', description: 'Implement the change' },
    { roleSlug: 'reviewer', description: 'Review the implementation' },
    { roleSlug: 'tester', description: 'Verify the change meets requirements' },
    { roleSlug: 'kanban', description: 'Update the task board' },
  ],
  'bug-fix': [
    { roleSlug: 'tech-lead', description: 'Diagnose the bug and plan the fix' },
    { roleSlug: 'implementer', description: 'Implement the fix' },
    { roleSlug: 'reviewer', description: 'Review the fix' },
    { roleSlug: 'tester', description: 'Verify the bug is resolved' },
  ],
};

// ── Compiler ──────────────────────────────────────────────────────────────────

/**
 * Compile a playbook into ordered TeamRunStages.
 *
 * Stages are populated with the assignee from the team's current member list.
 * If a role has no assigned member, `assignee` is set to null — the caller
 * (or safeguards layer) must decide whether to allow a null-assignee run.
 *
 * Roles not present in the playbook are ignored.
 */
export function compilePlaybook(
  playbook: Exclude<PlaybookId, 'custom'>,
  members: TeamMember[],
): TeamRunStage[] {
  const templates = PLAYBOOK_TEMPLATES[playbook];
  const memberByRole = new Map(members.map(m => [m.roleSlug, m.participantName]));

  return templates.map((tpl, index) => ({
    index,
    roleSlug: tpl.roleSlug,
    assignee: memberByRole.get(tpl.roleSlug) ?? null,
    description: tpl.description,
    pipeId: null,
    status: 'pending' as const,
  }));
}

/**
 * Extract the ordered list of assignee names for stages that have a
 * non-null assignee. Used to build the linear pipe assignees array.
 * Null-assignee stages are excluded — callers should run safeguards first.
 */
export function extractAssigneesFromStages(stages: TeamRunStage[]): string[] {
  return stages
    .filter(s => s.assignee !== null)
    .map(s => s.assignee as string);
}

/**
 * Build the stage descriptions joined into a linear pipe prompt prefix.
 * The user-supplied prompt is appended after a separator line.
 */
export function buildPipePrompt(stages: TeamRunStage[], userPrompt: string): string {
  const stageLines = stages
    .filter(s => s.assignee !== null)
    .map((s, i) => `Stage ${i + 1} (@${s.assignee}): ${s.description}`)
    .join('\n');

  return `Team run — staged execution:\n${stageLines}\n\nTask: ${userPrompt}`;
}

/** Return the template for a playbook, or null for 'custom'. */
export function getPlaybookTemplate(
  playbook: PlaybookId,
): PlaybookStageTemplate[] | null {
  if (playbook === 'custom') return null;
  return PLAYBOOK_TEMPLATES[playbook];
}

/** List all built-in playbook IDs. */
export function listPlaybooks(): Exclude<PlaybookId, 'custom'>[] {
  return Object.keys(PLAYBOOK_TEMPLATES) as Exclude<PlaybookId, 'custom'>[];
}
