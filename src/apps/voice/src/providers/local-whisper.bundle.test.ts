import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// dist/mcp/voice.mjs must treat nodejs-whisper as an external runtime
// dependency. Bundling it inlines CJS modules that reference __dirname
// (ReferenceError in ESM scope) and rebases WHISPER_CPP_PATH onto
// dist/cpp/whisper.cpp, which does not exist — the local provider then
// fails with a misleading "install nodejs-whisper" error.
const repoRoot = resolve(__dirname, '../../../../..');
const bundlePath = join(repoRoot, 'dist', 'mcp', 'voice.mjs');

describe('voice MCP bundle', () => {
  it.skipIf(!existsSync(bundlePath))('does not inline nodejs-whisper', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).not.toContain('WHISPER_CPP_PATH');
    expect(bundle).not.toContain('nodejs-whisper/dist/constants.js');
  });

  it.skipIf(!existsSync(bundlePath))('can resolve nodejs-whisper from the bundle location', () => {
    const require_ = createRequire(bundlePath);
    expect(() => require_.resolve('nodejs-whisper/package.json')).not.toThrow();
  });
});
