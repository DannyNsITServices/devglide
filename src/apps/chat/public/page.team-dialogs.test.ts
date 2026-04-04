import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, 'page.js'), 'utf8');

describe('chat team dialog source contracts', () => {
  it('uses a dedicated roles dialog trigger instead of an inline roles list', () => {
    expect(source).toContain('id="chat-team-roles-trigger"');
    expect(source).toContain('id="chat-team-roles-overlay"');
    expect(source).toContain('id="chat-team-roles-modal-list"');
    expect(source).not.toContain('id="chat-team-roles-list"');
  });

  it('routes team disband through a dedicated dialog entry point', () => {
    expect(source).toContain('id="chat-team-disband-overlay"');
    expect(source).toContain("function openTeamDisbandDialog()");
    expect(source).toContain("_container.querySelector('#chat-team-disband')?.addEventListener('click', openTeamDisbandDialog);");
  });

  it('supports keyboard dismissal for team dialogs', () => {
    expect(source).toContain('function onTeamDialogKeyDown(event)');
    expect(source).toContain("if (event.key === 'Escape')");
    expect(source).toContain("overlay?.addEventListener('keydown', onTeamDialogKeyDown);");
  });
});
