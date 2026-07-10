import { describe, expect, it } from 'vitest';
import { getClaudeMdContent, injectSection, removeSection } from './claude-md-template.js';

// The template is one large template literal — a single unescaped backtick
// in the markdown body is a syntax error that breaks the whole CLI at import
// time. Importing the module at all is the core regression guard here.
describe('claude-md-template', () => {
  it('produces the managed section with begin/end markers', () => {
    const content = getClaudeMdContent();
    expect(content).toContain('<!-- DEVGLIDE:BEGIN');
    expect(content).toContain('<!-- DEVGLIDE:END');
  });

  it('documents whisper-cli PATH adoption', () => {
    expect(getClaudeMdContent()).toContain('brew install whisper-cpp');
  });

  it('inject then remove round-trips', () => {
    const existing = '# My instructions\n';
    const injected = injectSection(existing, getClaudeMdContent());
    expect(injected).toContain('DEVGLIDE:BEGIN');
    const removed = removeSection(injected);
    expect(removed).not.toContain('DEVGLIDE:BEGIN');
    expect(removed).toContain('# My instructions');
  });
});
