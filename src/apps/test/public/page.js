// ── Test App — Page Module ────────────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).

import { timeAgo, formatDuration } from '/shared-assets/ui-utils.js';
import { createHeader } from '/shared-ui/components/header.js';

let activeProjectPath = null;
let _refreshTimer = null;
let _container = null;
let _visibilityHandler = null;

// ── HTML (body content, no script tags) ──────────────────────────────

const BODY_HTML = `
  ${createHeader({
    brand: 'Test',
    meta: `
      <span class="badge badge-idle" id="status-badge" role="status" aria-live="polite">idle</span>
      <span>
        auto-refresh 5s
        <span class="refresh-indicator" id="refresh-dot"></span>
      </span>
    `,
  })}

  <main>
    <div class="saved-section">
      <div class="section-title">Saved Tests</div>
      <div id="saved-list">
        <div class="saved-empty" id="saved-empty">No saved tests yet.</div>
      </div>
    </div>

    <div class="results-section">
      <div class="results-header">
        <div class="section-title" style="margin-bottom:0">Recent Runs</div>
        <button class="btn btn-clear" id="clear-results-btn" style="display:none">Clear</button>
      </div>
      <div id="results-list">
        <div class="results-empty" id="results-empty">No recent runs.</div>
      </div>
    </div>

    <details class="info-card-details">
      <summary>Setup &amp; Usage</summary>
      <div class="info-card">
        <strong>Ask your AI to write tests for you.</strong> Describe what to test in natural language
        and Claude will generate and run browser automation scenarios automatically.<br/><br/>
        <em>Example prompts:</em><br/>
        &bull; "Write a test that creates a kanban task and verifies it appears in the Todo column"<br/>
        &bull; "Test that the shell pane opens and runs a command"<br/>
        &bull; "Create a regression suite for the voice transcription settings page"<br/><br/>
        <strong>Setup for external apps:</strong> Add one script tag to enable automation:<br/>
        <code>&lt;script src="http://localhost:7000/devtools.js"&gt;&lt;/script&gt;</code><br/>
        DevGlide monorepo apps need no manual setup.<br/><br/>
        <strong>Manual usage:</strong> Submit scenarios via <code>POST /api/test/trigger/scenarios</code>
        or the <code>test_run_scenario</code> MCP tool. Use simple app names as targets
        (e.g. <code>"kanban"</code>, <code>"dashboard"</code>) — absolute paths also work.
      </div>
    </details>
  </main>
`;

// ── Helpers ──────────────────────────────────────────────────────────

function flash() {
  if (!_container) return;
  const dot = _container.querySelector('#refresh-dot');
  if (!dot) return;
  dot.classList.add('flash');
  setTimeout(() => dot.classList.remove('flash'), 300);
}

// ── Data fetching ───────────────────────────────────────────────────

async function refresh() {
  if (!_container) return;
  try {
    const params = activeProjectPath
      ? '?projectPath=' + encodeURIComponent(activeProjectPath)
      : '';
    const res = await fetch('/api/test/trigger/status' + params);
    if (!res.ok) return;
    const { pendingScenarios } = await res.json();

    const statusBadge = _container.querySelector('#status-badge');
    if (pendingScenarios > 0) {
      statusBadge.textContent = 'running ' + pendingScenarios;
      statusBadge.className = 'badge badge-running';
    } else {
      statusBadge.textContent = 'idle';
      statusBadge.className = 'badge badge-idle';
    }

    flash();
    refreshSaved();
    refreshResults();
  } catch (e) {
    // ignore network errors
  }
}

async function refreshSaved() {
  if (!_container) return;
  try {
    const params = activeProjectPath
      ? '?projectPath=' + encodeURIComponent(activeProjectPath)
      : '';
    const res = await fetch('/api/test/trigger/scenarios/saved' + params);
    if (!res.ok) return;
    const scenarios = await res.json();

    const list = _container.querySelector('#saved-list');
    const emptyEl = _container.querySelector('#saved-empty');

    if (!scenarios.length) {
      list.innerHTML = '';
      list.appendChild(emptyEl);
      emptyEl.style.display = '';
      return;
    }

    emptyEl.style.display = 'none';
    const fragment = document.createDocumentFragment();

    for (const s of scenarios) {
      const card = document.createElement('div');
      card.className = 'saved-card';
      card.dataset.id = s.id;

      const info = document.createElement('div');
      info.className = 'saved-info';

      const name = document.createElement('div');
      name.className = 'saved-name';
      name.textContent = s.name;

      const details = document.createElement('div');
      details.className = 'saved-details';
      const stepCount = s.steps ? s.steps.length : 0;
      const runCount = s.runCount || 0;
      const lastRun = s.lastRunAt ? timeAgo(s.lastRunAt) : 'never';
      details.textContent = (s.target || 'no target')
        + ' \u00b7 ' + stepCount + ' step' + (stepCount !== 1 ? 's' : '')
        + ' \u00b7 ' + runCount + ' run' + (runCount !== 1 ? 's' : '')
        + ' \u00b7 last run ' + lastRun;

      info.appendChild(name);
      info.appendChild(details);

      const actions = document.createElement('div');
      actions.className = 'saved-actions';

      const runBtn = document.createElement('button');
      runBtn.className = 'btn btn-run';
      runBtn.textContent = 'Run';
      runBtn.addEventListener('click', () => runSaved(s.id));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteSaved(s.id));

      actions.appendChild(runBtn);
      actions.appendChild(delBtn);

      card.appendChild(info);
      card.appendChild(actions);
      fragment.appendChild(card);
    }

    // Preserve the hidden empty element
    list.innerHTML = '';
    emptyEl.style.display = 'none';
    list.appendChild(emptyEl);
    list.appendChild(fragment);
  } catch (e) {
    // ignore network errors
  }
}

