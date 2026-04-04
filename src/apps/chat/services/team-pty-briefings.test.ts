import { describe, expect, it } from 'vitest';
import {
  formatRoleBriefing,
  formatRemovalBriefing,
  formatDisbandBriefing,
  formatRunStartBriefing,
} from './team-pty-briefings.js';
import { getRole } from './team-roles.js';
import type { TeamRoleTemplate } from './team-roles.js';

// ── Shared constants ──────────────────────────────────────────────────────────

const TEAM_NAME = 'Alpha Team';

/** Pipe-instruction patterns that must NOT appear in informational briefings. */
const PIPE_ACTION_PATTERNS = [
  /pipe_submit/,
  /pipe_read_output/,
  /pipe_get_assignment/,
  /\bSubmit\b.*pipe/i,
  /#pipe-[a-z0-9]+/,           // pipe anchor
  /Do not use chat_send/i,
  /Submit once, then wait/i,
];

function assertNotActionable(text: string): void {
  for (const pattern of PIPE_ACTION_PATTERNS) {
    expect(
      pattern.test(text),
      `Briefing must not contain pipe action pattern: ${pattern}`,
    ).toBe(false);
  }
}

function assertInformational(text: string): void {
  // Must include one of the standard informational disclaimers
  const hasDisclaimer =
    /No action is required/i.test(text) ||
    /informational briefing/i.test(text) ||
    /informational notice/i.test(text);
  expect(hasDisclaimer, 'Briefing must include an informational disclaimer').toBe(true);
}

// ── formatRoleBriefing ────────────────────────────────────────────────────────

describe('formatRoleBriefing', () => {
  const implementerRole = getRole('implementer') as TeamRoleTemplate;
  const reviewerRole = getRole('reviewer') as TeamRoleTemplate;
  const techLeadRole = getRole('tech-lead') as TeamRoleTemplate;

  it('includes the team name', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    expect(text).toContain(TEAM_NAME);
  });

  it('includes the role display name', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    expect(text).toContain(implementerRole.displayName);
  });

  it('includes the role description', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    expect(text).toContain(implementerRole.description);
  });

  it('includes the role instructions', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    expect(text).toContain(implementerRole.instructions);
  });

  it('is marked informational — no action required', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    assertInformational(text);
  });

  it('contains no pipe action directives', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    assertNotActionable(text);
  });

  it('works for every built-in role', () => {
    for (const slug of ['tech-lead', 'implementer', 'reviewer', 'tester', 'kanban'] as const) {
      const role = getRole(slug) as TeamRoleTemplate;
      const text = formatRoleBriefing('agent', TEAM_NAME, role);
      expect(text).toContain(role.displayName);
      assertInformational(text);
      assertNotActionable(text);
    }
  });

  it('includes a [Team: <name>] header prefix', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, implementerRole);
    expect(text).toMatch(/^\[Team: Alpha Team\]/);
  });

  it('mentions "Role assigned" in the header', () => {
    const text = formatRoleBriefing('claude-1', TEAM_NAME, techLeadRole);
    expect(text).toContain('Role assigned');
  });

  it('reviewer briefing retains its self-review warning', () => {
    const text = formatRoleBriefing('claude-3', TEAM_NAME, reviewerRole);
    expect(text).toContain('must not review work you also authored');
  });
});

// ── formatRemovalBriefing ─────────────────────────────────────────────────────

describe('formatRemovalBriefing', () => {
  it('includes the team name', () => {
    const text = formatRemovalBriefing('claude-1', TEAM_NAME, 'Implementer');
    expect(text).toContain(TEAM_NAME);
  });

  it('includes the previous role display name', () => {
    const text = formatRemovalBriefing('claude-1', TEAM_NAME, 'Implementer');
    expect(text).toContain('Implementer');
  });

  it('communicates that the participant is no longer part of the team', () => {
    const text = formatRemovalBriefing('claude-1', TEAM_NAME, 'Reviewer');
    expect(text).toMatch(/no longer part of the active team/i);
  });

  it('is marked informational — no action required', () => {
    const text = formatRemovalBriefing('claude-1', TEAM_NAME, 'Implementer');
    assertInformational(text);
  });

  it('contains no pipe action directives', () => {
    const text = formatRemovalBriefing('claude-1', TEAM_NAME, 'Implementer');
    assertNotActionable(text);
  });

  it('includes a [Team: <name>] header prefix', () => {
    const text = formatRemovalBriefing('claude-1', TEAM_NAME, 'Tester');
    expect(text).toMatch(/^\[Team: Alpha Team\]/);
  });
});

// ── formatDisbandBriefing ─────────────────────────────────────────────────────

describe('formatDisbandBriefing', () => {
  it('includes the team name', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    expect(text).toContain(TEAM_NAME);
  });

  it('communicates that the team has been disbanded', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    expect(text).toMatch(/disbanded/i);
  });

  it('mentions that role assignments are now inactive', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    expect(text).toMatch(/role assignments are now inactive/i);
  });

  it('mentions that in-progress runs have been cancelled', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    expect(text).toMatch(/in-progress runs have been cancelled/i);
  });

  it('is marked informational — no action required', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    assertInformational(text);
  });

  it('contains no pipe action directives', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    assertNotActionable(text);
  });

  it('includes a [Team: <name>] header prefix', () => {
    const text = formatDisbandBriefing(TEAM_NAME);
    expect(text).toMatch(/^\[Team: Alpha Team\]/);
  });
});

// ── formatRunStartBriefing ────────────────────────────────────────────────────

describe('formatRunStartBriefing', () => {
  it('includes the team name', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'add dark mode', 'implementer', 1, 4);
    expect(text).toContain(TEAM_NAME);
  });

  it('includes the playbook name', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'add dark mode', 'implementer', 1, 4);
    expect(text).toContain('change-request');
  });

  it('includes the task prompt', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'bug-fix', 'fix login crash', 'reviewer', 2, 4);
    expect(text).toContain('fix login crash');
  });

  it('includes the participant role', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'add dark mode', 'tech-lead', 0, 5);
    expect(text).toContain('tech-lead');
  });

  it('shows 1-based stage number', () => {
    // stageIndex=0 → "Stage 1 of 4"
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'add dark mode', 'implementer', 0, 4);
    expect(text).toContain('Stage 1 of 4');
  });

  it('shows correct stage for mid-run participants', () => {
    // stageIndex=2 → "Stage 3 of 5"
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'add dark mode', 'reviewer', 2, 5);
    expect(text).toContain('Stage 3 of 5');
  });

  it('tells participant they will receive a pipe assignment — not act now', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'prompt', 'tester', 3, 4);
    expect(text).toMatch(/will receive a pipe assignment when it is your turn/i);
  });

  it('is marked informational — no action required yet', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'bug-fix', 'fix crash', 'reviewer', 1, 3);
    assertInformational(text);
  });

  it('contains no pipe action directives', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'bug-fix', 'fix crash', 'reviewer', 1, 3);
    assertNotActionable(text);
  });

  it('includes a [Team: <name>] header prefix', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'change-request', 'prompt', 'kanban', 4, 5);
    expect(text).toMatch(/^\[Team: Alpha Team\]/);
  });

  it('mentions "Run started" in the header', () => {
    const text = formatRunStartBriefing(TEAM_NAME, 'bug-fix', 'fix crash', 'tester', 3, 4);
    expect(text).toContain('Run started');
  });
});
