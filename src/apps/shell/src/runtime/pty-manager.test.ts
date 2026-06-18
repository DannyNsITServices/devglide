import { describe, expect, it } from 'vitest';
import { spawnHelperCandidateDirs } from './pty-manager.js';

describe('spawnHelperCandidateDirs', () => {
  it('searches build/Release, build/Debug, then prebuilds/<platform>-<arch>', () => {
    const dirs = spawnHelperCandidateDirs('/np', 'darwin', 'arm64');
    // Regression: the helper ships under prebuilds/, not just build/Release — the dir must
    // be included so a prebuild install gets its spawn-helper repaired.
    expect(dirs).toEqual([
      '/np/build/Release',
      '/np/build/Debug',
      '/np/prebuilds/darwin-arm64',
    ].map((p) => p.replace(/\//g, require('path').sep)));
  });

  it('encodes platform-arch into the prebuilds dir', () => {
    const dirs = spawnHelperCandidateDirs('/np', 'darwin', 'x64');
    expect(dirs.some((d) => d.endsWith(`prebuilds${require('path').sep}darwin-x64`))).toBe(true);
  });
});
