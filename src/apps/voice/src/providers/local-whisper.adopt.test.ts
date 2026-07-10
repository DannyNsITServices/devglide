import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptSystemWhisperCli } from './local-whisper.js';

// A whisper-cli installed on PATH (e.g. `brew install whisper-cpp`) can be
// adopted by copying it into the location nodejs-whisper expects, skipping
// the CMake source build entirely.
describe('adoptSystemWhisperCli', () => {
  const exeName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  let whisperCppDir: string;
  let fixtureDir: string;

  beforeEach(() => {
    whisperCppDir = mkdtempSync(join(tmpdir(), 'devglide-whisper-cpp-'));
    fixtureDir = mkdtempSync(join(tmpdir(), 'devglide-system-cli-'));
  });

  afterEach(() => {
    rmSync(whisperCppDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('copies a system binary into build/bin and reports success', () => {
    const systemCli = join(fixtureDir, exeName);
    writeFileSync(systemCli, 'fake-whisper-binary');

    const adopted = adoptSystemWhisperCli(whisperCppDir, () => systemCli);

    expect(adopted).toBe(true);
    const target = join(whisperCppDir, 'build', 'bin', exeName);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('fake-whisper-binary');
  });

  it('returns false when no system binary is found', () => {
    const adopted = adoptSystemWhisperCli(whisperCppDir, () => null);

    expect(adopted).toBe(false);
    expect(existsSync(join(whisperCppDir, 'build'))).toBe(false);
  });

  it('returns false when the copy fails', () => {
    const adopted = adoptSystemWhisperCli(
      whisperCppDir,
      () => join(fixtureDir, 'does-not-exist', exeName)
    );

    expect(adopted).toBe(false);
  });
});
