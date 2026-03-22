import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

vi.mock('../../../packages/paths.js', () => ({
  projectDataDir: (projectId: string, sub: string) => `/tmp/devglide-chat-rules-tests/${projectId}/${sub}`,
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
const TEST_CHAT_DIR = join('/tmp/devglide-chat-rules-tests', TEST_PROJECT_ID, 'chat');
const TEST_RULES_PATH = join(TEST_CHAT_DIR, 'rules.md');

afterEach(() => {
  rmSync(TEST_CHAT_DIR, { recursive: true, force: true });
});

describe('chat-rules', () => {
  it('returns the hardcoded default rules when no project override exists', () => {
    expect(getDefaultRules()).toBe(DEFAULT_RULES);
    expect(getEffectiveRules(TEST_PROJECT_ID)).toBe(DEFAULT_RULES);
    expect(hasProjectRules(TEST_PROJECT_ID)).toBe(false);
    expect(DEFAULT_RULES).toContain('server assigned you as the default responder');
    expect(DEFAULT_RULES).toContain('Trust assignment state over chat negotiation');
    expect(DEFAULT_RULES).toContain('that same LLM must not also review it');
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
