// ── Shell App — Native Page Module ────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).
//
// Replaces the iframe-based page module with a native implementation
// that renders terminal panes directly in the app shell container.

import { shellSocket as socket } from '/state.js';

// ── Module state ─────────────────────────────────────────────────────

let _container = null;
let _resizeTimer = null;
let _voiceHandler = null;
let _keydownHandler = null;
let _xtermLoaded = false;
let _mountedOnce = false;
let _restoring = false;  // true during snapshot batch restore — suppresses premature fits

const panes = new Map();   // id -> pane object
const pendingData = new Map();   // id -> string[] — buffers terminal data for panes not yet created
let activePaneId = null;
let activeTab = 'grid';
let activeProject = null;

// Track socket handlers for cleanup
const _socketHandlers = {};

// ── Terminal theme ───────────────────────────────────────────────────

const TERMINAL_THEME = {
  background: '#1c2128', foreground: '#adbac7', cursor: '#7ee787',
  selectionBackground: '#7ee78744',
  black: '#1c1c1c', red: '#f85149', green: '#7ee787', yellow: '#e3b341',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#76e3ea', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#87deea', brightWhite: '#ffffff',
};

// ── Helpers ──────────────────────────────────────────────────────────

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const isMobile = () => window.innerWidth <= 640;
const isMobileDevice = 'ontouchstart' in window;

function makeLabel(num, folder) {
  return folder ? `${num}: ${folder}` : `${num}`;
}

// ── Dynamic xterm.js loader ─────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) { resolve(); return; }
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadCSS(href) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`link[href="${href}"]`);
    if (existing) { resolve(); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = reject;
    document.head.appendChild(link);
  });
}

async function ensureXterm() {
  if (_xtermLoaded && window.Terminal && window.FitAddon && window.WebLinksAddon) return;

  // Monaco's AMD loader pollutes window.define, causing xterm's UMD wrapper
  // to register as an AMD module instead of setting window.Terminal.
  // Temporarily hide define while loading xterm scripts.
  const savedDefine = window.define;
  window.define = undefined;

  try {
    await loadCSS('https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css');

    // Load xterm first, then addons (they depend on it)
    await loadScript('https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js');

    await Promise.all([
      loadScript('https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js'),
      loadScript('https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.js'),
    ]);

    _xtermLoaded = true;
  } finally {
    window.define = savedDefine;
  }
}

// ── HTML ─────────────────────────────────────────────────────────────

const BODY_HTML = `
  <header>
    <div class="brand">Shell</div>
    <div class="header-meta">
      <span class="pane-count" data-ref="paneCount">0 panes</span>
      <div class="mobile-actions" data-ref="mobileActions">
        <button class="mobile-action-btn" data-action="new-terminal" title="New Terminal">&gt;_</button>
        <button class="mobile-action-btn" data-action="new-browser" title="New Browser">&#x25A1;</button>
      </div>
    </div>
  </header>
  <div class="shell-disconnect-banner" data-ref="disconnect">Disconnected — reconnecting...</div>
  <div class="shell-tab-bar" data-ref="tabBar" role="tablist">
    <button class="shell-tab active" data-tab="grid" role="tab">Dashboard</button>
  </div>
  <div class="shell-pane-container" data-ref="paneContainer" role="tabpanel">
    <div class="shell-empty-state" data-ref="emptyState">
      <div class="hint">No terminals open</div>
      <div class="sub">Use keyboard shortcuts to open a shell or browser</div>
    </div>
  </div>
`;

// ── Refs helper ─────────────────────────────────────────────────────

function getRefs(container) {
  return {
    tabBar: container.querySelector('[data-ref="tabBar"]'),
    paneContainer: container.querySelector('[data-ref="paneContainer"]'),
    emptyState: container.querySelector('[data-ref="emptyState"]'),
    disconnect: container.querySelector('[data-ref="disconnect"]'),
    paneCount: container.querySelector('[data-ref="paneCount"]'),
    mobileActions: container.querySelector('[data-ref="mobileActions"]'),
  };
}

function updatePaneCount(refs) {
  if (!refs.paneCount) return;
  const visible = [...panes.values()].filter(p => !p.element.classList.contains('project-hidden')).length;
  refs.paneCount.textContent = `${visible} pane${visible !== 1 ? 's' : ''}`;
}

// ── Tab management ──────────────────────────────────────────────────

function addTab(refs, id, title) {
  const tab = document.createElement('button');
  tab.className = 'shell-tab';
  tab.dataset.tab = id;
  tab.setAttribute('role', 'tab');

  const label = document.createElement('span');
  label.className = 'shell-tab-label';
  label.textContent = title;

  const closeBtn = document.createElement('span');
  closeBtn.className = 'shell-tab-close';
  closeBtn.textContent = '\u2715';
  closeBtn.setAttribute('aria-label', `Close ${title}`);
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panes.get(id)?.destroy();
  });

  tab.appendChild(label);
  tab.appendChild(closeBtn);
  tab.addEventListener('click', () => setActiveTab(refs, id));
  tab.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      panes.get(id)?.destroy();
    }
  });
  tab.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  refs.tabBar.appendChild(tab);
}

function removeTab(refs, id) {
  refs.tabBar.querySelector(`.shell-tab[data-tab="${id}"]`)?.remove();
}

// ── Navigation helpers ──────────────────────────────────────────────

function getNavigableTabs(refs) {
  return [...refs.tabBar.querySelectorAll('.shell-tab:not(.project-hidden)')]
    .map(t => t.dataset.tab);
}

// ── Active tab ──────────────────────────────────────────────────────

function setActiveTab(refs, tabId) {
  _applyActiveTab(refs, tabId);
  socket.emit('state:set-active-tab', { tabId });
}

