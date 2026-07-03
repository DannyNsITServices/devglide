import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'page.css'), 'utf8');

describe('shell page.css terminal rendering', () => {
  it('does not clip the last terminal row on the alternate screen buffer', () => {
    // A clip-path inset on .alt-screen .xterm-screen hides the bottom row of
    // TUI apps (e.g. the Claude Code mode/status line). Regression guard for
    // the workaround that amputated one full row of content.
    const altScreenBlocks = css.match(/\.alt-screen[^{]*\{[^}]*\}/g) ?? [];
    for (const block of altScreenBlocks) {
      expect(block).not.toMatch(/clip-path/);
    }
  });
});
