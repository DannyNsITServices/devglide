import { describe, expect, it } from 'vitest';
import {
  classifyIntent,
  looksLikeImperative,
  shouldIntercept,
  formatProposalPreview,
} from './team-assist-router.js';
import type { ActiveTeam } from './team-store.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const activeTeam: ActiveTeam = {
  id: 'team-1', name: 'Alpha Team', projectId: 'proj',
  members: [], status: 'active', createdAt: NOW, updatedAt: NOW,
};

const pausedTeam: ActiveTeam = { ...activeTeam, status: 'paused' };

// ── classifyIntent ─────────────────────────────────────────────────────────

describe('classifyIntent', () => {
  it('classifies bug verbs as bug-fix', () => {
    expect(classifyIntent('fix the login crash')).toBe('bug-fix');
    expect(classifyIntent('debug the null pointer issue')).toBe('bug-fix');
    expect(classifyIntent('patch the memory leak')).toBe('bug-fix');
    expect(classifyIntent('revert the last deploy')).toBe('bug-fix');
  });

  it('classifies feature verbs as change-request', () => {
    expect(classifyIntent('implement dark mode')).toBe('change-request');
    expect(classifyIntent('add user authentication')).toBe('change-request');
    expect(classifyIntent('build the export feature')).toBe('change-request');
  });

  it('defaults to change-request for ambiguous text', () => {
    expect(classifyIntent('do something useful')).toBe('change-request');
    expect(classifyIntent('make it better')).toBe('change-request');
  });

  it('bug-fix takes precedence over change-request verbs when both present', () => {
    expect(classifyIntent('fix and implement the auth module')).toBe('bug-fix');
  });
});

// ── looksLikeImperative ────────────────────────────────────────────────────

describe('looksLikeImperative', () => {
  it('detects imperative sentences', () => {
    expect(looksLikeImperative('implement dark mode')).toBe(true);
    expect(looksLikeImperative('Fix the login bug')).toBe(true);
    expect(looksLikeImperative('add user profiles to the app')).toBe(true);
  });

  it('rejects questions', () => {
    expect(looksLikeImperative('can you implement dark mode?')).toBe(false);
    expect(looksLikeImperative('should we add authentication?')).toBe(false);
  });

  it('rejects slash commands', () => {
    expect(looksLikeImperative('/team run change-request')).toBe(false);
    expect(looksLikeImperative('/linear-pipe @a @b fix this')).toBe(false);
  });

  it('rejects messages with no imperative verbs', () => {
    expect(looksLikeImperative('the sky is blue')).toBe(false);
    expect(looksLikeImperative('status update from yesterday')).toBe(false);
  });
});

// ── shouldIntercept ────────────────────────────────────────────────────────

describe('shouldIntercept', () => {
  it('intercepts unaddressed user imperatives in assist mode', () => {
    expect(shouldIntercept({
      from: 'user', targetTokens: [], body: 'implement dark mode',
      team: activeTeam, assistModeEnabled: true,
    })).toBe(true);
  });

  it('does NOT intercept when assist mode is disabled', () => {
    expect(shouldIntercept({
      from: 'user', targetTokens: [], body: 'implement dark mode',
      team: activeTeam, assistModeEnabled: false,
    })).toBe(false);
  });

  it('does NOT intercept when message has targets', () => {
    expect(shouldIntercept({
      from: 'user', targetTokens: ['claude-1'], body: 'implement dark mode',
      team: activeTeam, assistModeEnabled: true,
    })).toBe(false);
  });

  it('does NOT intercept when team is null', () => {
    expect(shouldIntercept({
      from: 'user', targetTokens: [], body: 'implement dark mode',
      team: null, assistModeEnabled: true,
    })).toBe(false);
  });

  it('does NOT intercept when team is paused', () => {
    expect(shouldIntercept({
      from: 'user', targetTokens: [], body: 'implement dark mode',
      team: pausedTeam, assistModeEnabled: true,
    })).toBe(false);
  });

  it('does NOT intercept LLM messages', () => {
    expect(shouldIntercept({
      from: 'claude-1', targetTokens: [], body: 'implement dark mode',
      team: activeTeam, assistModeEnabled: true,
    })).toBe(false);
  });

  it('does NOT intercept non-imperative messages', () => {
    expect(shouldIntercept({
      from: 'user', targetTokens: [], body: 'the sky is blue',
      team: activeTeam, assistModeEnabled: true,
    })).toBe(false);
  });
});

// ── formatProposalPreview ──────────────────────────────────────────────────

describe('formatProposalPreview', () => {
  it('includes team name, playbook, and stage list', () => {
    const text = formatProposalPreview(activeTeam, 'change-request', 'add dark mode', ['Stage A', 'Stage B']);
    expect(text).toContain('Alpha Team');
    expect(text).toContain('change-request');
    expect(text).toContain('add dark mode');
    expect(text).toContain('Stage A');
    expect(text).toContain('Stage B');
  });

  it('advertises /team proposal approve and reject commands', () => {
    const text = formatProposalPreview(activeTeam, 'bug-fix', 'fix crash', []);
    expect(text).toContain('/team proposal approve');
    expect(text).toContain('/team proposal reject');
  });
});