function _applyActiveTab(refs, tabId) {
  if (activeTab !== 'grid' && activeTab !== tabId) {
    panes.get(activeTab)?.disableKeyboard?.();
  }

  activeTab = tabId;

  refs.tabBar.querySelectorAll('.shell-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });

  // Scroll the tab into view horizontally only — scrollIntoView() can bubble
  // up and scroll parent containers to the top, causing the terminal to jump.
  const activeTabEl = refs.tabBar.querySelector(`.shell-tab[data-tab="${tabId}"]`);
  if (activeTabEl) {
    const barRect = refs.tabBar.getBoundingClientRect();
    const tabRect = activeTabEl.getBoundingClientRect();
    if (tabRect.left < barRect.left) {
      refs.tabBar.scrollLeft -= barRect.left - tabRect.left + 8;
    } else if (tabRect.right > barRect.right) {
      refs.tabBar.scrollLeft += tabRect.right - barRect.right + 8;
    }
  }

  if (tabId === 'grid') {
    refs.paneContainer.style.gridTemplateRows = '';
    for (const pane of panes.values()) {
      if (!pane.element.classList.contains('project-hidden')) pane.element.style.display = '';
    }
    relayout(refs);
    // Focus the active pane's terminal in grid view (delayed to avoid double-cursor flicker)
    if (!isMobile() && activePaneId) {
      setTimeout(() => {
        panes.get(activePaneId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
      }, 300);
    }
  } else {
    for (const [id, pane] of panes) {
      pane.element.style.display = id === tabId ? '' : 'none';
    }
    refs.emptyState.style.display = 'none';
    refs.paneContainer.style.gridTemplateColumns = '1fr';
    refs.paneContainer.style.gridTemplateRows = '1fr';
    setActivePaneHighlight(tabId);
    requestAnimationFrame(() => {
      document.fonts.ready.then(() => {
        const pane = panes.get(tabId);
        pane?.fit();
        pane?.scrollToBottom();
        if (!isMobile()) {
          pane?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
        }
      });
    });
  }
}

// ── Layout ──────────────────────────────────────────────────────────

function relayout(refs) {
  updatePaneCount(refs);
  const visiblePanes = [...panes.values()].filter(p => !p.element.classList.contains('project-hidden'));
  const count = visiblePanes.length;

  if (count === 0) {
    refs.paneContainer.style.gridTemplateColumns = '';
    refs.emptyState.style.display = 'flex';
    return;
  }
  refs.emptyState.style.display = 'none';

  if (activeTab !== 'grid') return;

  for (const pane of visiblePanes) pane.element.style.display = '';

  const mobile = window.innerWidth <= 640;
  const cols = mobile ? 1 : count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  refs.paneContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  refs.paneContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // Wait for DOM to settle and fonts to load before fitting terminals.
  // rAF ensures layout is flushed, fonts.ready ensures correct metrics.
  requestAnimationFrame(() => {
    document.fonts.ready.then(() => {
      for (const pane of visiblePanes) {
        pane.fit();
      }
    });
  });
}

function setActivePaneHighlight(id) {
  if (activePaneId) panes.get(activePaneId)?.element.classList.remove('active');
  activePaneId = id;
  if (id) panes.get(id)?.element.classList.add('active');
}

// ── Drag-to-reorder helpers ─────────────────────────────────────────

let _draggedPaneId = null;

function _attachDragHandlers(header, wrapper, id) {
  header.addEventListener('dragstart', (e) => {
    // Don't start drag from close button
    if (e.target.closest('.pane-close')) {
      e.preventDefault();
      return;
    }
    _draggedPaneId = id;
    wrapper.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  });

  header.addEventListener('dragend', () => {
    wrapper.classList.remove('dragging');
    _draggedPaneId = null;
    // Clean up all drag-over highlights
    document.querySelectorAll('.page-shell .pane.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  wrapper.addEventListener('dragover', (e) => {
    if (!_draggedPaneId || _draggedPaneId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    wrapper.classList.add('drag-over');
  });

  wrapper.addEventListener('dragleave', (e) => {
    // Only remove if we actually left this pane (not entering a child)
    if (!wrapper.contains(e.relatedTarget)) {
      wrapper.classList.remove('drag-over');
    }
  });

  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    wrapper.classList.remove('drag-over');
    if (!_draggedPaneId || _draggedPaneId === id) return;

    const container = wrapper.parentElement;
    if (!container) return;

    const draggedPane = panes.get(_draggedPaneId);
    const targetPane = panes.get(id);
    if (!draggedPane || !targetPane) return;

    // Swap DOM positions
    const draggedEl = draggedPane.element;
    const targetEl = targetPane.element;
    const draggedNext = draggedEl.nextElementSibling;
    const targetNext = targetEl.nextElementSibling;

    if (draggedNext === targetEl) {
      // Dragged is immediately before target
      container.insertBefore(targetEl, draggedEl);
    } else if (targetNext === draggedEl) {
      // Target is immediately before dragged
      container.insertBefore(draggedEl, targetEl);
    } else {
      // General case: swap positions
      const placeholder = document.createElement('div');
      container.insertBefore(placeholder, draggedEl);
      container.insertBefore(draggedEl, targetNext);
      container.insertBefore(targetEl, placeholder);
      placeholder.remove();
    }

    // Build new order from DOM
    const newOrder = [...container.querySelectorAll('.pane[data-id]')]
      .map(el => el.dataset.id)
      .filter(pid => panes.has(pid));

    // Reorder tabs in the tab bar to match
    const tabBar = document.querySelector('.page-shell .shell-tab-bar');
    if (tabBar) {
      for (const pid of newOrder) {
        const tab = tabBar.querySelector(`.shell-tab[data-tab="${pid}"]`);
        if (tab) tabBar.appendChild(tab);
      }
    }

    // Reorder the in-memory panes Map so remount preserves visual order
    _reorderPanesMap(newOrder);

    // Emit to server for persistence
    socket.emit('state:reorder-panes', { order: newOrder });

    _draggedPaneId = null;
  });
}

/** Reorder the panes Map to match a given ID order (preserves remount order). */
function _reorderPanesMap(order) {
  const snapshot = new Map(panes);
  panes.clear();
  for (const id of order) {
    const p = snapshot.get(id);
    if (p) panes.set(id, p);
  }
  // Append any remaining panes not in the order list
  for (const [id, p] of snapshot) {
    if (!panes.has(id)) panes.set(id, p);
  }
}

// ── Terminal pane creation ──────────────────────────────────────────

function createTerminalPane({ id, shellType, title, onClose, onFocus, skipInitialFit = false, parentElement = null }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pane';
  wrapper.dataset.id = id;

  const header = document.createElement('div');
  header.className = 'pane-header';
  header.draggable = true;

  const titleEl = document.createElement('span');
  titleEl.className = 'pane-title';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.title = 'Close';
  closeBtn.textContent = '\u2715';

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // ── Drag-to-reorder ──────────────────────────────────────────────
  _attachDragHandlers(header, wrapper, id);

  const termDiv = document.createElement('div');
  termDiv.className = 'pane-terminal';

  wrapper.appendChild(header);
  wrapper.appendChild(termDiv);

  // Append to DOM BEFORE opening xterm so the container gets real dimensions.
  if (parentElement) parentElement.appendChild(wrapper);

  // Force synchronous layout reflow — reading offsetHeight makes the browser
  // compute dimensions NOW, before xterm measures the container.  Without this,
  // Windows can hand xterm a 0-height element, producing a permanent black screen.
  void termDiv.offsetHeight;

  // xterm.js
  const term = new window.Terminal({
    theme: TERMINAL_THEME,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  const webLinksAddon = new window.WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  term.open(termDiv);
  // Fit immediately while the synchronous reflow is still fresh, and notify
  // the server of the real dimensions so ConPTY produces output at the right size.
  try {
    fitAddon.fit();
    socket.emit('terminal:resize', { id, cols: term.cols, rows: term.rows });
  } catch {}

  let disposed = false;

  // Alternate screen buffer detection
  term.buffer.onBufferChange((buf) => {
    if (buf.type === 'alternate') {
      termDiv.classList.add('alt-screen');
    } else {
      termDiv.classList.remove('alt-screen');
    }
  });

  // Fallback copy
  function _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    term.focus();
  }

  // Custom key event handler
  term.attachCustomKeyEventHandler((e) => {
    if (typeof KeymapRegistry !== 'undefined') {
      const action = KeymapRegistry.resolve(e);
      if (action && (action.startsWith('shell:') || action.startsWith('voice:'))) return false;
    }

    if (e.type !== 'keydown') return true;

    // Ctrl+C / Ctrl+Shift+C / Cmd+C -> copy
    if ((e.ctrlKey && e.code === 'KeyC' && !e.shiftKey && !e.altKey) ||
        (e.ctrlKey && e.shiftKey && e.code === 'KeyC' && !e.altKey) ||
        (isMac && e.metaKey && e.code === 'KeyC' && !e.altKey)) {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(sel).catch(() => _fallbackCopy(sel));
        } else {
          _fallbackCopy(sel);
        }
        term.clearSelection();
        term.focus();
        return false;
      }
      if (e.shiftKey || (isMac && e.metaKey && !e.ctrlKey)) return false;
    }

    // Ctrl+V / Cmd+V -> paste
    if ((e.ctrlKey || (isMac && e.metaKey)) && e.code === 'KeyV' && !e.altKey) {
      return false;
    }

    return true;
  });

  // Defer fit until element is in DOM and fonts are loaded.
  // Skip during batch creation (snapshot restore) — relayout handles fit after grid is set.
  if (!skipInitialFit) {
    requestAnimationFrame(() => {
      document.fonts.ready.then(() => {
        if (disposed) return;
        fitAddon.fit();
        socket.emit('terminal:resize', { id, cols: term.cols, rows: term.rows });
        term.scrollToBottom();
      });
    });
  }

  // Mobile keyboard management
  if (isMobileDevice) {
    requestAnimationFrame(() => {
      const h = termDiv.querySelector('.xterm-helper-textarea');
      if (!h) return;
      h.setAttribute('inputmode', 'none');
      h.addEventListener('blur', () => h.setAttribute('inputmode', 'none'));
    });
  }

  function disableKeyboard() {
    if (!isMobileDevice) return;
    const h = termDiv.querySelector('.xterm-helper-textarea');
    if (!h) return;
    h.setAttribute('inputmode', 'none');
    h.blur();
  }

  function enableKeyboard() {
    if (!isMobileDevice) return;
    const h = termDiv.querySelector('.xterm-helper-textarea');
    if (h) h.removeAttribute('inputmode');
  }

  // Auto-scroll tracking — only scroll to bottom when user hasn't scrolled up
  let _atBottom = true;
  term.onScroll(() => {
    const buf = term.buffer.active;
    _atBottom = buf.viewportY >= buf.baseY;
  });

  function autoScroll() {
    if (_atBottom) term.scrollToBottom();
  }

  // Socket handlers
  const exitHandler = ({ id: eid, code }) => {
    if (disposed) return;
    if (eid === id) {
      term.write(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
    }
  };

  socket.on('terminal:exit', exitHandler);

  function writeData(data) {
    if (disposed) return;
    term.write(data);
    autoScroll();
  }

  term.onData((data) => {
    if (data) socket.emit('terminal:input', { id, data });
  });

  // Resize observer — suppressed during batch restore to prevent premature fits
  let roTimer;
  const ro = new ResizeObserver(() => {
    if (disposed || _restoring) return;
    clearTimeout(roTimer);
    roTimer = setTimeout(() => {
      if (disposed || _restoring) return;
      try {
        fitAddon.fit();
        autoScroll();
        socket.emit('terminal:resize', { id, cols: term.cols, rows: term.rows });
      } catch {}
    }, 100);
  });
  ro.observe(termDiv);

  // Focus tracking
  let lastTapTime = 0;
  termDiv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      const now = Date.now();
      const doubleTap = now - lastTapTime < 300;
      lastTapTime = now;
      if (doubleTap) {
        enableKeyboard();
        onFocus(id, false);
      } else {
        onFocus(id, true);
      }
    } else {
      onFocus(id, false);
    }
  });

  // Close button
  closeBtn.addEventListener('click', () => destroy());

  function fit() {
    try {
      fitAddon.fit();
      autoScroll();
      socket.emit('terminal:resize', { id, cols: term.cols, rows: term.rows });
    } catch {}
  }

  function sendInput(text) {
    socket.emit('terminal:input', { id, data: text });
    term.focus();
  }

  function destroy() {
    socket.emit('terminal:close', { id });
    onClose(id);
  }

  function cleanup() {
    disposed = true;
    clearTimeout(roTimer);
    socket.off('terminal:exit', exitHandler);
    ro.disconnect();
    term.dispose();
    wrapper.remove();
  }

  function setTitle(text) {
    titleEl.textContent = text;
  }

  function writeScrollback(data) {
    if (!data) return;
    term.write(data, () => {
      // Sync alt-screen class after replay — the onBufferChange event may have
      // been missed if the alt-screen entry sequence was truncated from scrollback.
      if (term.buffer.active.type === 'alternate') {
        termDiv.classList.add('alt-screen');
      } else {
        termDiv.classList.remove('alt-screen');
      }

      // During batch restore, skip — centralized fit + scroll happens after grid is set
      if (_restoring || disposed) return;
      requestAnimationFrame(() => {
        document.fonts.ready.then(() => {
          if (disposed) return;
          if (termDiv.offsetWidth > 0 && termDiv.offsetHeight > 0) {
            fitAddon.fit();
            socket.emit('terminal:resize', { id, cols: term.cols, rows: term.rows });
          }
          _atBottom = true;
          term.scrollToBottom();
        });
      });
    });
  }

  function scrollToBottom() { _atBottom = true; term.scrollToBottom(); }

  function refresh() { term.refresh(0, term.rows - 1); }

  return { id, element: wrapper, term, fit, refresh, sendInput, destroy, cleanup, setTitle, disableKeyboard, writeData, writeScrollback, scrollToBottom };
}

