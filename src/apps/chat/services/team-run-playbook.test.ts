import { describe, expect, it } from 'vitest';
import {
  compilePlaybook,
  extractAssigneesFromStages,
  buildPipePrompt,
  getPlaybookTemplate,
  listPlaybooks,
} from './team-run-playbook.js';
import type { TeamMember } from './team-store.js';

const NOW = new Date().toISOString();

const FULL_MEMBERS: TeamMember[] = [
  { participantName: 'claude-1', roleSlug: 'tech-lead', assignedAt: NOW },
  { participantName: 'claude-2', roleSlug: 'implementer', assignedAt: NOW },
  { participantName: 'claude-3', roleSlug: 'reviewer', assignedAt: NOW },
  { participantName: 'claude-4', roleSlug: 'tester', assignedAt: NOW },
  { participantName: 'claude-5', roleSlug: 'kanban', assignedAt: NOW },
];

describe('compilePlaybook', () => {
  describe('change-request', () => {
    it('produces 5 ordered stages', () => {
      const stages = compilePlaybook('change-request', FULL_MEMBERS);
      expect(stages).toHaveLength(5);
      expect(stages.map(s => s.roleSlug)).toEqual([
        'tech-lead', 'implementer', 'reviewer', 'tester', 'kanban',
      ]);
    });

    it('assigns correct participants', () => {
      const stages = compilePlaybook('change-request', FULL_MEMBERS);
      expect(stages[0].assignee).toBe('claude-1');
      expect(stages[1].assignee).toBe('claude-2');
      expect(stages[4].assignee).toBe('claude-5');
    });

    it('uses 0-based indices', () => {
      const stages = compilePlaybook('change-request', FULL_MEMBERS);
      expect(stages[0].index).toBe(0);
      expect(stages[4].index).toBe(4);
    });

    it('sets all stages to pending', () => {
      const stages = compilePlaybook('change-request', FULL_MEMBERS);
      for (const s of stages) expect(s.status).toBe('pending');
    });

    it('sets pipeId to null for all stages', () => {
      const stages = compilePlaybook('change-request', FULL_MEMBERS);
      for (const s of stages) expect(s.pipeId).toBeNull();
    });
  });

  describe('bug-fix', () => {
    it('produces 4 ordered stages (no kanban)', () => {
      const stages = compilePlaybook('bug-fix', FULL_MEMBERS);
      expect(stages).toHaveLength(4);
      expect(stages.map(s => s.roleSlug)).toEqual([
        'tech-lead', 'implementer', 'reviewer', 'tester',
      ]);
    });
  });

  describe('missing members', () => {
    it('sets assignee to null when a role has no team member', () => {
      const members: TeamMember[] = [
        { participantName: 'claude-1', roleSlug: 'tech-lead', assignedAt: NOW },
        { participantName: 'claude-2', roleSlug: 'implementer', assignedAt: NOW },
        // reviewer, tester, kanban are missing
      ];
      const stages = compilePlaybook('change-request', members);
      expect(stages[2].assignee).toBeNull(); // reviewer
      expect(stages[3].assignee).toBeNull(); // tester
      expect(stages[4].assignee).toBeNull(); // kanban
    });
  });
});

describe('extractAssigneesFromStages', () => {
  it('returns only stages with non-null assignees', () => {
    const stages = compilePlaybook('change-request', FULL_MEMBERS);
    expect(extractAssigneesFromStages(stages)).toEqual([
      'claude-1', 'claude-2', 'claude-3', 'claude-4', 'claude-5',
    ]);
  });

  it('skips null-assignee stages', () => {
    const stages = compilePlaybook('change-request', [
      { participantName: 'claude-1', roleSlug: 'tech-lead', assignedAt: NOW },
      { participantName: 'claude-2', roleSlug: 'implementer', assignedAt: NOW },
    ]);
    expect(extractAssigneesFromStages(stages)).toEqual(['claude-1', 'claude-2']);
  });
});

describe('buildPipePrompt', () => {
  it('includes stage descriptions and the user prompt', () => {
    const stages = compilePlaybook('change-request', FULL_MEMBERS);
    const result = buildPipePrompt(stages, 'add dark mode');
    expect(result).toContain('add dark mode');
    expect(result).toContain('@claude-1');
    expect(result).toContain('Stage 1');
  });
});

describe('getPlaybookTemplate', () => {
  it('returns templates for built-in playbooks', () => {
    expect(getPlaybookTemplate('change-request')).toHaveLength(5);
    expect(getPlaybookTemplate('bug-fix')).toHaveLength(4);
  });

  it('returns null for custom', () => {
    expect(getPlaybookTemplate('custom')).toBeNull();
  });
});

describe('listPlaybooks', () => {
  it('lists change-request and bug-fix', () => {
    const list = listPlaybooks();
    expect(list).toContain('change-request');
    expect(list).toContain('bug-fix');
    expect(list).not.toContain('custom');
  });
});
