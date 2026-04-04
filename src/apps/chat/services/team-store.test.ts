import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';

const TEST_ROOT = join(process.cwd(), '.tmp', 'devglide-team-store-tests');
const TEST_PROJECT_ID = 'team-store-test-project';

vi.mock('../../../packages/paths.js', () => ({
  projectDataDir: (projectId: string, sub: string) => join(TEST_ROOT, projectId, sub),
}));

vi.mock('../../../project-context.js', () => ({
  getActiveProject: () => ({ id: TEST_PROJECT_ID }),
  onProjectChange: () => () => {},
}));

const {
  getTeam,
  getActiveTeam,
  createTeam,
  updateTeam,
  disbandTeam,
  assignMember,
  removeMember,
  getParticipantTeamContext,
} = await import('./team-store.js');

const TEST_CHAT_DIR = join(TEST_ROOT, TEST_PROJECT_ID, 'chat');

afterEach(() => {
  rmSync(TEST_CHAT_DIR, { recursive: true, force: true });
});

describe('team-store', () => {
  describe('getTeam / getActiveTeam', () => {
    it('returns null when no team file exists', () => {
      expect(getTeam(TEST_PROJECT_ID)).toBeNull();
      expect(getActiveTeam(TEST_PROJECT_ID)).toBeNull();
    });
  });

  describe('createTeam', () => {
    it('creates a team with required fields', () => {
      const team = createTeam(TEST_PROJECT_ID, { name: 'Alpha Team' });
      expect(team.id).toBeTruthy();
      expect(team.name).toBe('Alpha Team');
      expect(team.projectId).toBe(TEST_PROJECT_ID);
      expect(team.status).toBe('active');
      expect(team.members).toEqual([]);
      expect(team.createdAt).toBeTruthy();
      expect(team.updatedAt).toBe(team.createdAt);
    });

    it('persists the team so getTeam returns it', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Persisted Team' });
      const loaded = getTeam(TEST_PROJECT_ID);
      expect(loaded?.name).toBe('Persisted Team');
    });

    it('throws if a non-disbanded team already exists', () => {
      createTeam(TEST_PROJECT_ID, { name: 'First' });
      expect(() => createTeam(TEST_PROJECT_ID, { name: 'Second' })).toThrow(
        /already active/,
      );
    });

    it('allows creating after the previous team is disbanded', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Old' });
      disbandTeam(TEST_PROJECT_ID);
      const newTeam = createTeam(TEST_PROJECT_ID, { name: 'New' });
      expect(newTeam.name).toBe('New');
      expect(newTeam.status).toBe('active');
    });

    it('creates a team with initial members', () => {
      const now = new Date().toISOString();
      const team = createTeam(TEST_PROJECT_ID, {
        name: 'Full Team',
        members: [{ participantName: 'claude-1', roleSlug: 'implementer', assignedAt: now }],
      });
      expect(team.members).toHaveLength(1);
      expect(team.members[0].participantName).toBe('claude-1');
      expect(team.members[0].roleSlug).toBe('implementer');
    });
  });

  describe('updateTeam', () => {
    it('updates the team name', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Old Name' });
      const updated = updateTeam(TEST_PROJECT_ID, { name: 'New Name' });
      expect(updated.name).toBe('New Name');
      expect(getTeam(TEST_PROJECT_ID)!.name).toBe('New Name');
    });

    it('pauses and resumes a team via status field', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      const paused = updateTeam(TEST_PROJECT_ID, { status: 'paused' });
      expect(paused.status).toBe('paused');
      expect(getTeam(TEST_PROJECT_ID)!.status).toBe('paused');

      const resumed = updateTeam(TEST_PROJECT_ID, { status: 'active' });
      expect(resumed.status).toBe('active');
    });

    it('throws if no team exists', () => {
      expect(() => updateTeam(TEST_PROJECT_ID, { name: 'X' })).toThrow(/No team found/);
    });

    it('throws if team is disbanded', () => {
      createTeam(TEST_PROJECT_ID, { name: 'X' });
      disbandTeam(TEST_PROJECT_ID);
      expect(() => updateTeam(TEST_PROJECT_ID, { name: 'Y' })).toThrow(/disbanded/);
    });

    it('bumps updatedAt after update', () => {
      const created = createTeam(TEST_PROJECT_ID, { name: 'Team' });
      // ensure clock advances
      const updated = updateTeam(TEST_PROJECT_ID, { name: 'Updated' });
      expect(updated.updatedAt >= created.updatedAt).toBe(true);
    });
  });

  describe('disbandTeam', () => {
    it('marks the team as disbanded', () => {
      createTeam(TEST_PROJECT_ID, { name: 'X' });
      const disbanded = disbandTeam(TEST_PROJECT_ID);
      expect(disbanded.status).toBe('disbanded');
      // getTeam still returns it
      expect(getTeam(TEST_PROJECT_ID)?.status).toBe('disbanded');
      // getActiveTeam returns null
      expect(getActiveTeam(TEST_PROJECT_ID)).toBeNull();
    });

    it('throws if no team exists', () => {
      expect(() => disbandTeam(TEST_PROJECT_ID)).toThrow(/No team found/);
    });

    it('throws if already disbanded', () => {
      createTeam(TEST_PROJECT_ID, { name: 'X' });
      disbandTeam(TEST_PROJECT_ID);
      expect(() => disbandTeam(TEST_PROJECT_ID)).toThrow(/already disbanded/);
    });
  });

  describe('assignMember', () => {
    it('assigns a participant to a role', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      const team = assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer');
      expect(team.members).toHaveLength(1);
      expect(team.members[0]).toMatchObject({ participantName: 'claude-1', roleSlug: 'implementer' });
    });

    it('replaces an existing role for the same participant', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer');
      const updated = assignMember(TEST_PROJECT_ID, 'claude-1', 'reviewer');
      expect(updated.members).toHaveLength(1);
      expect(updated.members[0].roleSlug).toBe('reviewer');
    });

    it('allows multiple participants with different roles', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer');
      const team = assignMember(TEST_PROJECT_ID, 'codex-1', 'reviewer');
      expect(team.members).toHaveLength(2);
    });

    it('throws for an invalid role slug', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      expect(() => assignMember(TEST_PROJECT_ID, 'claude-1', 'cto')).toThrow(
        /not a valid role slug/,
      );
    });

    it('throws if no active team', () => {
      expect(() => assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer')).toThrow(
        /No active team/,
      );
    });
  });

  describe('removeMember', () => {
    it('removes a participant from the team', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer');
      const team = removeMember(TEST_PROJECT_ID, 'claude-1');
      expect(team.members).toHaveLength(0);
    });

    it('no-ops when participant was not assigned', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      const team = removeMember(TEST_PROJECT_ID, 'nobody');
      expect(team.members).toHaveLength(0);
    });

    it('throws if no active team', () => {
      expect(() => removeMember(TEST_PROJECT_ID, 'claude-1')).toThrow(/No active team/);
    });
  });

  describe('getParticipantTeamContext', () => {
    it('returns null when no team exists', () => {
      expect(getParticipantTeamContext(TEST_PROJECT_ID, 'claude-1')).toBeNull();
    });

    it('returns null when participant has no role', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      expect(getParticipantTeamContext(TEST_PROJECT_ID, 'claude-1')).toBeNull();
    });

    it('returns role context for an assigned participant', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer');
      const ctx = getParticipantTeamContext(TEST_PROJECT_ID, 'claude-1');
      expect(ctx).not.toBeNull();
      expect(ctx!.roleSlug).toBe('implementer');
      expect(ctx!.roleDisplayName).toBe('Implementer');
      expect(ctx!.teamName).toBe('Team');
      expect(ctx!.roleBriefing).toContain('Implementer');
    });

    it('returns null for disbanded team', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      assignMember(TEST_PROJECT_ID, 'claude-1', 'implementer');
      disbandTeam(TEST_PROJECT_ID);
      expect(getParticipantTeamContext(TEST_PROJECT_ID, 'claude-1')).toBeNull();
    });

    it('returns null when participantName is null', () => {
      createTeam(TEST_PROJECT_ID, { name: 'Team' });
      expect(getParticipantTeamContext(TEST_PROJECT_ID, null)).toBeNull();
    });
  });
});