// ── Browser pane creation ───────────────────────────────────────────

function createBrowserPaneLocal({ id, url, title, onClose, onFocus, onTitleChange }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pane pane-browser';
  wrapper.dataset.id = id;

  const header = document.createElement('div');
  header.className = 'pane-header';
  header.draggable = true;

  const titleEl = document.createElement('span');
  titleEl.className = 'pane-title';
  titleEl.textContent = title || 'Browser';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.title = 'Close';
  closeBtn.textContent = '\u2715';

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // ── Drag-to-reorder ──────────────────────────────────────────────
  _attachDragHandlers(header, wrapper, id);

  // Navigation bar
  const navBar = document.createElement('div');
  navBar.className = 'browser-nav';

  const backBtn = document.createElement('button');
  backBtn.className = 'browser-nav-btn';
  backBtn.textContent = '\u2190';
  backBtn.title = 'Back';

  const fwdBtn = document.createElement('button');
  fwdBtn.className = 'browser-nav-btn';
  fwdBtn.textContent = '\u2192';
  fwdBtn.title = 'Forward';

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'browser-nav-btn';
  reloadBtn.textContent = '\u21BB';
  reloadBtn.title = 'Reload';

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'browser-url-input';
  urlInput.value = url || '';
  urlInput.placeholder = 'Enter URL...';
  urlInput.spellcheck = false;

  navBar.append(backBtn, fwdBtn, reloadBtn, urlInput);

  // Iframe
  const iframe = document.createElement('iframe');
  iframe.className = 'browser-iframe';
  iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  iframe.allow = 'autoplay; fullscreen; focus-without-user-activation';
  iframe.setAttribute('referrerpolicy', 'no-referrer');

  // Error overlay
  const errorOverlay = document.createElement('div');
  errorOverlay.className = 'browser-error';
  errorOverlay.style.display = 'none';

  // Loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.className = 'browser-error';
  loadingEl.textContent = 'Loading\u2026';
  loadingEl.style.display = 'none';

  const iframeWrap = document.createElement('div');
  iframeWrap.className = 'browser-viewport';
  iframeWrap.appendChild(iframe);
  iframeWrap.appendChild(errorOverlay);
  iframeWrap.appendChild(loadingEl);

  wrapper.append(header, navBar, iframeWrap);

  // URL rewriting
  function resolveUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const isYouTube = /^(www\.)?youtube\.com$/.test(u.hostname);
      if (isYouTube && u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        if (v) return { url: `https://www.youtube.com/embed/${v}?autoplay=1`, isEmbed: true };
      }
      if (u.hostname === 'youtu.be') {
        const v = u.pathname.slice(1);
        if (v) return { url: `https://www.youtube.com/embed/${v}?autoplay=1`, isEmbed: true };
      }
      if (isYouTube && u.pathname === '/playlist') {
        const list = u.searchParams.get('list');
        if (list) return { url: `https://www.youtube.com/embed/videoseries?list=${list}`, isEmbed: true };
      }
      if (isYouTube || u.hostname === 'youtu.be') {
        return { url: rawUrl, isEmbed: true };
      }
    } catch {}
    return { url: rawUrl, isEmbed: false };
  }

  function _isLocalUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const h = u.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return true;
      if (/^10\./.test(h)) return true;
      if (/^192\.168\./.test(h)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
      return false;
    } catch {}
    return false;
  }

  const CLICK_INTERCEPTOR = '<script>(function(){' +
    'document.addEventListener("click",function(e){' +
      'var a=e.target.closest("a");' +
      'if(a&&a.href){e.preventDefault();e.stopPropagation();' +
      'window.parent.postMessage({type:"proxy-navigate",url:a.href},"*");}' +
    '},true);' +
    'document.addEventListener("submit",function(e){' +
      'e.preventDefault();e.stopPropagation();' +
      'var f=e.target;var url=f.action||window.location.href;' +
      'window.parent.postMessage({type:"proxy-navigate",url:url},"*");' +
    '},true);' +
    'var _open=window.open;window.open=function(url){' +
      'if(url){window.parent.postMessage({type:"proxy-navigate",url:url},"*");}' +
    '};' +
  '})()<\/script>';

  // Navigation logic
  let navHistory = [];
  let historyIdx = -1;
  let loadAbort = null;

  function _extractDomain(rawUrl) {
    try { return new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function _updateTitle(rawUrl) {
    const domain = _extractDomain(rawUrl);
    const label = domain || 'Browser';
    titleEl.textContent = label;
    if (onTitleChange) onTitleChange(id, label);
  }

  function _resolveProtocol(rawUrl) {
    if (/^https?:\/\//i.test(rawUrl) || /^\/\//.test(rawUrl)) return rawUrl;
    if (/^\//.test(rawUrl)) return window.location.origin + rawUrl;
    if (/^(localhost|[\w.-]+\.\w{2,})/.test(rawUrl)) {
      return (/^localhost/.test(rawUrl) ? 'http://' : 'https://') + rawUrl;
    }
    return 'https://' + rawUrl;
  }

  function navigate(newUrl) {
    if (!newUrl) return;
    if (historyIdx < navHistory.length - 1) {
      navHistory = navHistory.slice(0, historyIdx + 1);
    }
    navHistory.push(newUrl);
    historyIdx = navHistory.length - 1;
    urlInput.value = newUrl;
    updateNavButtons();
    _updateTitle(_resolveProtocol(newUrl));
    _loadUrl(newUrl);
  }

  async function _loadUrl(rawUrl) {
    const withProto = _resolveProtocol(rawUrl);
    const resolved = resolveUrl(withProto);
    errorOverlay.style.display = 'none';
    loadingEl.style.display = 'none';

    if (loadAbort) { loadAbort.abort(); loadAbort = null; }

    if (_isLocalUrl(withProto)) {
      iframe.removeAttribute('srcdoc');
      iframe.src = resolved.url;
      return;
    }

    if (resolved.isEmbed) {
      iframe.removeAttribute('srcdoc');
      iframe.src = resolved.url;
      return;
    }

    loadAbort = new AbortController();
    loadingEl.style.display = 'flex';
    iframe.removeAttribute('src');
    iframe.srcdoc = '';

    try {
      const resp = await fetch(`/proxy?url=${encodeURIComponent(resolved.url)}`, {
        signal: loadAbort.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        let msg;
        try { msg = JSON.parse(errBody).error; } catch { msg = `HTTP ${resp.status}`; }
        throw new Error(msg);
      }

      const finalUrl = resp.headers.get('X-Final-URL') || resolved.url;
      let html = await resp.text();

      const u = new URL(finalUrl);
      const basePath = u.pathname.replace(/[^/]*$/, '');
      const baseHref = `${u.protocol}//${u.host}${basePath}`;

      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">${CLICK_INTERCEPTOR}`);
      } else if (/<html[^>]*>/i.test(html)) {
        html = html.replace(/<html([^>]*)>/i, `<html$1><head><base href="${baseHref}">${CLICK_INTERCEPTOR}</head>`);
      } else {
        html = `<head><base href="${baseHref}">${CLICK_INTERCEPTOR}</head>${html}`;
      }

      html = html.replace(/<link[^>]*rel=["']manifest["'][^>]*>/gi, '');
      html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

      if (finalUrl !== resolved.url) {
        urlInput.value = finalUrl;
        if (historyIdx >= 0) navHistory[historyIdx] = finalUrl;
        _updateTitle(finalUrl);
      }

      loadingEl.style.display = 'none';
      iframe.srcdoc = html;
    } catch (err) {
      if (err.name === 'AbortError') return;
      loadingEl.style.display = 'none';
      errorOverlay.textContent = `Failed to load: ${err.message}`;
      errorOverlay.style.display = 'flex';
    } finally {
      loadAbort = null;
    }
  }

  function goBack() {
    if (historyIdx > 0) {
      historyIdx--;
      urlInput.value = navHistory[historyIdx];
      updateNavButtons();
      _updateTitle(_resolveProtocol(navHistory[historyIdx]));
      _loadUrl(navHistory[historyIdx]);
    }
  }

  function goForward() {
    if (historyIdx < navHistory.length - 1) {
      historyIdx++;
      urlInput.value = navHistory[historyIdx];
      updateNavButtons();
      _updateTitle(_resolveProtocol(navHistory[historyIdx]));
      _loadUrl(navHistory[historyIdx]);
    }
  }

  function reload() {
    if (historyIdx >= 0) {
      errorOverlay.style.display = 'none';
      _loadUrl(navHistory[historyIdx]);
    }
  }

  function updateNavButtons() {
    backBtn.disabled = historyIdx <= 0;
    fwdBtn.disabled = historyIdx >= navHistory.length - 1;
  }

  // Handle navigation from injected click interceptor
  const messageHandler = (e) => {
    if (e.source !== iframe.contentWindow) return;
    if (e.data && e.data.type === 'proxy-navigate') {
      navigate(e.data.url);
    }
  };
  window.addEventListener('message', messageHandler);

  // Event handlers
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(urlInput.value.trim());
    }
    e.stopPropagation();
  });

  urlInput.addEventListener('focus', () => urlInput.select());
  backBtn.addEventListener('click', goBack);
  fwdBtn.addEventListener('click', goForward);
  reloadBtn.addEventListener('click', reload);

  iframe.addEventListener('error', () => {
    errorOverlay.textContent = 'Failed to load page';
    errorOverlay.style.display = 'flex';
  });

  // Focus tracking
  wrapper.addEventListener('pointerdown', (e) => {
    const isTouch = e.pointerType === 'touch';
    onFocus(id, isTouch);
  });

  // Close
  closeBtn.addEventListener('click', () => destroy());

  function destroy() {
    socket.emit('terminal:close', { id });
    onClose(id);
  }

  function cleanup() {
    window.removeEventListener('message', messageHandler);
    if (loadAbort) { loadAbort.abort(); loadAbort = null; }
    iframe.removeAttribute('srcdoc');
    iframe.src = 'about:blank';
    wrapper.remove();
  }

  function setTitle(text) { titleEl.textContent = text; }
  function fit() {}
  function scrollToBottom() {}
  function disableKeyboard() {}
  function writeScrollback() {}

  updateNavButtons();
  if (url) navigate(url);

  return {
    id,
    element: wrapper,
    fit,
    sendInput() {},
    destroy,
    cleanup,
    setTitle,
    disableKeyboard,
    writeScrollback,
    scrollToBottom,
  };
}

// ── Server-driven pane lifecycle ────────────────────────────────────

async function _addPaneFromServer(refs, { id, shellType, title, num, cwd, url, projectId }, scrollback, skipRelayout = false) {
  if (panes.has(id)) return;

  // Ensure xterm.js is loaded before creating terminal panes
  if (shellType !== 'browser' && !window.Terminal) {
    await ensureXterm();
    if (!_container) return; // unmounted while waiting
  }

  const onClose = () => { /* state:pane-removed from server handles cleanup */ };
  const onFocus = (focusedId, isTouch = false) => {
    const switching = activePaneId !== focusedId;
    setActivePaneHighlight(focusedId);
    socket.emit('state:set-active-pane', { paneId: focusedId });
    if (switching) panes.get(focusedId)?.scrollToBottom();
    if (!isTouch) {
      panes.get(focusedId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
    }
  };

  const onTitleChange = (paneId, label) => {
    const fullLabel = makeLabel(panes.get(paneId)?._num ?? '', label);
    const tabEl = refs.tabBar.querySelector(`.shell-tab[data-tab="${paneId}"] .shell-tab-label`);
    if (tabEl) tabEl.textContent = fullLabel;
  };

  const browserLabel = url ? undefined : 'Browser';
  const initialLabel = shellType === 'browser' ? makeLabel(num, browserLabel || title) : title;
  const pane = shellType === 'browser'
    ? createBrowserPaneLocal({ id, url, title: initialLabel, onClose, onFocus, onTitleChange })
    : createTerminalPane({ id, shellType, title, onClose, onFocus, skipInitialFit: skipRelayout, parentElement: refs.paneContainer });

  pane._num = num;
  pane._cwd = cwd || null;
  pane._projectId = projectId || null;
  panes.set(id, pane);

  // Terminal panes are already in DOM (parentElement), but browser panes need appending.
  if (shellType === 'browser') refs.paneContainer.appendChild(pane.element);
  addTab(refs, id, initialLabel);

  // Flush any data that arrived while the terminal was being created
  const buffered = pendingData.get(id);
  if (buffered) {
    pane.writeScrollback(buffered.join(''));
    pendingData.delete(id);
  }

  // If CWD is known, show folder in label
  if (cwd) {
    const folder = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '/';
    const label = makeLabel(num, folder);
    pane.setTitle(label);
    const tabEl = refs.tabBar.querySelector(`.shell-tab[data-tab="${id}"] .shell-tab-label`);
    if (tabEl) tabEl.textContent = label;
  }

  if (scrollback) pane.writeScrollback(scrollback);

  if (!skipRelayout) relayout(refs);

  // On Windows, xterm needs a delayed fit + repaint after the pane is in the
  // DOM to get correct dimensions and force visible content.
  if (shellType !== 'browser') {
    setTimeout(() => {
      pane.fit();
      pane.refresh();
    }, 500);
  }
}

function _removePaneLocal(refs, id) {
  const pane = panes.get(id);
  if (!pane) return;

  const keys = [...panes.keys()];
  const closedIdx = keys.indexOf(id);
  const prevKey = closedIdx > 0 ? keys[closedIdx - 1] : keys[closedIdx + 1] ?? null;

  pane.cleanup();
  panes.delete(id);
  pendingData.delete(id);
  removeTab(refs, id);

  if (activePaneId === id) setActivePaneHighlight(prevKey);
  if (activeTab === id) activeTab = 'grid';
  relayout(refs);

  if (activePaneId && activeTab === 'grid') {
    setTimeout(() => {
      panes.get(activePaneId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
    }, 50);
  }
}

// ── Request a new pane ──────────────────────────────────────────────

function requestPane({ shellType, cwd }) {
  // Estimate cols/rows from an existing pane, or from the container + font metrics.
  // Sending the real size at spawn time prevents ConPTY (Windows) from withholding
  // the initial prompt until it receives a resize event.
  let cols = 80, rows = 24;
  const anyPane = panes.values().next().value;
  if (anyPane) {
    cols = anyPane.term?.cols ?? 80;
    rows = anyPane.term?.rows ?? 24;
  } else {
    const container = document.querySelector('.shell-pane-container');
    if (container) {
      const w = container.clientWidth - 16; // subtract padding
      const h = container.clientHeight - 32; // subtract header ~32px
      const charW = 8.5, charH = 17; // approx for 14px monospace
      if (w > 0 && h > 0) { cols = Math.max(40, Math.floor(w / charW)); rows = Math.max(10, Math.floor(h / charH)); }
    }
  }
  socket.emit('terminal:create', {
    shellType,
    cwd: cwd || activeProject?.path || null,
    cols,
    rows,
    currentTab: activeTab,
  });
}

// ── Project filtering ───────────────────────────────────────────────

function _applyProjectFilter(refs) {
  const pid = activeProject?.id || null;
  for (const [id, pane] of panes) {
    const visible = !pid || !pane._projectId || pane._projectId === pid;
    pane.element.classList.toggle('project-hidden', !visible);
    const tab = refs.tabBar.querySelector(`.shell-tab[data-tab="${id}"]`);
    if (tab) tab.classList.toggle('project-hidden', !visible);
  }
}

function _switchProject(refs, newProject) {
  activeProject = newProject;
  _applyProjectFilter(refs);

  if (activeTab !== 'grid') {
    const activePane = panes.get(activeTab);
    if (activePane?.element.classList.contains('project-hidden')) {
      _applyActiveTab(refs, 'grid');
      socket.emit('state:set-active-tab', { tabId: 'grid' });
      return;
    }
  }
  relayout(refs);
}

// ── Wire socket events ──────────────────────────────────────────────

function wireSocketEvents(refs) {
  _socketHandlers['state:snapshot'] = async ({ panes: serverPanes, activeTab: at, activePaneId: ap, scrollbacks, activeProject: snapshotProject }) => {
    const serverIds = new Set(serverPanes.map(p => p.id));

    if (snapshotProject && !activeProject) activeProject = snapshotProject;

    // Pre-configure the grid BEFORE creating panes so that `void termDiv.offsetHeight`
    // inside createTerminalPane returns real dimensions, not 0.  Without this, during
    // snapshot restore the grid has no explicit rows/columns and every terminal opens
    // at 0-height, causing a permanent black screen on Windows.
    const terminalPaneCount = serverPanes.filter(p => p.shellType !== 'browser').length;
    if (terminalPaneCount > 0) {
      refs.emptyState.style.display = 'none';
      const mobile = window.innerWidth <= 640;
      const cols = mobile ? 1 : terminalPaneCount === 1 ? 1 : terminalPaneCount <= 4 ? 2 : 3;
      const rows = Math.ceil(terminalPaneCount / cols);
      refs.paneContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      refs.paneContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      void refs.paneContainer.offsetHeight; // commit the grid layout now
    }

    // Phase 1: Create panes WITHOUT scrollback.  Suppress fits during batch
    // creation so terminals stay at default 80×24 until the grid is set up.
    _restoring = true;
    try {
      for (const paneData of serverPanes) {
        await _addPaneFromServer(refs, paneData, null /* scrollback deferred */, true);
      }

      // Clean up panes that no longer exist on server
      for (const [id, pane] of panes) {
        if (!serverIds.has(id)) {
          pane.cleanup();
          panes.delete(id);
          removeTab(refs, id);
        }
      }

      // Clean up orphan tabs
      for (const tab of refs.tabBar.querySelectorAll('.shell-tab:not([data-tab="grid"])')) {
        if (!serverIds.has(tab.dataset.tab)) tab.remove();
      }
    } finally {
      _restoring = false;
    }

    // Phase 2: Establish grid layout and fit terminals to actual container size.
    _applyProjectFilter(refs);
    _applyActiveTab(refs, at || 'grid');

    // Phase 3: Write scrollback AFTER terminals are fit to correct dimensions.
    // This prevents xterm from baking content at 80×24 (wrong line wrapping).
    // Wait for relayout's deferred fit (rAF → fonts.ready) to complete first.
    requestAnimationFrame(() => {
      document.fonts.ready.then(() => {
        // Fit one more time to be sure dimensions are correct before writing
        for (const pane of panes.values()) pane.fit();

        for (const paneData of serverPanes) {
          const sb = scrollbacks?.[paneData.id];
          if (sb) panes.get(paneData.id)?.writeScrollback(sb);
        }
      });
    });

    // Safety re-fit + repaint after layout fully settles
    setTimeout(() => {
      if (!_container) return;
      for (const pane of panes.values()) {
        pane.fit();
        pane.refresh?.();
      }
    }, 300);

    if (ap) {
      setActivePaneHighlight(ap);
      if ((at || 'grid') === 'grid') {
        setTimeout(() => {
          panes.get(ap)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
        }, 100);
      }
    }
  };

  _socketHandlers['terminal:data'] = ({ id, data }) => {
    const pane = panes.get(id);
    if (pane) {
      pane.writeData(data);
    } else {
      // Buffer data for panes still being created (async)
      if (!pendingData.has(id)) pendingData.set(id, []);
      pendingData.get(id).push(data);
    }
  };

  _socketHandlers['state:pane-added'] = (paneData) => {
    _addPaneFromServer(refs, paneData, null);
  };

  _socketHandlers['state:pane-removed'] = ({ id }) => {
    _removePaneLocal(refs, id);
  };

  _socketHandlers['state:active-tab'] = ({ tabId }) => {
    _applyActiveTab(refs, tabId);
  };

  _socketHandlers['project:active'] = (project) => {
    _switchProject(refs, project);
  };

  _socketHandlers['state:active-pane'] = ({ paneId }) => {
    setActivePaneHighlight(paneId);
    if (paneId && activeTab === 'grid') {
      setTimeout(() => {
        panes.get(paneId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
      }, 50);
    }
  };

  _socketHandlers['terminal:cwd'] = ({ id, cwd }) => {
    const pane = panes.get(id);
    if (!pane) return;
    pane._cwd = cwd;
    const folder = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '/';
    const label = makeLabel(pane._num, folder);
    const tab = refs.tabBar.querySelector(`.shell-tab[data-tab="${id}"]`);
    if (tab) {
      tab.querySelector('.shell-tab-label').textContent = label;
      tab.title = cwd;
    }
    pane.setTitle(label);
  };

  _socketHandlers['state:panes-reordered'] = ({ order }) => {
    if (!Array.isArray(order)) return;
    // Reorder DOM elements to match server order
    for (const id of order) {
      const pane = panes.get(id);
      if (pane && !pane.element.classList.contains('project-hidden')) {
        refs.paneContainer.appendChild(pane.element);
      }
    }
    // Also reorder tabs to match
    for (const id of order) {
      const tab = refs.tabBar.querySelector(`.shell-tab[data-tab="${id}"]`);
      if (tab) refs.tabBar.appendChild(tab);
    }
    // Reorder the in-memory panes Map so remount preserves visual order
    _reorderPanesMap(order);
    // Re-fit after DOM reorder — moving elements can change terminal dimensions
    relayout(refs);
  };

  _socketHandlers['state:panes-renumbered'] = (updates) => {
    for (const { id, num } of updates) {
      const pane = panes.get(id);
      if (!pane) continue;
      pane._num = num;
      const folder = pane._cwd
        ? pane._cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '/'
        : null;
      const label = makeLabel(num, folder);
      pane.setTitle(label);
      const tab = refs.tabBar.querySelector(`.shell-tab[data-tab="${id}"]`);
      if (tab) tab.querySelector('.shell-tab-label').textContent = label;
    }
  };

  _socketHandlers['disconnect'] = () => {
    refs.disconnect.style.display = 'flex';
  };

  _socketHandlers['connect'] = () => {
    refs.disconnect.style.display = 'none';
    // Re-sync after reconnect — snapshot handler safely skips existing panes
    socket.emit('state:request-snapshot');
  };

  // Register all handlers
  for (const [event, handler] of Object.entries(_socketHandlers)) {
    socket.on(event, handler);
  }
}

function unwireSocketEvents() {
  for (const [event, handler] of Object.entries(_socketHandlers)) {
    socket.off(event, handler);
  }
  // Clear the handlers map
  for (const key of Object.keys(_socketHandlers)) {
    delete _socketHandlers[key];
  }
}

// ── Exports ─────────────────────────────────────────────────────────

export async function mount(container, ctx) {
  _container = container;

  // 1. Scope the container
  container.classList.add('page-shell');

  // 2. Build HTML
  container.innerHTML = BODY_HTML;

  // 3. Get refs
  const refs = getRefs(container);

  // 4. Set initial project
  activeProject = ctx?.project || null;

  // 5. Load xterm.js dynamically
  await ensureXterm();

  // Guard: if unmounted while loading xterm, bail out
  if (!_container) return;

  // 6. Wire socket events
  wireSocketEvents(refs);

  if (panes.size > 0) {
    // Reattach existing panes (returning from another page)
    for (const [id, pane] of panes) {
      refs.paneContainer.appendChild(pane.element);
      const title = pane.element.querySelector('.pane-title')?.textContent || '';
      addTab(refs, id, title);
    }
    _applyProjectFilter(refs);
    _applyActiveTab(refs, activeTab);

    // Re-fit after reattachment and auto-focus the active terminal
    requestAnimationFrame(() => {
      document.fonts.ready.then(() => {
        for (const pane of panes.values()) {
          pane.fit();
          pane.scrollToBottom();
        }
        // Delayed focus to avoid double-cursor flicker with apps like Claude Code
        if (!isMobile()) {
          const focusId = activeTab !== 'grid' ? activeTab : activePaneId;
          if (focusId) {
            setTimeout(() => {
              panes.get(focusId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
            }, 300);
          }
        }
      });
    });
  } else {
    // Fresh mount — request snapshot from server
    socket.emit('state:request-snapshot');
  }

  // 7. Wire Grid tab click
  refs.tabBar.querySelector('[data-tab="grid"]').addEventListener('click', () => setActiveTab(refs, 'grid'));

  // 7a. Wire mobile action buttons (new terminal / new browser)
  refs.mobileActions?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'new-terminal') requestPane({ shellType: 'default' });
    if (btn.dataset.action === 'new-browser') socket.emit('browser:create', { url: '', currentTab: activeTab });
  });

  // 7b. Auto-focus active terminal when clicking the shell container background
  container.addEventListener('click', (e) => {
    if (isMobile()) return;
    // Only handle clicks on the container/pane-container background, not on interactive elements
    const target = e.target;
    if (target !== container && target !== refs.paneContainer && !target.matches('.shell-empty-state, .shell-empty-state *')) return;
    const focusId = activeTab !== 'grid' ? activeTab : activePaneId;
    if (focusId) {
      setTimeout(() => {
        panes.get(focusId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
      }, 300);
    }
  });

  // 8. Voice input — listen for voice:result on document
  _voiceHandler = (e) => {
    const text = e.detail?.text;
    if (text && activePaneId) panes.get(activePaneId)?.sendInput(text);
  };
  document.addEventListener('voice:result', _voiceHandler);

  // 9. Keyboard shortcuts
  _keydownHandler = (e) => {
    if (typeof KeymapRegistry === 'undefined') return;
    const action = KeymapRegistry.resolve(e);
    if (!action) return;

    switch (action) {
      case 'shell:terminal-up':
      case 'shell:terminal-down':
      case 'shell:terminal-left':
      case 'shell:terminal-right': {
        e.preventDefault();
        if (activeTab !== 'grid') return;
        const ids = [...panes.entries()]
          .filter(([, p]) => !p.element.classList.contains('project-hidden'))
          .map(([id]) => id);
        if (ids.length === 0) return;
        const idx = ids.indexOf(activePaneId);
        if (idx === -1) return;
        const count = ids.length;
        const mobile = window.innerWidth <= 640;
        const cols = mobile ? 1 : count === 1 ? 1 : count <= 4 ? 2 : 3;
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        let target = idx;
        if (action === 'shell:terminal-right') target = row * cols + Math.min(col + 1, Math.min(cols, count - row * cols) - 1);
        else if (action === 'shell:terminal-left') target = row * cols + Math.max(col - 1, 0);
        else if (action === 'shell:terminal-down') {
          const below = (row + 1) * cols + col;
          target = below < count ? below : idx;
        } else if (action === 'shell:terminal-up') {
          const above = (row - 1) * cols + col;
          target = above >= 0 ? above : idx;
        }
        if (target === idx) break;
        const targetId = ids[target];
        setActivePaneHighlight(targetId);
        socket.emit('state:set-active-pane', { paneId: targetId });
        panes.get(targetId)?.scrollToBottom();
        panes.get(targetId)?.element.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
        break;
      }
      case 'shell:new-terminal': {
        e.preventDefault();
        requestPane({ shellType: 'default' });
        break;
      }
      case 'shell:new-browser': {
        e.preventDefault();
        socket.emit('browser:create', { url: '', currentTab: activeTab });
        break;
      }
      case 'shell:close-pane': {
        e.preventDefault();
        if (activePaneId) panes.get(activePaneId)?.destroy();
        break;
      }
      default: {
        const termMatch = action.match(/^shell:terminal-(\d)$/);
        if (termMatch) {
          e.preventDefault();
          const num = parseInt(termMatch[1]);
          const termTabs = [...refs.tabBar.querySelectorAll('.shell-tab:not(.project-hidden)')]
            .map(t => t.dataset.tab)
            .filter(id => id !== 'grid');
          const targetId = termTabs[num - 1];
          if (targetId) setActiveTab(refs, targetId);
        }
        break;
      }
    }
  };
  document.addEventListener('keydown', _keydownHandler);

  // 10. Swipe navigation (mobile)
  let touchStartX = 0;
  refs.paneContainer.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  refs.paneContainer.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) >= 50) {
      const ids = getNavigableTabs(refs);
      const idx = ids.indexOf(activeTab);
      if (idx === -1) return;
      const next = dx < 0
        ? (idx + 1) % ids.length
        : (idx - 1 + ids.length) % ids.length;
      setActiveTab(refs, ids[next]);
    }
  }, { passive: true });

  // 11. Window resize handler
  const resizeHandler = () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => relayout(refs), 100);
  };
  window.addEventListener('resize', resizeHandler);
  // Store for cleanup
  _container._resizeHandler = resizeHandler;

  _mountedOnce = true;
}

