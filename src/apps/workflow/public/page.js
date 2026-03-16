// ── Workflow App — Page Module ────────────────────────────────────────
// Visual workflow builder with drag-and-drop node editor.
// ES module: mount(container, ctx), unmount(container), onProjectChange(project)

import { escapeHtml } from '/shared-assets/ui-utils.js';

let _container = null;
let _builderModules = null;
let _builderMounted = false;
let _keydownHandler = null;
let _renderUnsubs = [];

// ── HTML ────────────────────────────────────────────────────────────────

const BODY_HTML = `
  <div class="wf-builder-layout" id="wf-builder-layout">
    <div class="wb-toolbar" id="wb-toolbar"></div>
    <div class="wb-main-layout">
      <div class="wb-canvas-container" id="wb-canvas"></div>
      <div class="wb-inspector" id="wb-inspector"></div>
    </div>
    <div id="wb-run-view"></div>
  </div>
  <div class="modal-overlay hidden" id="wf-modal" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="modal-header">
        <h2 class="wf-modal-title"></h2>
        <div class="modal-desc wf-modal-body"></div>
      </div>
      <div class="modal-actions wf-modal-actions"></div>
    </div>
  </div>
  <div class="wf-toast-container" id="wf-toast-container"></div>
`;

// ── Helpers ──────────────────────────────────────────────────────────

function $(selector) {
  return _container?.querySelector(selector) ?? null;
}

const esc = escapeHtml;

// ── Modal / Toast helpers ───────────────────────────────────────────

function showModal(title, bodyHtml, buttons) {
  return new Promise(resolve => {
    const overlay = _container?.querySelector('.modal-overlay');
    if (!overlay) { resolve(null); return; }

    overlay.querySelector('.wf-modal-title').textContent = title;
    overlay.querySelector('.wf-modal-body').innerHTML = bodyHtml;
    const actionsEl = overlay.querySelector('.wf-modal-actions');
    actionsEl.innerHTML = buttons.map(b =>
      `<button class="${b.cls}" data-value="${b.value}">${b.label}</button>`
    ).join('');

    overlay.classList.remove('hidden');

    const ac = new AbortController();
    const close = (value) => {
      overlay.classList.add('hidden');
      ac.abort();
      resolve(value);
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    }, { signal: ac.signal });

    actionsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => close(btn.dataset.value), { signal: ac.signal });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
    }, { signal: ac.signal });
  });
}

async function wfConfirm(title, message) {
  const result = await showModal(title, `<p>${esc(message)}</p>`, [
    { label: 'Cancel', cls: 'btn btn-secondary', value: 'cancel' },
    { label: 'Delete', cls: 'btn btn-danger', value: 'confirm' },
  ]);
  return result === 'confirm';
}

async function wfAlert(title, bodyHtml) {
  await showModal(title, bodyHtml, [
    { label: 'OK', cls: 'btn btn-primary', value: 'ok' },
  ]);
}

