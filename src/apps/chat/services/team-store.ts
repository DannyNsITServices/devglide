/**
 * Durable team store — one active team per project.
 * State is persisted as JSON at ~/.devglide/projects/{id}/chat/team.json.
 * Disbanding does not delete the file; it sets status to 'disbanded' so history is preserved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { projectDataDir } from '../../../packages/paths.js';
import { getActiveProject } from '../../../project-context.js';
import { getRole } from './team-roles.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TeamMember {
  participantName: string;
  roleSlug: string;
  assignedAt: string;
}

export type TeamStatus = 'active' | 'paused' | 'disbanded';

export interface ActiveTeam {
  id: string;
  name: string;
  projectId: string;
  members: TeamMember[];
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
}

/** Role context attached to a chat_join response when the participant is part of a team. */
export interface ParticipantTeamContext {
  teamId: string;
  teamName: string;
  teamStatus: TeamStatus;
  roleSlug: string;
  roleDisplayName: string;
  /** Full briefing for the LLM — pulled from the role template's instructions. */
  roleBriefing: string;
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function resolveProjectId(projectId?: string | null): string | null {
  return projectId ?? getActiveProject()?.id ?? null;
}

function getTeamPath(projectId: string): string {
  const dir = projectDataDir(projectId, 'chat');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'team.json');
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Load the team record for the given project.
 * Returns null if no team file exists or if it cannot be parsed.
 * Disbanded teams ARE returned — callers decide whether to surface them.
 */
export function getTeam(projectId?: string | null): ActiveTeam | null {
  const pid = resolveProjectId(projectId);
  if (!pid) return null;
  const path = getTeamPath(pid);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ActiveTeam;
  } catch {
    return null;
  }
}

/**
 * Get the team only if it is in a non-disbanded state.
 * Returns null for disbanded or missing teams.
 */
export function getActiveTeam(projectId?: string | null): ActiveTeam | null {
  const team = getTeam(projectId);
  if (!team || team.status === 'disbanded') return null;
  return team;
}

// ── Write ─────────────────────────────────────────────────────────────────────

function saveTeam(team: ActiveTeam): void {
  writeFileSync(getTeamPath(team.projectId), JSON.stringify(team, null, 2), 'utf8');
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateTeamOpts {
  name: string;
  /** Initial member assignments. Each entry must carry a valid role slug. */
  members?: TeamMember[];
}

/**
 * Create a new team for the project.
 * Throws if a non-disbanded team already exists.
 */
export function createTeam(projectId: string, opts: CreateTeamOpts): ActiveTeam {
  const existing = getActiveTeam(projectId);
  if (existing) {
    throw new Error(
      `A team "${existing.name}" is already active for this project. Disband it first before creating a new one.`,
    );
  }
  const now = new Date().toISOString();
  const team: ActiveTeam = {
    id: randomUUID(),
    name: opts.name.trim(),
    projectId,
    members: opts.members ?? [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  saveTeam(team);
  return team;
}

export interface UpdateTeamOpts {
  name?: string;
  status?: TeamStatus;
  members?: TeamMember[];
}

/**
 * Update team metadata or status.
 * Throws if no team exists or if the team is disbanded.
 */
export function updateTeam(projectId: string, opts: UpdateTeamOpts): ActiveTeam {
  const team = getTeam(projectId);
  if (!team) throw new Error('No team found for this project. Create one first.');
  if (team.status === 'disbanded') throw new Error('Cannot update a disbanded team.');

  const updated: ActiveTeam = {
    ...team,
    ...(opts.name !== undefined ? { name: opts.name.trim() } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.members !== undefined ? { members: opts.members } : {}),
    updatedAt: new Date().toISOString(),
  };
  saveTeam(updated);
  return updated;
}

/**
 * Mark the team as disbanded.
 * The record is preserved on disk with status 'disbanded'.
 * Throws if no team exists or already disbanded.
 */
export function disbandTeam(projectId: string): ActiveTeam {
  const team = getTeam(projectId);
  if (!team) throw new Error('No team found for this project.');
  if (team.status === 'disbanded') throw new Error('Team is already disbanded.');

  const disbanded: ActiveTeam = { ...team, status: 'disbanded', updatedAt: new Date().toISOString() };
  saveTeam(disbanded);
  return disbanded;
}

// ── Member management ────────────────────────────────────────────────────────

/**
 * Assign a participant to a role.
 * If the participant is already assigned to a different role, the old assignment is replaced.
 * Throws if the role slug is not a valid built-in role, or if the team doesn't exist / is disbanded.
 */
export function assignMember(projectId: string, participantName: string, roleSlug: string): ActiveTeam {
  if (!getRole(roleSlug)) {
    throw new Error(`"${roleSlug}" is not a valid role slug. Use team_list_roles to see available roles.`);
  }
  const team = getActiveTeam(projectId);
  if (!team) throw new Error('No active team found. Create or resume a team first.');

  const now = new Date().toISOString();
  const members = team.members.filter((m) => m.participantName !== participantName);
  members.push({ participantName, roleSlug, assignedAt: now });
  return updateTeam(projectId, { members });
}

/**
 * Remove a participant from the team.
 * No-ops if the participant was not assigned.
 * Throws if the team doesn't exist or is disbanded.
 */
export function removeMember(projectId: string, participantName: string): ActiveTeam {
  const team = getActiveTeam(projectId);
  if (!team) throw new Error('No active team found.');

  const members = team.members.filter((m) => m.participantName !== participantName);
  return updateTeam(projectId, { members });
}

// ── Join-time context ────────────────────────────────────────────────────────

/**
 * Return role context for a participant if they are assigned in the active team.
 * Returns null if there is no active team or the participant has no role.
 * This is the object added to the chat_join response.
 */
export function getParticipantTeamContext(
  projectId?: string | null,
  participantName?: string | null,
): ParticipantTeamContext | null {
  if (!participantName) return null;
  const team = getActiveTeam(projectId);
  if (!team) return null;

  const member = team.members.find((m) => m.participantName === participantName);
  if (!member) return null;

  const role = getRole(member.roleSlug);
  if (!role) return null;

  return {
    teamId: team.id,
    teamName: team.name,
    teamStatus: team.status,
    roleSlug: role.slug,
    roleDisplayName: role.displayName,
    roleBriefing: role.instructions,
  };
}