export function unmount(container) {
  // 1. Remove keyboard handler
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }

  // 2. Remove voice handler
  if (_voiceHandler) {
    document.removeEventListener('voice:result', _voiceHandler);
    _voiceHandler = null;
  }

  // 3. Remove resize handler
  if (container._resizeHandler) {
    window.removeEventListener('resize', container._resizeHandler);
    container._resizeHandler = null;
  }
  clearTimeout(_resizeTimer);
  _resizeTimer = null;

  // 4. Unwire module-level socket events (per-pane handlers stay wired)
  unwireSocketEvents();

  // 5. Detach pane elements (keep xterm instances alive for reattachment)
  for (const [, pane] of panes) {
    pane.element.remove();
  }
  // Don't clear panes, activePaneId, or activeTab — they persist across navigations

  // 6. Remove scope class & clear HTML
  _restoring = false;
  container.classList.remove('page-shell');
  container.innerHTML = '';

  // 7. Clear module reference
  _container = null;
}

export function onProjectChange(project) {
  activeProject = project;
  if (!_container) return;
  const refs = getRefs(_container);
  _applyProjectFilter(refs);

  if (activeTab !== 'grid') {
    const activePane = panes.get(activeTab);
    if (activePane?.element.classList.contains('project-hidden')) {
      _applyActiveTab(refs, 'grid');
      socket.emit('state:set-active-tab', { tabId: 'grid' });
      return;
    }
  }
  relayout(refs);
}
