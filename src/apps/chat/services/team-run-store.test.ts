import { afterEach, describe, expect, it } from 'vitest';
import {
  createTeamRun,
  getTeamRun,
  updateTeamRun,
  listTeamRuns,
  getActiveTeamRun,
  createProposal,
  getProposal,
  updateProposalStatus,
  listProposals,
  getPendingProposals,
  _resetForTest,
} from './team-run-store.js';

const PROJECT_ID = 'test-project';
const TEAM_ID = 'test-team';

const SAMPLE_STAGES = [
  { index: 0, roleSlug: 'tech-lead', assignee: 'claude-1', description: 'Plan', pipeId: null, status: 'pending' as const },
  { index: 1, roleSlug: 'implementer', assignee: 'claude-2', description: 'Implement', pipeId: null, status: 'pending' as const },
];

afterEach(() => {
  _resetForTest();
});

describe('createTeamRun', () => {
  it('creates a run with required fields', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, {
      playbook: 'change-request',
      prompt: 'add dark mode',
      stages: SAMPLE_STAGES,
    });
    expect(run.id).toBeTruthy();
    expect(run.teamId).toBe(TEAM_ID);
    expect(run.projectId).toBe(PROJECT_ID);
    expect(run.playbook).toBe('change-request');
    expect(run.prompt).toBe('add dark mode');
    expect(run.status).toBe('pending');
    expect(run.currentStageIndex).toBe(0);
    expect(run.pipeId).toBeNull();
  });

  it('stores workContext from opts', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, {
      playbook: 'bug-fix',
      prompt: 'fix crash',
      stages: SAMPLE_STAGES,
      workContext: { prompt: 'fix crash', severity: 'high' },
    });
    expect(run.workContext).toMatchObject({ prompt: 'fix crash', severity: 'high' });
  });

  it('defaults workContext to { prompt } when not provided', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, {
      playbook: 'bug-fix',
      prompt: 'fix crash',
      stages: SAMPLE_STAGES,
    });
    expect(run.workContext).toEqual({ prompt: 'fix crash' });
  });
});

describe('getTeamRun', () => {
  it('returns the run by id', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES });
    expect(getTeamRun(run.id, PROJECT_ID)).toMatchObject({ id: run.id });
  });

  it('returns undefined for unknown id', () => {
    expect(getTeamRun('unknown', PROJECT_ID)).toBeUndefined();
  });
});

describe('updateTeamRun', () => {
  it('updates status and pipeId', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES });
    const updated = updateTeamRun(run.id, PROJECT_ID, { status: 'running', pipeId: 'pipe-abc' });
    expect(updated?.status).toBe('running');
    expect(updated?.pipeId).toBe('pipe-abc');
  });

  it('returns undefined for unknown id', () => {
    expect(updateTeamRun('nope', PROJECT_ID, { status: 'cancelled' })).toBeUndefined();
  });
});

describe('listTeamRuns', () => {
  it('returns runs for the team', () => {
    createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'bug-fix', prompt: 'a', stages: SAMPLE_STAGES });
    createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'change-request', prompt: 'b', stages: SAMPLE_STAGES });
    expect(listTeamRuns(TEAM_ID, PROJECT_ID)).toHaveLength(2);
  });

  it('filters by status', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES });
    updateTeamRun(run.id, PROJECT_ID, { status: 'running' });
    const running = listTeamRuns(TEAM_ID, PROJECT_ID, { status: 'running' });
    expect(running).toHaveLength(1);
    expect(listTeamRuns(TEAM_ID, PROJECT_ID, { status: 'completed' })).toHaveLength(0);
  });
});

describe('getActiveTeamRun', () => {
  it('returns a pending or running run', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES });
    expect(getActiveTeamRun(TEAM_ID, PROJECT_ID)?.id).toBe(run.id);
  });

  it('returns undefined when all runs are terminal', () => {
    const run = createTeamRun(TEAM_ID, PROJECT_ID, { playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES });
    updateTeamRun(run.id, PROJECT_ID, { status: 'completed' });
    expect(getActiveTeamRun(TEAM_ID, PROJECT_ID)).toBeUndefined();
  });

  it('returns undefined when no runs exist', () => {
    expect(getActiveTeamRun(TEAM_ID, PROJECT_ID)).toBeUndefined();
  });
});

describe('proposals', () => {
  it('creates a proposal with required fields', () => {
    const p = createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'add dark mode',
      playbook: 'change-request',
      prompt: 'add dark mode',
      stages: SAMPLE_STAGES,
    });
    expect(p.id).toBeTruthy();
    expect(p.status).toBe('pending');
    expect(p.playbook).toBe('change-request');
  });

  it('getProposal returns the proposal', () => {
    const p = createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'x', playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES,
    });
    expect(getProposal(p.id, PROJECT_ID)?.id).toBe(p.id);
  });

  it('updateProposalStatus transitions pending → approved', () => {
    const p = createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'x', playbook: 'bug-fix', prompt: 'x', stages: SAMPLE_STAGES,
    });
    const updated = updateProposalStatus(p.id, PROJECT_ID, 'approved');
    expect(updated?.status).toBe('approved');
  });

  it('getPendingProposals returns only pending', () => {
    const p1 = createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'a', playbook: 'bug-fix', prompt: 'a', stages: SAMPLE_STAGES,
    });
    const p2 = createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'b', playbook: 'change-request', prompt: 'b', stages: SAMPLE_STAGES,
    });
    updateProposalStatus(p1.id, PROJECT_ID, 'rejected');
    const pending = getPendingProposals(TEAM_ID, PROJECT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(p2.id);
  });

  it('listProposals returns all proposals for the team', () => {
    createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'a', playbook: 'bug-fix', prompt: 'a', stages: SAMPLE_STAGES,
    });
    createProposal(TEAM_ID, PROJECT_ID, {
      triggerMessage: 'b', playbook: 'change-request', prompt: 'b', stages: SAMPLE_STAGES,
    });
    expect(listProposals(TEAM_ID, PROJECT_ID)).toHaveLength(2);
  });
});
