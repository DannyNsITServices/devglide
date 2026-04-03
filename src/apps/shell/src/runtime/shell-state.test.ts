import { afterEach, describe, expect, it } from 'vitest';
import type { PaneInfo } from '../shell-types.js';
import {
  dashboardState,
  getAdjacentPaneIdWithinProject,
  getPaneInfo,
  isPaneOwnedByProject,
  listPanesForProject,
} from './shell-state.js';

function pane(id: string, projectId: string | null, shellType = 'default'): PaneInfo {
  return {
    id,
    shellType,
    title: id,
    num: 1,
    cwd: null,
    projectId,
  };
}

afterEach(() => {
  dashboardState.panes = [];
  dashboardState.activePaneId = null;
  dashboardState.activeTab = 'grid';
});

describe('shell-state ownership helpers', () => {
  it('looks up panes and filters them by project', () => {
    dashboardState.panes = [
      pane('pane-a1', 'project-a'),
      pane('pane-a2', 'project-a', 'browser'),
      pane('pane-b1', 'project-b'),
      pane('pane-none', null),
    ];

    expect(getPaneInfo('pane-a2')?.shellType).toBe('browser');
    expect(listPanesForProject('project-a').map((entry) => entry.id)).toEqual(['pane-a1', 'pane-a2']);
    expect(listPanesForProject(null).map((entry) => entry.id)).toEqual(['pane-none']);
  });

  it('enforces project ownership checks', () => {
    const ownedPane = pane('pane-a1', 'project-a');
    const foreignPane = pane('pane-b1', 'project-b');

    expect(isPaneOwnedByProject(ownedPane, 'project-a')).toBe(true);
    expect(isPaneOwnedByProject(foreignPane, 'project-a')).toBe(false);
    expect(isPaneOwnedByProject(undefined, 'project-a')).toBe(false);
  });

  it('picks same-project fallback panes without crossing project boundaries', () => {
    dashboardState.panes = [
      pane('pane-a1', 'project-a'),
      pane('pane-b1', 'project-b'),
      pane('pane-a2', 'project-a', 'browser'),
      pane('pane-a3', 'project-a'),
      pane('pane-b2', 'project-b', 'browser'),
    ];

    expect(getAdjacentPaneIdWithinProject('project-a', 'pane-a2')).toBe('pane-a1');
    expect(getAdjacentPaneIdWithinProject('project-a', 'pane-a1')).toBe('pane-a2');
    expect(getAdjacentPaneIdWithinProject('project-b', 'pane-b2')).toBe('pane-b1');
    expect(getAdjacentPaneIdWithinProject('project-b', 'pane-b1')).toBe('pane-b2');
  });

  it('returns null when there is no same-project fallback', () => {
    dashboardState.panes = [
      pane('pane-a1', 'project-a'),
      pane('pane-b1', 'project-b'),
    ];

    expect(getAdjacentPaneIdWithinProject('project-a', 'pane-a1')).toBe(null);
    expect(getAdjacentPaneIdWithinProject('project-b', 'pane-b1')).toBe(null);
    expect(getAdjacentPaneIdWithinProject('project-c', 'missing')).toBe(null);
  });
});
