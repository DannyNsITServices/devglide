import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_ROOT = join(process.cwd(), '.tmp', 'devglide-chat-rules-tests');

vi.mock('../../../packages/paths.js', () => ({
  projectDataDir: (projectId: string, sub: string) => join(TEST_ROOT, projectId, sub),
}));

const {
  DEFAULT_RULES,
  deleteProjectRules,
  getDefaultRules,
  getEffectiveRules,
  hasProjectRules,
  saveProjectRules,
} = await import('./chat-rules.js');

const TEST_PROJECT_ID = 'chat-rules-test-project';
const TEST_CHAT_DIR = join(TEST_ROOT, TEST_PROJECT_ID, 'chat');
const TEST_RULES_PATH = join(TEST_CHAT_DIR, 'rules.md');

afterEach(() => {
  rmSync(TEST_CHAT_DIR, { recursive: true, force: true });
});

describe('chat-rules', () => {
  it('returns the hardcoded default rules when no project override exists', () => {
    expect(getDefaultRules()).toBe(DEFAULT_RULES);
    expect(getEffectiveRules(TEST_PROJECT_ID)).toBe(DEFAULT_RULES);
    expect(hasProjectRules(TEST_PROJECT_ID)).toBe(false);
    expect(DEFAULT_RULES).toContain('Default: discussion only.');
    expect(DEFAULT_RULES).toContain('Execution requires explicit assignment.');
    expect(DEFAULT_RULES).toContain('Pipes use `pipe_submit` only.');
    expect(DEFAULT_RULES).toContain('User-directed replies should start with `@user`.');
  });

  it('keeps Rule 12 aligned with the role-boundary contract', () => {
    expect(DEFAULT_RULES).toContain('12. **Stay in role scope.**');
    expect(DEFAULT_RULES).toContain('An explicit assignment does not override role boundaries.');
    expect(DEFAULT_RULES).toContain('If the requested work is outside your role, do not execute it.');
    expect(DEFAULT_RULES).toContain('If a task mixes in-scope and off-scope work, do only the in-scope part and call out the rest.');
    expect(DEFAULT_RULES).toContain('If the correct role is unavailable, escalate that mismatch to the user instead of silently taking over.');
  });

  it('saves and resolves a project-specific override', () => {
    const override = '## Project Rules\n\nOnly reply when asked.';

    saveProjectRules(TEST_PROJECT_ID, override);

    expect(hasProjectRules(TEST_PROJECT_ID)).toBe(true);
    expect(existsSync(TEST_RULES_PATH)).toBe(true);
    expect(readFileSync(TEST_RULES_PATH, 'utf8')).toBe(override);
    expect(getEffectiveRules(TEST_PROJECT_ID)).toBe(override);
  });

  it('deletes a project override and falls back to defaults', () => {
    saveProjectRules(TEST_PROJECT_ID, 'temporary override');

    expect(deleteProjectRules(TEST_PROJECT_ID)).toBe(true);
    expect(hasProjectRules(TEST_PROJECT_ID)).toBe(false);
    expect(getEffectiveRules(TEST_PROJECT_ID)).toBe(DEFAULT_RULES);
    expect(deleteProjectRules(TEST_PROJECT_ID)).toBe(false);
  });
});
