import { describe, expect, it } from 'vitest';
import {
  getVisibleFallbackPaneId,
  isPaneIdVisible,
  isPaneVisibleForProject,
  listVisiblePaneIds,
} from './pane-visibility.js';

function makePanes(entries: Array<[string, string | null]>) {
  return new Map(entries.map(([id, projectId]) => [id, { _projectId: projectId }]));
}

describe('pane visibility helpers', () => {
  it('treats same-project and unscoped panes as visible', () => {
    expect(isPaneVisibleForProject('project-a', 'project-a')).toBe(true);
    expect(isPaneVisibleForProject(null, 'project-a')).toBe(true);
    expect(isPaneVisibleForProject('project-b', 'project-a')).toBe(false);
  });

  it('lists only panes visible to the active project', () => {
    const panes = makePanes([
      ['pane-a1', 'project-a'],
      ['pane-b1', 'project-b'],
      ['pane-none', null],
      ['pane-a2', 'project-a'],
    ]);

    expect(listVisiblePaneIds(panes, 'project-a')).toEqual(['pane-a1', 'pane-none', 'pane-a2']);
    expect(listVisiblePaneIds(panes, 'project-b')).toEqual(['pane-b1', 'pane-none']);
  });

  it('rejects hidden panes as active-pane candidates', () => {
    const panes = makePanes([
      ['pane-a1', 'project-a'],
      ['pane-b1', 'project-b'],
    ]);

    expect(isPaneIdVisible(panes, 'project-a', 'pane-a1')).toBe(true);
    expect(isPaneIdVisible(panes, 'project-a', 'pane-b1')).toBe(false);
    expect(isPaneIdVisible(panes, 'project-a', null)).toBe(false);
  });

  it('chooses fallback panes from the visible subset only', () => {
    const panes = makePanes([
      ['pane-a1', 'project-a'],
      ['pane-b1', 'project-b'],
      ['pane-a2', 'project-a'],
      ['pane-none', null],
      ['pane-a3', 'project-a'],
    ]);

    expect(getVisibleFallbackPaneId(panes, 'project-a', 'pane-a2')).toBe('pane-a1');
    expect(getVisibleFallbackPaneId(panes, 'project-a', 'pane-a1')).toBe('pane-a2');
    expect(getVisibleFallbackPaneId(panes, 'project-a', 'pane-b1')).toBe('pane-a1');
    expect(getVisibleFallbackPaneId(panes, 'project-c', 'missing')).toBe('pane-none');
  });

  it('returns null when no visible pane remains', () => {
    const panes = makePanes([
      ['pane-a1', 'project-a'],
      ['pane-b1', 'project-b'],
    ]);

    expect(getVisibleFallbackPaneId(panes, 'project-c', 'missing')).toBe(null);
  });
});
