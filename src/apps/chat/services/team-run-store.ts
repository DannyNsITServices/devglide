/**
 * In-memory store for team runs and proposals.
 *
 * A team run is a higher-level concept that sits above a pipe run.
 * It tracks the playbook, stages, context metadata, and overall lifecycle.
 * Each run compiles down to a linear pipe for execution.
 *
 * Proposals are created when an unaddressed user imperative arrives while
 * the team is in assist mode. The user approves/rejects before execution.
 */

import { randomUUID } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlaybookId = 'change-request' | 'bug-fix' | 'custom';

export type TeamRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TeamRunStage {
  index: number;         // 0-based
  roleSlug: string;
  assignee: string | null; // null = role not yet filled
  description: string;
  pipeId: string | null;   // populated once the stage is dispatched
  status: 'pending' | 'active' | 'complete' | 'skipped' | 'failed';
}

export interface TeamRun {
  id: string;
  teamId: string;
  projectId: string | null;
  playbook: PlaybookId;
  prompt: string;
  stages: TeamRunStage[];
  status: TeamRunStatus;
  currentStageIndex: number;
  /** Snapshot of the team at run-creation time. */
  teamContext: Record<string, unknown>;
  /** Per-stage role assignments at run-creation time, keyed by stageIndex. */
  roleContext: Record<string, unknown>;
  /** The work prompt and any additional user-supplied context. */
  workContext: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Pipe ID created when the full run is dispatched as a linear pipe. */
  pipeId: string | null;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'dismissed';

export interface TeamProposal {
  id: string;
  teamId: string;
  projectId: string | null;
  /** The raw user message that triggered this proposal. */
  triggerMessage: string;
  playbook: PlaybookId;
  prompt: string;
  /** Pre-compiled stages, shown to the user before approval. */
  stages: TeamRunStage[];
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}

// ── In-memory storage ─────────────────────────────────────────────────────────

// projectId → runId → TeamRun
const runsByProject = new Map<string | null, Map<string, TeamRun>>();
// projectId → proposalId → TeamProposal
const proposalsByProject = new Map<string | null, Map<string, TeamProposal>>();

function getRunStore(projectId: string | null): Map<string, TeamRun> {
  let m = runsByProject.get(projectId);
  if (!m) { m = new Map(); runsByProject.set(projectId, m); }
  return m;
}

function getProposalStore(projectId: string | null): Map<string, TeamProposal> {
  let m = proposalsByProject.get(projectId);
  if (!m) { m = new Map(); proposalsByProject.set(projectId, m); }
  return m;
}

// ── Team Run ──────────────────────────────────────────────────────────────────

export function createTeamRun(
  teamId: string,
  projectId: string | null,
  opts: {
    playbook: PlaybookId;
    prompt: string;
    stages: TeamRunStage[];
    teamContext?: Record<string, unknown>;
    roleContext?: Record<string, unknown>;
    workContext?: Record<string, unknown>;
  },
): TeamRun {
  const now = new Date().toISOString();
  const run: TeamRun = {
    id: randomUUID(),
    teamId,
    projectId,
    playbook: opts.playbook,
    prompt: opts.prompt,
    stages: opts.stages,
    status: 'pending',
    currentStageIndex: 0,
    teamContext: opts.teamContext ?? {},
    roleContext: opts.roleContext ?? {},
    workContext: opts.workContext ?? { prompt: opts.prompt },
    createdAt: now,
    updatedAt: now,
    pipeId: null,
  };
  getRunStore(projectId).set(run.id, run);
  return run;
}

export function getTeamRun(runId: string, projectId: string | null): TeamRun | undefined {
  return getRunStore(projectId).get(runId);
}

export function updateTeamRun(
  runId: string,
  projectId: string | null,
  updates: Partial<Pick<TeamRun, 'status' | 'currentStageIndex' | 'stages' | 'pipeId' | 'workContext'>>,
): TeamRun | undefined {
  const run = getTeamRun(runId, projectId);
  if (!run) return undefined;
  Object.assign(run, { ...updates, updatedAt: new Date().toISOString() });
  return run;
}

export function listTeamRuns(
  teamId: string,
  projectId: string | null,
  opts?: { status?: TeamRunStatus },
): TeamRun[] {
  const runs = [...getRunStore(projectId).values()].filter(r => r.teamId === teamId);
  if (opts?.status) return runs.filter(r => r.status === opts.status);
  return runs;
}

/** Get the most recent non-cancelled/completed run for a team, if any. */
export function getActiveTeamRun(teamId: string, projectId: string | null): TeamRun | undefined {
  return [...getRunStore(projectId).values()]
    .filter(r => r.teamId === teamId && !['completed', 'cancelled', 'failed'].includes(r.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

// ── Proposals ─────────────────────────────────────────────────────────────────

export function createProposal(
  teamId: string,
  projectId: string | null,
  opts: {
    triggerMessage: string;
    playbook: PlaybookId;
    prompt: string;
    stages: TeamRunStage[];
  },
): TeamProposal {
  const now = new Date().toISOString();
  const proposal: TeamProposal = {
    id: randomUUID(),
    teamId,
    projectId,
    triggerMessage: opts.triggerMessage,
    playbook: opts.playbook,
    prompt: opts.prompt,
    stages: opts.stages,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  getProposalStore(projectId).set(proposal.id, proposal);
  return proposal;
}

export function getProposal(proposalId: string, projectId: string | null): TeamProposal | undefined {
  return getProposalStore(projectId).get(proposalId);
}

export function updateProposalStatus(
  proposalId: string,
  projectId: string | null,
  status: ProposalStatus,
): TeamProposal | undefined {
  const proposal = getProposal(proposalId, projectId);
  if (!proposal) return undefined;
  proposal.status = status;
  proposal.updatedAt = new Date().toISOString();
  return proposal;
}

export function listProposals(
  teamId: string,
  projectId: string | null,
  opts?: { status?: ProposalStatus },
): TeamProposal[] {
  const proposals = [...getProposalStore(projectId).values()].filter(p => p.teamId === teamId);
  if (opts?.status) return proposals.filter(p => p.status === opts.status);
  return proposals;
}

export function getPendingProposals(teamId: string, projectId: string | null): TeamProposal[] {
  return listProposals(teamId, projectId, { status: 'pending' });
}

// ── Reset (test only) ─────────────────────────────────────────────────────────

export function _resetForTest(): void {
  runsByProject.clear();
  proposalsByProject.clear();
}