async function runSaved(id) {
  if (!_container) return;
  try {
    await fetch('/api/test/trigger/scenarios/saved/' + encodeURIComponent(id) + '/run', {
      method: 'POST'
    });
    const card = _container.querySelector('.saved-card[data-id="' + id + '"]');
    if (card) {
      card.classList.add('just-triggered');
      setTimeout(() => card.classList.remove('just-triggered'), 1200);
    }
    refresh();
    refreshSaved();
  } catch (e) {
    // ignore
  }
}

async function deleteSaved(id) {
  try {
    await fetch('/api/test/trigger/scenarios/saved/' + encodeURIComponent(id), {
      method: 'DELETE'
    });
    refreshSaved();
  } catch (e) {
    // ignore
  }
}

// ── Results history ─────────────────────────────────────────────────

let _resultsCleared = false;
let _expandedErrors = new Set();

function clearResults() {
  _resultsCleared = true;
  _expandedErrors.clear();
  renderResults([]);
}

function renderResults(results) {
  if (!_container) return;
  const list = _container.querySelector('#results-list');
  const emptyEl = _container.querySelector('#results-empty');
  const clearBtn = _container.querySelector('#clear-results-btn');
  if (!list || !emptyEl) return;

  if (!results.length) {
    list.innerHTML = '';
    list.appendChild(emptyEl);
    emptyEl.style.display = '';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  if (clearBtn) clearBtn.style.display = '';

  // Sort newest first
  const sorted = results.slice().sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const fragment = document.createDocumentFragment();

  for (const r of sorted) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const info = document.createElement('div');
    info.className = 'result-info';

    // Top row: ID + status badge
    const topRow = document.createElement('div');
    topRow.className = 'result-top-row';

    const idEl = document.createElement('span');
    idEl.className = 'result-id';
    idEl.textContent = r.id.length > 12 ? r.id.slice(0, 12) + '\u2026' : r.id;
    idEl.title = r.id;

    const statusEl = document.createElement('span');
    statusEl.className = 'result-status ' + r.status;
    statusEl.textContent = r.status;

    topRow.appendChild(idEl);
    topRow.appendChild(statusEl);

    // Details row: duration + time ago + failed step info
    const details = document.createElement('div');
    details.className = 'result-details';

    const parts = [];
    const dur = formatDuration(r.duration);
    if (dur) parts.push(dur);
    parts.push(timeAgo(r.createdAt));
    if (r.status === 'failed' && r.failedStep != null) {
      parts.push('failed at step ' + r.failedStep);
    }
    details.textContent = parts.join(' \u00b7 ');

    // Error toggle for failed scenarios
    if (r.status === 'failed' && r.error) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'result-error-toggle';
      const isExpanded = _expandedErrors.has(r.id);
      toggleBtn.textContent = isExpanded ? 'hide error' : 'show error';

      const errorEl = document.createElement('div');
      errorEl.className = 'result-error';
      errorEl.textContent = r.error;
      errorEl.style.display = isExpanded ? '' : 'none';

      toggleBtn.addEventListener('click', () => {
        const nowExpanded = errorEl.style.display === 'none';
        errorEl.style.display = nowExpanded ? '' : 'none';
        toggleBtn.textContent = nowExpanded ? 'hide error' : 'show error';
        if (nowExpanded) {
          _expandedErrors.add(r.id);
        } else {
          _expandedErrors.delete(r.id);
        }
      });

      details.appendChild(toggleBtn);
      info.appendChild(topRow);
      info.appendChild(details);
      info.appendChild(errorEl);
    } else {
      info.appendChild(topRow);
      info.appendChild(details);
    }

    card.appendChild(info);
    fragment.appendChild(card);
  }

  list.innerHTML = '';
  emptyEl.style.display = 'none';
  list.appendChild(emptyEl);
  list.appendChild(fragment);
}

async function refreshResults() {
  if (!_container || _resultsCleared) return;
  try {
    const params = activeProjectPath
      ? '?projectPath=' + encodeURIComponent(activeProjectPath)
      : '';
    const res = await fetch('/api/test/trigger/scenarios/results' + params);
    if (!res.ok) return;
    const results = await res.json();
    renderResults(results);
  } catch (e) {
    // ignore network errors
  }
}

// ── Refresh polling ─────────────────────────────────────────────────

function _startRefreshPoll() {
  if (_refreshTimer) return;
  refresh();
  _refreshTimer = setInterval(refresh, 5000);
}

function _stopRefreshPoll() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ── Exports ─────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;

  // 1. Scope the container
  container.classList.add('page-test', 'app-page');

  // 2. Build HTML
  container.innerHTML = BODY_HTML;

  // 3. Set initial project from context
  activeProjectPath = ctx?.project?.path || null;

  // 4. Clear results button
  const clearBtn = container.querySelector('#clear-results-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearResults);

  // 5. Visibility-change handler for auto-refresh
  _visibilityHandler = () => {
    if (document.hidden) _stopRefreshPoll();
    else _startRefreshPoll();
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  // 6. Start polling
  _startRefreshPoll();
}

export function unmount(container) {
  // 1. Stop refresh timer
  _stopRefreshPoll();

  // 2. Remove visibility handler
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  // 3. Remove scope class & clear HTML
  container.classList.remove('page-test', 'app-page');
  container.innerHTML = '';

  // 4. Clear module references
  _container = null;
  activeProjectPath = null;
  _resultsCleared = false;
  _expandedErrors.clear();
}

export function onProjectChange(project) {
  activeProjectPath = project?.path || null;
  refresh();
}
