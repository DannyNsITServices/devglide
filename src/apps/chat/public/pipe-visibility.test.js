import { describe, expect, it } from 'vitest';
import { DEFAULT_VISIBLE_TERMINAL, getVisiblePipeSummaries, sortPipeSummaries } from './pipe-visibility.js';

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

