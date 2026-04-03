import { describe, expect, it } from 'vitest';
import { DEFAULT_VISIBLE_TERMINAL, getMobilePipeFabState, getVisiblePipeSummaries, sortPipeSummaries } from './pipe-visibility.js';

function pipe(pipeId, status, createdAt) {
  return {
    pipeId,
    status,
    createdAt,
    slotSummary: { total: 1, submitted: 0, leased: 0, pending: 1 },
  };
}

describe('sortPipeSummaries', () => {
  it('keeps running pipes first, then terminal pipes by recency', () => {
    const pipes = [
      pipe('completed-old', 'completed', '2026-04-02T10:00:00.000Z'),
      pipe('running-old', 'running', '2026-04-02T09:00:00.000Z'),
      pipe('failed-new', 'failed', '2026-04-02T12:00:00.000Z'),
      pipe('running-new', 'running', '2026-04-02T13:00:00.000Z'),
      pipe('cancelled-new', 'cancelled', '2026-04-02T11:00:00.000Z'),
    ];

    expect(sortPipeSummaries(pipes).map(entry => entry.pipeId)).toEqual([
      'running-new',
      'running-old',
      'failed-new',
      'cancelled-new',
      'completed-old',
    ]);
  });
});

describe('getVisiblePipeSummaries', () => {
  it('caps terminal pipes while keeping all running pipes visible', () => {
    const pipes = [
      pipe('running-a', 'running', '2026-04-02T15:00:00.000Z'),
      pipe('running-b', 'running', '2026-04-02T14:00:00.000Z'),
      pipe('completed-a', 'completed', '2026-04-02T13:00:00.000Z'),
      pipe('completed-b', 'completed', '2026-04-02T12:00:00.000Z'),
      pipe('failed-a', 'failed', '2026-04-02T11:00:00.000Z'),
    ];

    const result = getVisiblePipeSummaries(pipes, { terminalLimit: 2 });
    expect(result.visiblePipes.map(entry => entry.pipeId)).toEqual([
      'running-a',
      'running-b',
      'failed-a',
      'completed-a',
    ]);
    expect(result.hiddenTerminalCount).toBe(1);
    expect(result.canToggleTerminalHistory).toBe(true);
  });

  it('preserves an expanded terminal pipe outside the default cap', () => {
    const pipes = [
      pipe('completed-1', 'completed', '2026-04-02T15:00:00.000Z'),
      pipe('completed-2', 'completed', '2026-04-02T14:00:00.000Z'),
      pipe('completed-3', 'completed', '2026-04-02T13:00:00.000Z'),
    ];

    const result = getVisiblePipeSummaries(pipes, {
      expandedPipeId: 'completed-3',
      terminalLimit: 2,
    });

    expect(result.visiblePipes.map(entry => entry.pipeId)).toEqual([
      'completed-1',
      'completed-2',
      'completed-3',
    ]);
    expect(result.hiddenTerminalCount).toBe(0);
  });

  it('shows all terminal pipes when history is expanded', () => {
    const pipes = [
      pipe('completed-1', 'completed', '2026-04-02T15:00:00.000Z'),
      pipe('completed-2', 'completed', '2026-04-02T14:00:00.000Z'),
      pipe('completed-3', 'completed', '2026-04-02T13:00:00.000Z'),
    ];

    const result = getVisiblePipeSummaries(pipes, {
      showAll: true,
      terminalLimit: 1,
    });

    expect(result.visiblePipes.map(entry => entry.pipeId)).toEqual([
      'completed-1',
      'completed-2',
      'completed-3',
    ]);
    expect(result.hiddenTerminalCount).toBe(0);
  });

  it('uses the default terminal cap when none is supplied', () => {
    const pipes = Array.from({ length: DEFAULT_VISIBLE_TERMINAL + 2 }, (_, index) =>
      pipe(`completed-${index + 1}`, 'completed', `2026-04-02T${String(20 - index).padStart(2, '0')}:00:00.000Z`),
    );

    const result = getVisiblePipeSummaries(pipes);
    expect(result.visiblePipes).toHaveLength(DEFAULT_VISIBLE_TERMINAL);
    expect(result.hiddenTerminalCount).toBe(2);
  });
});

