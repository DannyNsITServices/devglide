import { describe, expect, it } from 'vitest';
import { collectDoctorChecks, formatDoctorReport } from './doctor.js';

type Check = { name: string; ok: boolean; detail: string; hint: string | null };

function byName(checks: Check[], name: string): Check {
  const check = checks.find((c) => c.name === name);
  if (!check) throw new Error(`missing check: ${name}`);
  return check;
}

// The doctor reports whether the voice local-whisper provider can work:
// ffmpeg (always required), whisper-cli (built, on PATH, or auto-provisioned),
// and cmake (only needed when whisper-cli must be compiled from source).
describe('collectDoctorChecks', () => {
  it('reports all green when everything is available', () => {
    const checks = collectDoctorChecks({
      platform: 'darwin',
      probe: (cmd: string) =>
        cmd.startsWith('ffmpeg') ? 'ffmpeg version 7.1' :
        cmd.startsWith('cmake') ? 'cmake version 3.30' :
        '/opt/homebrew/bin/whisper-cli',
      builtInTree: () => false,
    });

    expect(checks.every((c) => c.ok)).toBe(true);
    expect(byName(checks, 'whisper-cli').detail).toContain('adopted automatically');
  });

  it('darwin with nothing installed: fails with brew hints', () => {
    const checks = collectDoctorChecks({
      platform: 'darwin',
      probe: () => null,
      builtInTree: () => false,
    });

    expect(byName(checks, 'ffmpeg').ok).toBe(false);
    expect(byName(checks, 'ffmpeg').hint).toContain('brew install ffmpeg');
    expect(byName(checks, 'whisper-cli').ok).toBe(false);
    expect(byName(checks, 'whisper-cli').hint).toContain('brew install whisper-cpp');
    expect(byName(checks, 'cmake').ok).toBe(false);
    expect(byName(checks, 'cmake').hint).toContain('brew install cmake');
  });

  it('win32 without whisper-cli: still ok — prebuilt is auto-downloaded', () => {
    const checks = collectDoctorChecks({
      platform: 'win32',
      probe: (cmd: string) => (cmd.startsWith('ffmpeg') ? 'ffmpeg version 7.1' : null),
      builtInTree: () => false,
    });

    expect(byName(checks, 'whisper-cli').ok).toBe(true);
    expect(byName(checks, 'whisper-cli').detail).toContain('auto-downloaded');
    expect(byName(checks, 'cmake').ok).toBe(true);
  });

  it('cmake is not required once whisper-cli is already built', () => {
    const checks = collectDoctorChecks({
      platform: 'linux',
      probe: (cmd: string) => (cmd.startsWith('ffmpeg') ? 'ffmpeg version 7.1' : null),
      builtInTree: () => true,
    });

    expect(byName(checks, 'whisper-cli').ok).toBe(true);
    expect(byName(checks, 'cmake').ok).toBe(true);
    expect(byName(checks, 'cmake').detail).toContain('not needed');
  });
});

describe('formatDoctorReport', () => {
  it('renders pass/fail marks and hints', () => {
    const report = formatDoctorReport([
      { name: 'ffmpeg', ok: true, detail: 'ffmpeg version 7.1', hint: null },
      { name: 'whisper-cli', ok: false, detail: 'not found', hint: 'brew install whisper-cpp' },
    ]);

    expect(report).toContain('✓ ffmpeg: ffmpeg version 7.1');
    expect(report).toContain('✗ whisper-cli: not found');
    expect(report).toContain('→ brew install whisper-cpp');
  });
});