function wfToast(message, type = 'info') {
  const container = _container?.querySelector('.wf-toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `wf-toast wf-toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Builder API ─────────────────────────────────────────────────────

const API = '/api/workflow';

async function loadBuilderModules() {
  if (_builderModules) return _builderModules;

  const [
    { Inspector },
    { Toolbar },
    { WorkflowList },
    { RunView },
    { store },
    { WorkflowModel },
    { Canvas },
    { NodeRenderer },
    { EdgeRenderer },
    { DragManager },
    { HistoryManager },
    { NODE_TYPES },
  ] = await Promise.all([
    import('./panels/inspector.js'),
    import('./panels/toolbar.js'),
    import('./panels/workflow-list.js'),
    import('./panels/run-view.js'),
    import('./state/store.js'),
    import('./models/workflow-model.js'),
    import('./editor/canvas.js'),
    import('./editor/node-renderer.js'),
    import('./editor/edge-renderer.js'),
    import('./editor/drag-manager.js'),
    import('./editor/history-manager.js'),
    import('./models/node-types.js'),
  ]);

  _builderModules = {
    Inspector, Toolbar, WorkflowList, RunView,
    store, WorkflowModel,
    Canvas, NodeRenderer, EdgeRenderer, DragManager, HistoryManager, NODE_TYPES,
  };
  return _builderModules;
}

async function mountBuilder() {
  if (_builderMounted) return;

  await loadBuilderModules();
  _builderMounted = true;

  showBuilderList();
}

function showBuilderList() {
  if (!_builderModules || !_container) return;
  const { WorkflowList, Toolbar, Inspector, RunView, Canvas, DragManager, HistoryManager } = _builderModules;

  // Clean up render subscriptions
  for (const unsub of _renderUnsubs) unsub();
  _renderUnsubs = [];

  Toolbar.unmount();
  Inspector.unmount();
  RunView.unmount();
  Canvas.unmount();
  DragManager.destroy();
  HistoryManager.destroy();

  const builderLayout = $('#wf-builder-layout');
  if (!builderLayout) return;

  builderLayout.innerHTML = `<div id="wb-workflow-list" style="display:flex;flex-direction:column;flex:1;overflow:hidden;"></div>`;

  const listContainer = builderLayout.querySelector('#wb-workflow-list');
  WorkflowList.mount(listContainer);
  WorkflowList.setConfirm(wfConfirm);
  WorkflowList.setToast(wfToast);

  WorkflowList.onSelect((wf) => openWorkflowInEditor(wf));
  WorkflowList.onNew(() => openWorkflowInEditor(null));
}

function addNodeAtPosition(type, x, y) {
  if (!_builderModules) return;
  const { store, WorkflowModel, NODE_TYPES } = _builderModules;
  const wf = store.get('workflow');
  const typeDef = NODE_TYPES[type];
  const label = typeDef?.label ?? type;
  WorkflowModel.addNode(type, label, { x, y });
}

async function openWorkflowInEditor(wf) {
  if (!_builderModules || !_container) return;
  const {
    Inspector, Toolbar, WorkflowList, RunView,
    store, WorkflowModel,
    Canvas, NodeRenderer, EdgeRenderer, DragManager, HistoryManager, NODE_TYPES,
  } = _builderModules;

  // Clean up render subscriptions from previous editor session
  for (const unsub of _renderUnsubs) unsub();
  _renderUnsubs = [];

  WorkflowList.unmount();
  Canvas.unmount();
  DragManager.destroy();
  HistoryManager.destroy();

  if (wf) {
    try {
      const res = await fetch(`${API}/workflows/${wf.id}`);
      if (res.ok) {
        WorkflowModel.load(await res.json());
      } else {
        WorkflowModel.load(wf);
      }
    } catch {
      WorkflowModel.load(wf);
    }
  } else {
    WorkflowModel.load({
      name: 'Untitled Workflow',
      description: '',
      nodes: [],
      edges: [],
    });
  }

  const builderLayout = $('#wf-builder-layout');
  if (!builderLayout) return;

  builderLayout.innerHTML = `
    <div class="wb-toolbar" id="wb-toolbar"></div>
    <div class="wb-main-layout">
      <div class="wb-canvas-container" id="wb-canvas"></div>
      <div class="wb-inspector" id="wb-inspector"></div>
    </div>
    <div id="wb-run-view"></div>
  `;

  const canvasContainerEl = builderLayout.querySelector('#wb-canvas');

  Toolbar.mount(builderLayout.querySelector('#wb-toolbar'));
  Inspector.mount(builderLayout.querySelector('#wb-inspector'));

  // Init undo/redo history and connect to toolbar
  HistoryManager.init();
  Toolbar.setHistoryManager(HistoryManager);

  Toolbar.setHandlers({
    onBack: () => showBuilderList(),
    onSave: () => saveWorkflow(),
    onAddStep: (nodeType) => {
      // Add node of selected type at center of visible canvas
      const canvasRoot = Canvas.getRootElement();
      if (canvasRoot) {
        const rect = canvasRoot.getBoundingClientRect();
        const center = Canvas.screenToWorld(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        addNodeAtPosition(nodeType || 'step', center.x, center.y);
      }
    },
    onExport: () => exportWorkflow(),
  });

  // Mount Canvas into the canvas container
  Canvas.mount(canvasContainerEl);

  // Render function — creates/updates nodes and edges on canvas
  function renderGraph() {
    const wfData = store.get('workflow');
    if (!wfData) return;

    const world = Canvas.getWorldElement();
    const svgWorld = Canvas.getSvgElement();
    if (!world || !svgWorld) return;

    // Reconcile nodes: update existing, add new, remove old
    const existingNodeEls = world.querySelectorAll('.wfb-node');
    const existingMap = new Map();
    for (const el of existingNodeEls) existingMap.set(el.dataset.nodeId, el);

    const currentIds = new Set(wfData.nodes.map(n => n.id));

    // Remove nodes that no longer exist
    for (const [id, el] of existingMap) {
      if (!currentIds.has(id)) el.remove();
    }

    // Add or update nodes
    for (const node of wfData.nodes) {
      const existing = existingMap.get(node.id);
      if (existing) {
        NodeRenderer.updateNodeElement(existing, node);
      } else {
        const el = NodeRenderer.createNodeElement(node);
        world.appendChild(el);
      }
    }

    // Update selection visuals
    const selectedIds = store.get('selectedNodeIds') ?? new Set();
    for (const node of wfData.nodes) {
      const el = world.querySelector(`[data-node-id="${node.id}"]`);
      if (el) NodeRenderer.setSelected(el, selectedIds.has(node.id));
    }

    // Re-render all edges (simpler than reconciling)
    const edgeEls = svgWorld.querySelectorAll('.wfb-edge');
    for (const e of edgeEls) e.remove();

    for (const edge of wfData.edges) {
      const srcNode = wfData.nodes.find(n => n.id === edge.source);
      const tgtNode = wfData.nodes.find(n => n.id === edge.target);
      if (srcNode && tgtNode) {
        const srcType = NODE_TYPES[srcNode.type];
        const tgtType = NODE_TYPES[tgtNode.type];
        const el = EdgeRenderer.createEdgePath(edge, srcNode, tgtNode, srcType, tgtType);
        svgWorld.appendChild(el);
      }
    }

    // Update edge selection
    const selectedEdgeIds = store.get('selectedEdgeIds') ?? new Set();
    for (const edge of wfData.edges) {
      const el = svgWorld.querySelector(`[data-edge-id="${edge.id}"]`);
      if (el) EdgeRenderer.setSelected(el, selectedEdgeIds.has(edge.id));
    }
  }

  // Subscribe to store changes for re-rendering
  const unsubWorkflow = store.on('workflow', renderGraph);
  const unsubSelection = store.on('selectedNodeIds', renderGraph);
  const unsubEdgeSelection = store.on('selectedEdgeIds', renderGraph);
  _renderUnsubs.push(unsubWorkflow, unsubSelection, unsubEdgeSelection);

  // Initial render
  renderGraph();

  // Init drag manager for node moves and edge creation
  DragManager.init(Canvas, Canvas.getWorldElement(), Canvas.getSvgElement());

  // Double-click on canvas to create step
  const canvasRoot = Canvas.getRootElement();
  if (canvasRoot) {
    canvasRoot.addEventListener('dblclick', (e) => {
      // Don't create step if double-clicking on an existing node
      if (e.target.closest('.wfb-node')) return;
      const pos = Canvas.screenToWorld(e.clientX, e.clientY);
      addNodeAtPosition('step', pos.x, pos.y);
    });

    // Click on canvas background to deselect, or on edge to select it
    canvasRoot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Edge click — check SVG hit areas
      const hitPath = e.target.closest?.('.wfb-edge-hit');
      if (hitPath) {
        const edgeGroup = hitPath.closest('.wfb-edge');
        const edgeId = edgeGroup?.dataset?.edgeId;
        if (edgeId) {
          if (e.shiftKey) {
            const sel = new Set(store.get('selectedEdgeIds') ?? []);
            if (sel.has(edgeId)) sel.delete(edgeId); else sel.add(edgeId);
            store.set('selectedEdgeIds', sel);
          } else {
            store.set('selectedEdgeIds', new Set([edgeId]));
            store.set('selectedNodeIds', new Set());
          }
          return;
        }
      }
      if (!e.target.closest('.wfb-node') && !e.target.closest('.wfb-port')) {
        store.set('selectedNodeIds', new Set());
        store.set('selectedEdgeIds', new Set());
      }
    });
  }
}

async function saveWorkflow() {
  if (!_builderModules) return;
  const { WorkflowModel, Toolbar } = _builderModules;

  const data = WorkflowModel.save();
  if (!data) return;

  try {
    let res;
    if (data.id) {
      res = await fetch(`${API}/workflows/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.status === 404) {
        res = await fetch(`${API}/workflows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      }
    } else {
      res = await fetch(`${API}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    }

    if (res.ok) {
      const saved = await res.json();
      WorkflowModel.load(saved);
      Toolbar.setDirty(false);
      wfToast('Workflow saved', 'success');
    } else {
      wfToast('Save failed', 'error');
    }
  } catch (e) {
    console.error('Save failed:', e);
    wfToast('Save failed: ' + e.message, 'error');
  }
}

async function exportWorkflow() {
  if (!_builderModules) return;
  const { WorkflowModel } = _builderModules;

  const data = WorkflowModel.save();
  if (!data || !data.nodes?.length) {
    wfToast('No steps to export', 'error');
    return;
  }

  // Build ordered step list by following edges
  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));
  const outEdges = new Map();
  for (const e of data.edges) {
    outEdges.set(e.source, e);
  }

  // Find start nodes (no incoming edges)
  const hasIncoming = new Set(data.edges.map(e => e.target));
  const startNodes = data.nodes.filter(n => !hasIncoming.has(n.id));

  let md = `# ${data.name}\n\n`;
  if (data.description) md += `${data.description}\n\n`;
  md += `---\n\n`;

  // Walk graph from each start node
  let stepNum = 1;
  const visited = new Set();

  function walkNode(nodeId) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    md += `## Step ${stepNum}: ${node.label}\n\n`;
    stepNum++;

    const instructions = node.config?.instructions;
    const file = node.config?.instructionFile;

    if (instructions) {
      md += `${instructions}\n\n`;
    }
    if (file) {
      md += `> Instructions file: \`${file}\`\n\n`;
    }
    if (!instructions && !file) {
      md += `*(No instructions defined)*\n\n`;
    }

    // Follow outgoing edge
    const edge = outEdges.get(nodeId);
    if (edge) walkNode(edge.target);
  }

  if (startNodes.length === 0 && data.nodes.length > 0) {
    // No clear start — just list all nodes
    for (const node of data.nodes) walkNode(node.id);
  } else {
    for (const node of startNodes) walkNode(node.id);
  }

  // Any unvisited nodes
  for (const node of data.nodes) {
    if (!visited.has(node.id)) walkNode(node.id);
  }

  // Show in a modal with copy button
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const result = await showModal('Export Workflow',
    `<pre style="max-height:300px;overflow:auto;padding:var(--df-space-3);background:var(--df-color-bg-raised);border:1px solid var(--df-color-border-default);border-radius:6px;font-size:var(--df-font-size-xs);white-space:pre-wrap;word-wrap:break-word;">${escaped}</pre>`,
    [
      { label: 'Copy', cls: 'btn btn-primary', value: 'copy' },
      { label: 'Close', cls: 'btn btn-secondary', value: 'close' },
    ]
  );

  if (result === 'copy') {
    try {
      await navigator.clipboard.writeText(md);
      wfToast('Copied to clipboard', 'success');
    } catch {
      wfToast('Copy failed', 'error');
    }
  }
}



function unmountBuilder() {
  if (!_builderMounted || !_builderModules) return;
  const { Inspector, Toolbar, WorkflowList, RunView, Canvas, DragManager, HistoryManager } = _builderModules;

  // Clean up render subscriptions
  for (const unsub of _renderUnsubs) unsub();
  _renderUnsubs = [];

  Toolbar.unmount();
  Inspector.unmount();
  WorkflowList.unmount();
  RunView.unmount();
  Canvas.unmount();
  DragManager.destroy();
  HistoryManager.destroy();

  _builderMounted = false;
}

// ── Keyboard shortcuts ──────────────────────────────────────────────

function setupKeyboardShortcuts() {
  _keydownHandler = async (e) => {
    if (!_builderModules) return;

    const { store, WorkflowModel } = _builderModules;
    const ctrl = e.ctrlKey || e.metaKey;

    // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z — handled by HistoryManager

    if (ctrl && e.key === 's') {
      e.preventDefault();
      await saveWorkflow();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      e.preventDefault();
      const selectedNodes = store.get('selectedNodeIds');
      const selectedEdges = store.get('selectedEdgeIds');
      if (selectedNodes?.size) {
        for (const id of selectedNodes) WorkflowModel.removeNode(id);
      }
      if (selectedEdges?.size) {
        for (const id of selectedEdges) WorkflowModel.removeEdge(id);
      }
      return;
    }

    if (ctrl && e.key === 'a') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      const wf = store.get('workflow');
      if (wf?.nodes) {
        store.set('selectedNodeIds', new Set(wf.nodes.map(n => n.id)));
      }
      return;
    }

    if (ctrl && e.key === 'Enter') {
      e.preventDefault();
      await runWorkflow();
      return;
    }

    if (ctrl && e.key === '0') {
      e.preventDefault();
      store.set('zoom', 1);
      store.set('panX', 0);
      store.set('panY', 0);
      return;
    }

    if (e.key === 'Escape') {
      store.set('selectedNodeIds', new Set());
      store.set('selectedEdgeIds', new Set());
      return;
    }

    if (e.key === '+' || e.key === '=') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      store.set('zoom', Math.min(3, (store.get('zoom') ?? 1) + 0.1));
      return;
    }

    if (e.key === '-') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      store.set('zoom', Math.max(0.25, (store.get('zoom') ?? 1) - 0.1));
      return;
    }
  };

  document.addEventListener('keydown', _keydownHandler);
}

function teardownKeyboardShortcuts() {
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
}

// ── Exports ──────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;

  container.classList.add('page-workflow');
  container.innerHTML = BODY_HTML;

  setupKeyboardShortcuts();
  mountBuilder();
}

export function unmount(container) {
  unmountBuilder();
  teardownKeyboardShortcuts();

  container.classList.remove('page-workflow');
  container.innerHTML = '';

  _container = null;
  _builderMounted = false;
}

export function onProjectChange(project) {
  // Refresh the builder list if it's showing
  if (_builderModules) {
    const { WorkflowList } = _builderModules;
    WorkflowList.refresh?.();
  }
}
