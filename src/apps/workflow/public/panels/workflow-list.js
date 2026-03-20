// ── Workflow Editor — Workflow Browse/Manage List ────────────────────────
// List view for browsing, creating, and managing saved workflows.

const API = '/api/workflow';

let _container = null;
let _onSelect = null;
let _onNew = null;
let _confirmFn = null;
let _toastFn = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function fetchWorkflows() {
  try {
    const res = await fetch(`${API}/workflows`);
    if (!res.ok) throw new Error('Failed to load');
    return await res.json();
  } catch {
    return [];
  }
}

async function deleteWorkflow(id) {
  const res = await fetch(`${API}/workflows/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Delete failed' }));
    throw new Error(err.error || 'Delete failed');
  }
}

async function toggleWorkflow(wf) {
  const enabled = wf.enabled === false ? true : false;
  const res = await fetch(`${API}/workflows/${wf.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...wf, enabled }),
  });
  if (!res.ok) throw new Error('Toggle failed');
  return await res.json();
}

async function toggleGlobal(wf) {
  const isGlobal = !wf.global;
  const res = await fetch(`${API}/workflows/${wf.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ global: isGlobal }),
  });
  if (!res.ok) throw new Error('Global toggle failed');
  return await res.json();
}

function renderWorkflowCard(wf) {
  const nodeCount = wf.nodeCount ?? 0;
  const edgeCount = wf.edgeCount ?? 0;
  const enabled = wf.enabled !== false;
  const tags = (wf.tags || []).map(t =>
    `<span style="font-size:9px;padding:0 4px;border:1px solid var(--df-color-border-default);
      color:var(--df-color-text-muted);text-transform:uppercase;letter-spacing:var(--df-letter-spacing-wider);">
      ${esc(t)}</span>`
  ).join('');

  return `
    <div class="wb-wflist-card" data-wf-id="${esc(wf.id)}" style="${!enabled ? 'opacity:0.5;' : ''}">
      <div class="wb-wflist-card-body">
        <div class="wb-wflist-card-title">${esc(wf.name)}</div>
        ${wf.description ? `<div class="wb-wflist-card-desc">${esc(wf.description).replace(/\\n/g, ' ').replace(/\n/g, ' ')}</div>` : ''}
        <div class="wb-wflist-card-meta">
          <span>${nodeCount} node${nodeCount !== 1 ? 's' : ''}</span>
          <span>&middot;</span>
          <span>${edgeCount} edge${edgeCount !== 1 ? 's' : ''}</span>
          ${wf.updatedAt ? `<span>&middot;</span><span>${timeAgo(wf.updatedAt)}</span>` : ''}
        </div>
        ${tags ? `<div class="wb-wflist-card-tags">${tags}</div>` : ''}
      </div>
      <div class="wb-wflist-card-actions">
        <button class="btn btn-secondary" data-action="edit" title="Edit">&#9998;</button>
        <button class="btn ${enabled ? 'btn-primary' : 'btn-secondary'}" data-action="toggle" title="${enabled ? 'Disable' : 'Enable'}">${enabled ? '●' : '○'}</button>
        <button class="btn ${wf.global ? 'btn-primary' : 'btn-secondary'}" data-action="toggle-global" title="${wf.global ? 'Make project-only' : 'Make global'}">${wf.global ? '⊕' : '⊙'}</button>
        <button class="btn btn-secondary wb-wflist-delete" data-action="delete" title="Delete">&times;</button>
      </div>
    </div>`;
}

async function render() {
  if (!_container) return;

  _container.innerHTML = `
    <div class="wb-wflist-header">
      <span style="font-size:var(--df-font-size-md);color:var(--df-color-accent-default);
        font-family:var(--df-font-mono);letter-spacing:var(--df-letter-spacing-wider);
        text-transform:uppercase;">Workflow</span>
      <span style="flex:1"></span>
      <button class="btn btn-primary" data-action="new-workflow">+ New Workflow</button>
    </div>
    <div class="wb-wflist-loading" style="padding:var(--df-space-6);text-align:center;
      color:var(--df-color-text-muted);font-size:var(--df-font-size-xs);text-transform:uppercase;
      letter-spacing:var(--df-letter-spacing-wider);">Loading...</div>
  `;

  const newBtn = _container.querySelector('[data-action="new-workflow"]');
  if (newBtn) newBtn.addEventListener('click', () => _onNew?.());

  await renderList();
}

async function renderList() {
  if (!_container) return;

  const workflows = await fetchWorkflows();

  const loading = _container.querySelector('.wb-wflist-loading');
  if (loading) loading.remove();

  const oldList = _container.querySelector('.wb-wflist-grid');
  if (oldList) oldList.remove();

  const grid = document.createElement('div');
  grid.className = 'wb-wflist-grid';

  if (!workflows.length) {
    grid.innerHTML = `
      <div style="padding:var(--df-space-8);text-align:center;color:var(--df-color-text-muted);">
        <div style="font-size:48px;opacity:0.15;margin-bottom:var(--df-space-2);">&#9881;</div>
        <div style="font-size:var(--df-font-size-sm);text-transform:uppercase;
          letter-spacing:var(--df-letter-spacing-wide);">
          No workflows yet. Create one to get started.
        </div>
      </div>`;
  } else {
    grid.innerHTML = workflows.map(renderWorkflowCard).join('');
  }

  _container.appendChild(grid);
  bindCardEvents(grid, workflows);
}

function bindCardEvents(grid, workflows) {
  const cards = grid.querySelectorAll('.wb-wflist-card');
  for (const card of cards) {
    const wfId = card.dataset.wfId;
    const wf = workflows.find(w => w.id === wfId);

    card.querySelector('[data-action="edit"]')?.addEventListener('click', () => _onSelect?.(wf));

    card.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
      try {
        await toggleWorkflow(wf);
        await renderList();
      } catch (e) {
        _toastFn?.(e.message || 'Toggle failed', 'error');
      }
    });

    card.querySelector('[data-action="toggle-global"]')?.addEventListener('click', async () => {
      try {
        await toggleGlobal(wf);
        await renderList();
      } catch (e) {
        _toastFn?.(e.message || 'Global toggle failed', 'error');
      }
    });

    card.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      if (!_confirmFn) return;
      const confirmed = await _confirmFn('Delete Workflow', `Delete workflow "${wf?.name}"? This cannot be undone.`);
      if (!confirmed) return;
      try {
        await deleteWorkflow(wfId);
        _toastFn?.('Workflow deleted', 'success');
      } catch (e) {
        _toastFn?.(e.message || 'Delete failed', 'error');
      }
      await renderList();
    });

    const body = card.querySelector('.wb-wflist-card-body');
    if (body) {
      body.style.cursor = 'pointer';
      body.addEventListener('click', () => _onSelect?.(wf));
    }
  }
}

// ── Exports ─────────────────────────────────────────────────────────────

export const WorkflowList = {
  mount(container) {
    _container = container;
    render();
  },

  unmount() {
    if (_container) _container.innerHTML = '';
    _container = null;
    _onSelect = null;
    _onNew = null;
    _confirmFn = null;
    _toastFn = null;
  },

  onSelect(callback) {
    _onSelect = callback;
  },

  onNew(callback) {
    _onNew = callback;
  },

  setConfirm(fn) {
    _confirmFn = fn;
  },

  setToast(fn) {
    _toastFn = fn;
  },

  async refresh() {
    await renderList();
  },
};
