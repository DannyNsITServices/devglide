import { describe, expect, it } from 'vitest';
import { pickUnixShell, withDefaultPath } from './shell-config.js';

describe('pickUnixShell', () => {
  it('returns $SHELL when it exists', () => {
    const exists = (p: string) => p === '/opt/homebrew/bin/fish';
    expect(pickUnixShell(exists, '/opt/homebrew/bin/fish')).toBe('/opt/homebrew/bin/fish');
  });

  it('ignores $SHELL when the path does not exist', () => {
    const exists = (p: string) => p === '/bin/zsh';
    expect(pickUnixShell(exists, '/nonexistent/shell')).toBe('/bin/zsh');
  });

  it('falls back to an ABSOLUTE path (never a bare name) when $SHELL is unset', () => {
    // Regression: bare "bash" makes posix_spawnp fail when the child env has no PATH (macOS daemon/GUI launch).
    const exists = (p: string) => p === '/bin/zsh';
    const result = pickUnixShell(exists, undefined);
    expect(result.startsWith('/')).toBe(true);
    expect(result).toBe('/bin/zsh');
  });

  it('prefers zsh, then bash, then sh', () => {
    expect(pickUnixShell((p) => ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(p), undefined)).toBe('/bin/zsh');
    expect(pickUnixShell((p) => ['/bin/bash', '/bin/sh'].includes(p), undefined)).toBe('/bin/bash');
    expect(pickUnixShell((p) => p === '/bin/sh', undefined)).toBe('/bin/sh');
  });

  it('never returns a bare command even when nothing is found', () => {
    const result = pickUnixShell(() => false, undefined);
    expect(result.startsWith('/')).toBe(true);
  });
});

describe('withDefaultPath', () => {
  it('injects a sane PATH when the env has none', () => {
    const env = withDefaultPath({ TERM: 'xterm-256color' });
    expect(env.PATH).toBeTruthy();
    expect(env.PATH).toContain('/bin');
  });

  it('preserves an existing PATH', () => {
    const env = withDefaultPath({ PATH: '/custom/bin' });
    expect(env.PATH).toBe('/custom/bin');
  });
});