// ── Mobile FAB state ────────────────────────────────────────────────

describe('getMobilePipeFabState', () => {
  it('counts running pipes for the FAB badge', () => {
    const pipes = [
      pipe('r1', 'running', '2026-04-02T10:00:00.000Z'),
      pipe('r2', 'running', '2026-04-02T11:00:00.000Z'),
      pipe('c1', 'completed', '2026-04-02T09:00:00.000Z'),
    ];
    const state = getMobilePipeFabState(pipes, []);
    expect(state.runningCount).toBe(2);
    expect(state.hasRunning).toBe(true);
    expect(state.deadLetterCount).toBe(0);
    expect(state.hasAlert).toBe(false);
  });

  it('counts dead letters for the alert badge', () => {
    const pipes = [pipe('c1', 'completed', '2026-04-02T10:00:00.000Z')];
    const deadLetters = [
      { pipeId: 'c1', assignee: 'alice', reason: 'timeout' },
      { pipeId: 'c1', assignee: 'bob', reason: 'timeout' },
    ];
    const state = getMobilePipeFabState(pipes, deadLetters);
    expect(state.runningCount).toBe(0);
    expect(state.hasRunning).toBe(false);
    expect(state.deadLetterCount).toBe(2);
    expect(state.hasAlert).toBe(true);
  });

  it('returns zeros when no pipes exist', () => {
    const state = getMobilePipeFabState([], []);
    expect(state.runningCount).toBe(0);
    expect(state.deadLetterCount).toBe(0);
    expect(state.hasRunning).toBe(false);
    expect(state.hasAlert).toBe(false);
  });

  it('reflects both running and alert simultaneously', () => {
    const pipes = [pipe('r1', 'running', '2026-04-02T10:00:00.000Z')];
    const deadLetters = [{ pipeId: 'x', assignee: 'a', reason: 'timeout' }];
    const state = getMobilePipeFabState(pipes, deadLetters);
    expect(state.hasRunning).toBe(true);
    expect(state.hasAlert).toBe(true);
  });
});

// ── Mobile drawer data independence ─────────────────────────────────

describe('mobile drawer data independence from desktop collapse', () => {
  it('getVisiblePipeSummaries returns the same data regardless of any external UI collapse state', () => {
    const pipes = [
      pipe('r1', 'running', '2026-04-02T15:00:00.000Z'),
      pipe('c1', 'completed', '2026-04-02T14:00:00.000Z'),
      pipe('c2', 'completed', '2026-04-02T13:00:00.000Z'),
    ];

    // The same call that the drawer uses — no collapse flag exists in the data layer
    const result = getVisiblePipeSummaries(pipes, { terminalLimit: 10 });
    expect(result.visiblePipes).toHaveLength(3);
    expect(result.totalCount).toBe(3);

    // Calling again with identical params yields identical results
    const result2 = getVisiblePipeSummaries(pipes, { terminalLimit: 10 });
    expect(result2.visiblePipes).toEqual(result.visiblePipes);
  });

  it('getMobilePipeFabState is independent of pipe visibility options', () => {
    const pipes = [
      pipe('r1', 'running', '2026-04-02T15:00:00.000Z'),
      pipe('f1', 'failed', '2026-04-02T14:00:00.000Z'),
    ];
    const deadLetters = [{ pipeId: 'f1', assignee: 'a', reason: 'timeout' }];

    // FAB state only depends on raw pipe summaries and dead letters
    const state = getMobilePipeFabState(pipes, deadLetters);
    expect(state.runningCount).toBe(1);
    expect(state.deadLetterCount).toBe(1);
  });
});
