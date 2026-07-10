import { describe, expect, it } from 'vitest';
import { buildToolsHint } from './local-whisper.js';

// The provisioning-failure hint must describe what actually happened on the
// current platform. Prebuilt binaries only exist for Windows — claiming a
// download was attempted on macOS/Linux sends users down the wrong path.
describe('buildToolsHint', () => {
  it('darwin: explains source build failed, never claims a prebuilt download', () => {
    const hint = buildToolsHint('darwin');
    expect(hint).not.toContain('Prebuilt binary download');
    expect(hint).toContain('from source');
    expect(hint).toContain('brew install cmake');
    expect(hint).not.toContain('winget');
  });

  it('darwin: offers brew whisper-cpp as the no-compile path', () => {
    const hint = buildToolsHint('darwin');
    expect(hint).toContain('brew install whisper-cpp');
  });

  it('win32: mentions the prebuilt download attempt and Windows build tools', () => {
    const hint = buildToolsHint('win32');
    expect(hint).toContain('Prebuilt binary download');
    expect(hint).toContain('winget install Kitware.CMake');
    expect(hint).not.toContain('brew install');
  });

  it('linux: explains source build failed with apt instructions', () => {
    const hint = buildToolsHint('linux');
    expect(hint).not.toContain('Prebuilt binary download');
    expect(hint).toContain('build-essential');
  });

  it('always includes the manual compile steps', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const hint = buildToolsHint(platform);
      expect(hint).toContain('cd node_modules/nodejs-whisper/cpp/whisper.cpp');
      expect(hint).toContain('cmake -B build');
      expect(hint).toContain('cmake --build build --config Release');
    }
  });
});
