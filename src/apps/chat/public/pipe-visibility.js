export const DEFAULT_VISIBLE_TERMINAL = 10;

/**
 * Compute the mobile FAB badge state from pipe data.
 * Pure function — no DOM dependencies.
 */
export function getMobilePipeFabState(pipeSummaries, deadLetters) {
  const runningCount = pipeSummaries.filter(p => p.status === 'running').length;
  const deadLetterCount = deadLetters.length;
  return {
    runningCount,
    deadLetterCount,
    hasRunning: runningCount > 0,
    hasAlert: deadLetterCount > 0,
  };
}

export function getPipeStatusRank(status) {
  return status === 'running' ? 0 : status === 'failed' ? 1 : status === 'cancelled' ? 2 : 3;
}

export function sortPipeSummaries(pipes) {
  return [...pipes].sort((a, b) => {
    const statusDelta = getPipeStatusRank(a.status) - getPipeStatusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

export function getVisiblePipeSummaries(
  pipes,
  {
    expandedPipeId = null,
    showAll = false,
    terminalLimit = DEFAULT_VISIBLE_TERMINAL,
  } = {},
) {
  const sorted = sortPipeSummaries(pipes);
  const running = [];
  const terminal = [];

  for (const pipe of sorted) {
    if (pipe.status === 'running') running.push(pipe);
    else terminal.push(pipe);
  }

  const normalizedLimit = Number.isFinite(terminalLimit)
    ? Math.max(0, Math.trunc(terminalLimit))
    : DEFAULT_VISIBLE_TERMINAL;

  const visibleTerminalIds = new Set(
    showAll
      ? terminal.map(pipe => pipe.pipeId)
      : terminal.slice(0, normalizedLimit).map(pipe => pipe.pipeId),
  );

  if (expandedPipeId) visibleTerminalIds.add(expandedPipeId);

  const visibleTerminal = terminal.filter(pipe => visibleTerminalIds.has(pipe.pipeId));
  return {
    visiblePipes: [...running, ...visibleTerminal],
    hiddenTerminalCount: terminal.length - visibleTerminal.length,
    totalCount: sorted.length,
    totalTerminalCount: terminal.length,
    canToggleTerminalHistory: terminal.length > normalizedLimit,
  };
}
