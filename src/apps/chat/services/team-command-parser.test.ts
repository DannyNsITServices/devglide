import { describe, expect, it } from 'vitest';
import {
  isTeamCommand,
  parseTeamCommand,
  isTeamParseError,
} from './team-command-parser.js';

describe('isTeamCommand', () => {
  it('recognizes /team commands', () => {
    expect(isTeamCommand('/team status')).toBe(true);
    expect(isTeamCommand('/team create Alpha')).toBe(true);
    expect(isTeamCommand('/team')).toBe(true);
  });

  it('rejects non-team commands', () => {
    expect(isTeamCommand('/linear-pipe @a @b prompt')).toBe(false);
    expect(isTeamCommand('team status')).toBe(false);
    expect(isTeamCommand('/teamwork')).toBe(false);
    expect(isTeamCommand('')).toBe(false);
  });
});

describe('parseTeamCommand', () => {
  describe('error cases', () => {
    it('returns error for bare /team with no subcommand', () => {
      const r = parseTeamCommand('/team');
      expect(isTeamParseError(r)).toBe(true);
    });

    it('returns error for unknown subcommand', () => {
      const r = parseTeamCommand('/team frobnicate');
      expect(isTeamParseError(r)).toBe(true);
      if (isTeamParseError(r)) expect(r.error).toMatch(/Unknown.*frobnicate/i);
    });
  });

  describe('status', () => {
    it('parses /team status', () => {
      const r = parseTeamCommand('/team status');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r)) expect(r.sub).toBe('status');
    });
  });

  describe('roles', () => {
    it('parses /team roles', () => {
      const r = parseTeamCommand('/team roles');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r)) expect(r.sub).toBe('roles');
    });
  });

  describe('create', () => {
    it('parses /team create <name>', () => {
      const r = parseTeamCommand('/team create Alpha Team');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'create') {
        expect(r.name).toBe('Alpha Team');
        expect(r.mode).toBe('manual');
      }
    });

    it('parses /team create <name> --mode assist', () => {
      const r = parseTeamCommand('/team create Alpha --mode assist');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'create') {
        expect(r.name).toBe('Alpha');
        expect(r.mode).toBe('assist');
      }
    });

    it('returns error when name is missing', () => {
      const r = parseTeamCommand('/team create');
      expect(isTeamParseError(r)).toBe(true);
    });

    it('returns error for invalid --mode value', () => {
      const r = parseTeamCommand('/team create Alpha --mode turbo');
      expect(isTeamParseError(r)).toBe(true);
    });
  });

  describe('edit', () => {
    it('parses /team edit --name <new name>', () => {
      const r = parseTeamCommand('/team edit --name New Name');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'edit') {
        expect(r.name).toBe('New Name');
      }
    });

    it('parses /team edit --mode assist', () => {
      const r = parseTeamCommand('/team edit --mode assist');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'edit') {
        expect(r.mode).toBe('assist');
      }
    });

    it('parses /team edit --name X --mode manual', () => {
      const r = parseTeamCommand('/team edit --name X --mode manual');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'edit') {
        expect(r.name).toBe('X');
        expect(r.mode).toBe('manual');
      }
    });

    it('returns error when neither --name nor --mode supplied', () => {
      const r = parseTeamCommand('/team edit something');
      expect(isTeamParseError(r)).toBe(true);
    });
  });

  describe('proposal', () => {
    it('parses /team proposal approve <id>', () => {
      const r = parseTeamCommand('/team proposal approve abc-123');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'proposal') {
        expect(r.action).toBe('approve');
        expect(r.proposalId).toBe('abc-123');
      }
    });

    it('parses /team proposal reject <id>', () => {
      const r = parseTeamCommand('/team proposal reject abc-123');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'proposal') expect(r.action).toBe('reject');
    });

    it('parses /team proposal dismiss <id>', () => {
      const r = parseTeamCommand('/team proposal dismiss abc-123');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'proposal') expect(r.action).toBe('dismiss');
    });

    it('returns error for unknown action', () => {
      const r = parseTeamCommand('/team proposal yolo abc-123');
      expect(isTeamParseError(r)).toBe(true);
    });

    it('returns error when id is missing', () => {
      const r = parseTeamCommand('/team proposal approve');
      expect(isTeamParseError(r)).toBe(true);
    });
  });

  describe('add', () => {
    it('parses /team add <role> @<assignee>', () => {
      const r = parseTeamCommand('/team add implementer @claude-1');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'add') {
        expect(r.roleSlug).toBe('implementer');
        expect(r.assignee).toBe('claude-1');
      }
    });

    it('returns error when assignee lacks @', () => {
      const r = parseTeamCommand('/team add implementer claude-1');
      expect(isTeamParseError(r)).toBe(true);
    });

    it('returns error when role or assignee is missing', () => {
      const r = parseTeamCommand('/team add implementer');
      expect(isTeamParseError(r)).toBe(true);
    });
  });

  describe('remove', () => {
    it('parses /team remove @<assignee>', () => {
      const r = parseTeamCommand('/team remove @claude-1');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'remove') {
        expect(r.assignee).toBe('claude-1');
      }
    });

    it('returns error when @ is missing', () => {
      const r = parseTeamCommand('/team remove claude-1');
      expect(isTeamParseError(r)).toBe(true);
    });
  });

  describe('pause / resume / disband', () => {
    it('parses /team pause', () => {
      const r = parseTeamCommand('/team pause');
      if (!isTeamParseError(r)) expect(r.sub).toBe('pause');
    });

    it('parses /team resume', () => {
      const r = parseTeamCommand('/team resume');
      if (!isTeamParseError(r)) expect(r.sub).toBe('resume');
    });

    it('parses /team disband', () => {
      const r = parseTeamCommand('/team disband');
      if (!isTeamParseError(r)) expect(r.sub).toBe('disband');
    });
  });

  describe('run', () => {
    it('parses /team run change-request with a prompt', () => {
      const r = parseTeamCommand('/team run change-request : add dark mode');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'run') {
        expect(r.playbook).toBe('change-request');
        expect(r.prompt).toBe('add dark mode');
      }
    });

    it('parses /team run bug-fix without explicit colon separator', () => {
      const r = parseTeamCommand('/team run bug-fix fix the login crash');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'run') {
        expect(r.playbook).toBe('bug-fix');
        expect(r.prompt).toContain('fix the login crash');
      }
    });

    it('uses a default prompt when none supplied for named playbooks', () => {
      const r = parseTeamCommand('/team run change-request');
      expect(isTeamParseError(r)).toBe(false);
      if (!isTeamParseError(r) && r.sub === 'run') {
        expect(r.prompt).toBeTruthy();
      }
    });

    it('returns error for custom playbook without a prompt', () => {
      const r = parseTeamCommand('/team run custom');
      expect(isTeamParseError(r)).toBe(true);
    });

    it('returns error for unknown playbook', () => {
      const r = parseTeamCommand('/team run waterfall something');
      expect(isTeamParseError(r)).toBe(true);
      if (isTeamParseError(r)) expect(r.error).toMatch(/waterfall/);
    });

    it('returns error when playbook is omitted', () => {
      const r = parseTeamCommand('/team run');
      expect(isTeamParseError(r)).toBe(true);
    });
  });
});
