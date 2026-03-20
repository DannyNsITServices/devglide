const API = '/api/workflow';

let _container = null;
let _onSelect = null;
let _onNew = null;
let _confirmFn = null;
let _toastFn = null;

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

function createTag(tag) {
  const el = document.createElement('span');
  el.style.fontSize = '9px';
  el.style.padding = '0 4px';
  el.style.border = '1px solid var(--df-color-border-default)';
  el.style.color = 'var(--df-color-text-muted)';
  el.style.textTransform = 'uppercase';
  el.style.letterSpacing = 'var(--df-letter-spacing-wider)';
  el.textContent = tag;
  return el;
}

function renderWorkflowCard(wf) {
  const nodeCount = wf.nodeCount ?? 0;
  const edgeCount = wf.edgeCount ?? 0;
  const enabled = wf.enabled !== false;
  const card = document.createElement('div');
  card.className = 'wb-wflist-card';
  card.dataset.wfId = wf.id;
  if (!enabled) card.style.opacity = '0.5';

  const body = document.createElement('div');
  body.className = 'wb-wflist-card-body';

  const title = document.createElement('div');
  title.className = 'wb-wflist-card-title';
  title.textContent = wf.name;
  body.appendChild(title);

  if (wf.description) {
    const desc = document.createElement('div');
    desc.className = 'wb-wflist-card-desc';
    desc.textContent = wf.description.replace(/\\n/g, ' ').replace(/\n/g, ' ');
    body.appendChild(desc);
  }

  const meta = document.createElement('div');
  meta.className = 'wb-wflist-card-meta';
  const metaParts = [
    `${nodeCount} node${nodeCount !== 1 ? 's' : ''}`,
    `${edgeCount} edge${edgeCount !== 1 ? 's' : ''}`,
  ];
  if (wf.updatedAt) metaParts.push(timeAgo(wf.updatedAt));
  metaParts.forEach((part, index) => {
    if (index > 0) {
      const dot = document.createElement('span');
      dot.textContent = '·';
      meta.appendChild(dot);
    }
    const span = document.createElement('span');
    span.textContent = part;
    meta.appendChild(span);
  });
  body.appendChild(meta);

  if (wf.tags?.length) {
    const tags = document.createElement('div');
    tags.className = 'wb-wflist-card-tags';
    wf.tags.forEach(tag => tags.appendChild(createTag(tag)));
    body.appendChild(tags);
  }

  const actions = document.createElement('div');
  actions.className = 'wb-wflist-card-actions';

  const edit = document.createElement('button');
  edit.className = 'btn btn-secondary';
  edit.dataset.action = 'edit';
  edit.title = 'Edit';
  edit.textContent = '✎';

  const toggle = document.createElement('button');
  toggle.className = `btn ${enabled ? 'btn-primary' : 'btn-secondary'}`;
  toggle.dataset.action = 'toggle';
  toggle.title = enabled ? 'Disable' : 'Enable';
  toggle.textContent = enabled ? '●' : '○';

  const globalToggle = document.createElement('button');
  globalToggle.className = `btn ${wf.global ? 'btn-primary' : 'btn-secondary'}`;
  globalToggle.dataset.action = 'toggle-global';
  globalToggle.title = wf.global ? 'Make project-only' : 'Make global';
  globalToggle.textContent = wf.global ? '⊕' : '⊙';

  const del = document.createElement('button');
  del.className = 'btn btn-secondary wb-wflist-delete';
  del.dataset.action = 'delete';
  del.title = 'Delete';
  del.textContent = '×';

  actions.append(edit, toggle, globalToggle, del);
  card.append(body, actions);
  return card;
}

async function render() {
  if (!_container) return;

  _container.replaceChildren();

  const header = document.createElement('div');
  header.className = 'wb-wflist-header';
  const label = document.createElement('span');
  label.style.fontSize = 'var(--df-font-size-md)';
  label.style.color = 'var(--df-color-accent-default)';
  label.style.fontFamily = 'var(--df-font-mono)';
  label.style.letterSpacing = 'var(--df-letter-spacing-wider)';
  label.style.textTransform = 'uppercase';
  label.textContent = 'Workflow';
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-primary';
  newBtn.dataset.action = 'new-workflow';
  newBtn.textContent = '+ New Workflow';
  header.append(label, spacer, newBtn);

  const loading = document.createElement('div');
  loading.className = 'wb-wflist-loading';
  loading.style.padding = 'var(--df-space-6)';
  loading.style.textAlign = 'center';
  loading.style.color = 'var(--df-color-text-muted)';
  loading.style.fontSize = 'var(--df-font-size-xs)';
  loading.style.textTransform = 'uppercase';
  loading.style.letterSpacing = 'var(--df-letter-spacing-wider)';
  loading.textContent = 'Loading...';

  _container.append(header, loading);

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
    const empty = document.createElement('div');
    empty.style.padding = 'var(--df-space-8)';
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--df-color-text-muted)';
    const icon = document.createElement('div');
    icon.style.fontSize = '48px';
    icon.style.opacity = '0.15';
    icon.style.marginBottom = 'var(--df-space-2)';
    icon.textContent = '⚙';
    const message = document.createElement('div');
    message.style.fontSize = 'var(--df-font-size-sm)';
    message.style.textTransform = 'uppercase';
    message.style.letterSpacing = 'var(--df-letter-spacing-wide)';
    message.textContent = 'No workflows yet. Create one to get started.';
    empty.append(icon, message);
    grid.appendChild(empty);
  } else {
    workflows.forEach(wf => grid.appendChild(renderWorkflowCard(wf)));
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
