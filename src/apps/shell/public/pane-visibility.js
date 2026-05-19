export function isPaneVisibleForProject(paneProjectId, activeProjectId) {
  return !activeProjectId || !paneProjectId || paneProjectId === activeProjectId;
}

export function isPaneIdVisible(panes, activeProjectId, paneId) {
  if (!paneId) return false;
  const pane = panes.get(paneId);
  return !!pane && isPaneVisibleForProject(pane._projectId || null, activeProjectId);
}

export function listVisiblePaneIds(panes, activeProjectId) {
  const ids = [];
  for (const [id, pane] of panes) {
    if (isPaneVisibleForProject(pane._projectId || null, activeProjectId)) ids.push(id);
  }
  return ids;
}

export function getVisibleFallbackPaneId(panes, activeProjectId, paneId) {
  const visibleIds = listVisiblePaneIds(panes, activeProjectId);
  if (visibleIds.length === 0) return null;

  const idx = visibleIds.indexOf(paneId);
  if (idx === -1) return visibleIds[0] ?? null;
  if (idx > 0) return visibleIds[idx - 1] ?? null;
  return visibleIds[idx + 1] ?? null;
}
