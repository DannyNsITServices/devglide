import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, 'page.js'), 'utf8');

describe('shell page mount boot order', () => {
  it('wires the Add LLM button before awaiting xterm', () => {
    const mountStart = source.indexOf('export async function mount(container, ctx) {');
    const addLlmListener = source.indexOf("refs.launchAgentBtn?.addEventListener('click', () => toggleAgentDropdown(false));", mountStart);
    const ensureXterm = source.indexOf('await ensureXterm();', mountStart);

    expect(mountStart).toBeGreaterThanOrEqual(0);
    expect(addLlmListener).toBeGreaterThan(mountStart);
    expect(ensureXterm).toBeGreaterThan(addLlmListener);
  });
});
