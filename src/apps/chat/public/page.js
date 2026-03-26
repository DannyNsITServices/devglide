// ── Chat App — Page Module ────────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).

import { escapeHtml, escapeAttr, sanitizeHtml } from '/shared-assets/ui-utils.js';
import { dashboardSocket } from '/state.js';
import { createHeader } from '/shared-ui/components/header.js';
import { getMentionMatches, getPipeAssigneeMatches } from './mention-suggestions.js';

let _container = null;
let _socket = null;
let _members = [];
let _messages = [];
let _autoScroll = true;
let _mentionIdx = -1;
let _voiceHandler = null;
let _rulesDraft = '';
let _rulesLoaded = false;
let _tooltipTarget = null;

// Pipe slash-command state
const PIPE_COMMANDS = [
  { name: '/linear-pipe', hint: 'min 2 assignees', description: 'Sequential processing chain' },
  { name: '/merge-pipe', hint: 'min 3 assignees', description: 'Parallel fan-out + synthesizer' },
  { name: '/merge-all-pipe', hint: 'min 2 assignees', description: 'Parallel fan-out (all) + synthesizer' },
];
let _popupMode = 'none'; // 'none' | 'command' | 'mention'

const DRAFT_KEY_PREFIX = 'devglide-chat-draft';
let _projectId = null;
let _markedReady = false;
let _mermaidReady = false;
let _mermaidFailed = false;
let _mermaidIdCounter = 0;

function draftKey(projectId) {
  return projectId ? `${DRAFT_KEY_PREFIX}:${projectId}` : DRAFT_KEY_PREFIX;
}

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window[globalName]) { resolve(); return; }
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });
}

function initMarked() {
  if (typeof marked === 'undefined' || !marked.use) return;
  const dangerousUrlRe = /^\s*(javascript|vbscript|data)\s*:/i;
  marked.use({
    breaks: true,
    renderer: {
      html({ text }) { return escapeHtml(text); },
      code({ text, lang }) {
        // Mermaid blocks: emit a placeholder that renderMermaidBlocks() will process
        // after sanitization (since sanitizeHtml strips SVG).
        if (lang === 'mermaid') {
          const encoded = escapeAttr(text);
          return `<div class="chat-mermaid-pending" data-mermaid-src="${encoded}"></div>`;
        }
        const escaped = escapeHtml(text);
        const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : '';
        const langLabel = lang ? `<span class="chat-code-lang">${escapeHtml(lang)}</span>` : '';
        return `<pre class="chat-codeblock">${langLabel}<code${langClass}>${escaped}</code></pre>`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        if (dangerousUrlRe.test(href)) return text;
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
      },
      image({ href, title, text }) {
        if (dangerousUrlRe.test(href)) return escapeHtml(text);
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        return `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}"${titleAttr}>`;
      },
    },
  });
  _markedReady = true;
}

/** Render a message body as sanitized markdown HTML, preserving @mention highlights. */
function renderMarkdown(text) {
  if (!_markedReady || !text) return escapeHtml(text || '');
  try {
    const html = sanitizeHtml(marked.parse(text));
    // Highlight @mentions in text nodes only (not inside attributes or code blocks)
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE']);
    const walker = doc.createTreeWalker(doc.body.firstChild, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let parent = node.parentElement;
        while (parent && parent !== doc.body.firstChild) {
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    const mentionRe = /@([\w-]+)/g;
    for (const tNode of textNodes) {
      const val = tNode.nodeValue;
      if (!mentionRe.test(val)) continue;
      mentionRe.lastIndex = 0;
      const frag = doc.createDocumentFragment();
      let lastIdx = 0;
      let m;
      while ((m = mentionRe.exec(val)) !== null) {
        if (m.index > lastIdx) frag.appendChild(doc.createTextNode(val.slice(lastIdx, m.index)));
        const span = doc.createElement('span');
        span.className = 'chat-mention';
        span.textContent = m[0];
        frag.appendChild(span);
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < val.length) frag.appendChild(doc.createTextNode(val.slice(lastIdx)));
      tNode.parentNode.replaceChild(frag, tNode);
    }
    return doc.body.firstChild.innerHTML;
  } catch {
    return escapeHtml(text);
  }
}

/** Initialize Mermaid with DevGlide dark theme. */
function initMermaid() {
  if (typeof mermaid === 'undefined' || !mermaid.initialize) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: 'transparent',
      primaryColor: '#1a3a3a',
      primaryTextColor: '#adbac7',
      primaryBorderColor: '#00afaf',
      secondaryColor: '#2d333b',
      secondaryTextColor: '#adbac7',
      secondaryBorderColor: '#373e47',
      tertiaryColor: '#22272e',
      tertiaryTextColor: '#adbac7',
      lineColor: '#00afaf',
      textColor: '#adbac7',
      mainBkg: '#1a3a3a',
      nodeBorder: '#00afaf',
      clusterBkg: '#22272e',
      clusterBorder: '#373e47',
      titleColor: '#adbac7',
      edgeLabelBackground: '#2d333b',
      nodeTextColor: '#adbac7',
    },
    flowchart: { curve: 'basis', padding: 12 },
    fontFamily: 'var(--df-font-mono, monospace)',
    fontSize: 13,
  });
  _mermaidReady = true;
}

/**
 * Find all pending mermaid placeholders in a container and render them.
 * Placeholders are <div class="chat-mermaid-pending" data-mermaid-src="...">
 * produced by the marked renderer. This runs AFTER sanitizeHtml so the
 * generated SVG is never stripped.
 */
async function renderMermaidBlocks(root) {
  if (!_mermaidReady) {
    // If mermaid load already failed, fall back immediately for new messages
    if (_mermaidFailed) {
      const pending = (root || _container)?.querySelectorAll('.chat-mermaid-pending');
      if (pending?.length) {
        for (const el of pending) {
          const src = el.getAttribute('data-mermaid-src') || '';
          const pre = document.createElement('pre');
          pre.className = 'chat-codeblock';
          const langLabel = document.createElement('span');
          langLabel.className = 'chat-code-lang';
          langLabel.textContent = 'mermaid';
          const code = document.createElement('code');
          code.className = 'language-mermaid';
          code.textContent = src;
          pre.appendChild(langLabel);
          pre.appendChild(code);
          el.replaceWith(pre);
        }
      }
    }
    return;
  }
  const pending = (root || _container)?.querySelectorAll('.chat-mermaid-pending');
  if (!pending?.length) return;

  for (const el of pending) {
    const src = el.getAttribute('data-mermaid-src');
    if (!src) continue;
    const id = `chat-mermaid-${_mermaidIdCounter++}`;
    try {
      const { svg } = await mermaid.render(id, src);
      el.className = 'chat-mermaid-rendered';
      el.removeAttribute('data-mermaid-src');
      el.innerHTML = svg;
    } catch {
      // Fallback: show source as a regular code block
      el.className = '';
      const pre = document.createElement('pre');
      pre.className = 'chat-codeblock';
      const langLabel = document.createElement('span');
      langLabel.className = 'chat-code-lang';
      langLabel.textContent = 'mermaid';
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = src;
      pre.appendChild(langLabel);
      pre.appendChild(code);
      el.replaceWith(pre);
    }
  }
}

/**
 * Convert all pending mermaid placeholders to code-block fallbacks.
 * Called when mermaid.js fails to load (CDN blocked, offline, CSP, etc.).
 */
function fallbackAllMermaidBlocks() {
  const pending = _container?.querySelectorAll('.chat-mermaid-pending');
  if (!pending?.length) return;
  for (const el of pending) {
    const src = el.getAttribute('data-mermaid-src') || '';
    const pre = document.createElement('pre');
    pre.className = 'chat-codeblock';
    const langLabel = document.createElement('span');
    langLabel.className = 'chat-code-lang';
    langLabel.textContent = 'mermaid';
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = src;
    pre.appendChild(langLabel);
    pre.appendChild(code);
    el.replaceWith(pre);
  }
}

// ── Participant colors ──────────────────────────────────────────────
// Distinct hues keyed by visible pane number so participant colors stay
// stable across refreshes and independent of join order.

const PANE_COLORS = new Map([
  [1, '#60a5fa'], // blue
  [2, '#f472b6'], // pink
  [3, '#34d399'], // emerald
  [4, '#fb923c'], // orange
  [5, '#a78bfa'], // violet
  [6, '#22d3ee'], // cyan
  [7, '#fbbf24'], // amber
  [8, '#e879f9'], // fuchsia
  [9, '#f87171'], // red
]);
const DEFAULT_PARTICIPANT_COLOR = 'var(--df-color-text-muted)';

function getParticipantColor(participant) {
  // Use paneNum (per-project display number) from the server — this is the
  // same number used to derive the participant name, keeping colors aligned.
  const paneNumber = participant?.paneNum ?? null;
  return PANE_COLORS.get(paneNumber) ?? DEFAULT_PARTICIPANT_COLOR;
}

function findParticipant(name) {
  return _members.find((member) => member.name === name) ?? { name, paneId: null };
}

function createMemberStatusIndicator(state) {
  const indicator = document.createElement('span');
  indicator.className = `chat-member-status ${state}`;
  const tooltip = state === 'working' ? 'Working' : 'Idle';
  indicator.dataset.chatTooltip = tooltip;
  indicator.setAttribute('aria-label', tooltip);
  indicator.innerHTML = state === 'working'
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor"></circle></svg>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"></circle></svg>`;
  return indicator;
}

function getModeTitle(mode) {
  return mode === 'auto-accept'
    ? 'Auto mode: no approval prompts'
    : mode === 'unrestricted'
      ? 'Unrestricted mode: all permission checks bypassed'
      : 'Safe mode: approval prompts enabled';
}

function getModeIconSvg(mode) {
  if (mode === 'supervised') {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5 13 3.5v3.6c0 3.1-2 5.7-5 7.4-3-1.7-5-4.3-5-7.4V3.5l5-2Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>
        <path d="m5.8 8.2 1.4 1.4 3-3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>`;
  }

  return `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.2 14 13H2L8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>
      <path d="M8 5.8v3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>
      <circle cx="8" cy="11.7" r=".9" fill="currentColor"></circle>
    </svg>`;
}

function createMemberModeIndicator(mode) {
  const indicator = document.createElement('span');
  indicator.className = `chat-member-badge ${mode}`;
  const tooltip = getModeTitle(mode);
  indicator.dataset.chatTooltip = tooltip;
  indicator.setAttribute('aria-label', tooltip);
  indicator.innerHTML = getModeIconSvg(mode);
  return indicator;
}

function createMemberDetachedIndicator() {
  const indicator = document.createElement('span');
  indicator.className = 'chat-member-status detached';
  const tooltip = 'Detached: MCP session closed, waiting for reclaim';
  indicator.dataset.chatTooltip = tooltip;
  indicator.setAttribute('aria-label', tooltip);
  indicator.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor"></circle></svg>`;
  return indicator;
}

// ── Custom tooltip ──────────────────────────────────────────────────

function showTooltip(target) {
  const el = _container?.querySelector('#chat-tooltip');
  const text = target?.dataset?.chatTooltip;
  if (!el || !text) return;

  el.textContent = text;
  el.classList.remove('hidden');

  const rect = target.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const gap = 6;
  let top = rect.top - tipRect.height - gap;
  let left = rect.left + (rect.width / 2) - (tipRect.width / 2);

  if (top < gap) top = rect.bottom + gap;
  left = Math.max(gap, Math.min(left, window.innerWidth - tipRect.width - gap));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  _tooltipTarget = target;
}

function hideTooltip() {
  const el = _container?.querySelector('#chat-tooltip');
  if (!el) return;
  el.classList.add('hidden');
  el.textContent = '';
  _tooltipTarget = null;
}

function onTooltipOver(e) {
  const target = e.target?.closest?.('[data-chat-tooltip]');
  if (!target || target === _tooltipTarget) return;
  showTooltip(target);
}

function onTooltipOut(e) {
  const target = e.target?.closest?.('[data-chat-tooltip]');
  if (!target) return;
  if (target.contains(e.relatedTarget)) return;
  if (_tooltipTarget === target) hideTooltip();
}

// ── API helpers ─────────────────────────────────────────────────────

async function api(path, opts) {
  return fetch('/api/chat' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ── HTML ────────────────────────────────────────────────────────────

const BODY_HTML = `
  ${createHeader({
    brand: 'Chat',
    meta: '<span id="chat-member-count"></span>',
    actions: `
      <button class="btn btn-secondary btn-sm" id="chat-btn-rules">Rules</button>
      <button class="btn btn-secondary btn-sm" id="chat-btn-clear">Clear</button>
    `,
  })}

  <main>
    <div class="chat-members-panel" id="chat-members-panel">
      <div class="chat-members-toolbar">
        <div class="chat-members-title" id="chat-members-title">Members (0)</div>
      </div>
      <div id="chat-members-list"></div>
    </div>

    <div class="chat-messages-area">
      <div class="chat-messages-list" id="chat-messages-list"></div>
      <div class="chat-new-indicator hidden" id="chat-new-indicator">New messages below</div>
      <div class="chat-input-area" style="position:relative">
        <div class="chat-mention-popup hidden" id="chat-mention-popup"></div>
        <textarea class="chat-input" id="chat-input" rows="1" placeholder="Type a message... (@mention to signal who should act)" autocomplete="off"></textarea>
        <button class="btn btn-primary btn-sm chat-send-btn" id="chat-send-btn">Send</button>
      </div>
    </div>
  </main>

  <div class="chat-rules-overlay hidden" id="chat-rules-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-rules-title">
    <div class="chat-rules-modal">
      <div class="chat-rules-header">
        <div>
          <h2 id="chat-rules-title">Rules Of Engagement</h2>
          <p class="chat-rules-desc">Broadcast keeps every LLM in sync. These rules decide when an LLM is allowed to reply.</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="chat-rules-close" aria-label="Close rules editor">Close</button>
      </div>
      <div class="chat-rules-body">
        <div class="chat-rules-note">
          Project rules override the built-in default. Reset removes the project override and falls back to the default rules.
        </div>
        <div class="chat-rules-status hidden" id="chat-rules-status"></div>
        <textarea class="chat-rules-textarea" id="chat-rules-textarea" rows="16" spellcheck="false" placeholder="Chat rules markdown"></textarea>
      </div>
      <div class="chat-rules-actions">
        <button class="btn btn-secondary btn-sm" id="chat-rules-reset">Reset To Default</button>
        <button class="btn btn-primary btn-sm" id="chat-rules-save">Save Rules</button>
      </div>
    </div>
  </div>

  <div class="chat-tooltip hidden" id="chat-tooltip" role="tooltip"></div>
`;

// ── Socket setup ────────────────────────────────────────────────────
// Reuse the shared dashboard socket (same default namespace used by shell,
// dashboard, etc.) instead of opening a separate connection.

function connectSocket() {
  if (_socket) return;
  _socket = dashboardSocket;

  _socket.on('chat:members', onMembers);
  _socket.on('chat:join', onJoin);
  _socket.on('chat:leave', onLeave);
  _socket.on('chat:message', onMessage);
  _socket.on('chat:cleared', onCleared);
  _socket.on('chat:pipe', onPipeEvent);
  _socket.on('chat:error', onError);
}

function disconnectSocket() {
  if (_socket) {
    _socket.off('chat:members', onMembers);
    _socket.off('chat:join', onJoin);
    _socket.off('chat:leave', onLeave);
    _socket.off('chat:message', onMessage);
    _socket.off('chat:cleared', onCleared);
    _socket.off('chat:pipe', onPipeEvent);
    _socket.off('chat:error', onError);
    // Don't disconnect — shared socket, other pages need it
    _socket = null;
  }
}

function onPipeEvent(event) {
  // Pipe events are informational for now — the UI reacts to messages with pipe metadata.
  // Future: could show a live pipe progress indicator in the header.
}

function onMembers(members) {
  _members = members;
  renderMembers();
}

function onJoin(participant) {
  const existing = _members.findIndex(m => m.name === participant.name);
  if (existing >= 0) _members[existing] = participant;
  else _members.push(participant);
  renderMembers();
}

function onLeave({ name }) {
  _members = _members.filter(m => m.name !== name);
  renderMembers();
}

function onMessage(msg) {
  // Deduplicate by id
  if (_messages.some(m => m.id === msg.id)) return;
  _messages.push(msg);
  appendMessageEl(msg);
}

function onError(payload) {
  if (!payload?.error) return;
  onMessage({
    id: `local-error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    from: 'system',
    to: null,
    body: payload.error,
    type: 'system',
  });
}

function onCleared() {
  _messages = [];
  renderAllMessages();
}


// ── Rendering: Members ──────────────────────────────────────────────

function renderMembers() {
  const listEl = _container?.querySelector('#chat-members-list');
  const titleEl = _container?.querySelector('#chat-members-title');
  const countEl = _container?.querySelector('#chat-member-count');
  if (!listEl) return;

  // Always show "user" at top
  const allMembers = [
    { name: 'user', kind: 'user', paneId: null, isUser: true },
    ..._members.filter(m => m.name !== 'user'),
  ];

  const onlineCount = allMembers.filter(m => m.isUser || !m.detached).length;
  if (titleEl) titleEl.textContent = `Members (${allMembers.length})`;
  if (countEl) countEl.textContent = `${onlineCount} online`;

  listEl.innerHTML = '';
  for (const m of allMembers) {
    const item = document.createElement('div');
    item.className = 'chat-member-item';

    const dot = document.createElement('span');
    const isConnected = m.isUser || (m.paneId && !m.detached);
    dot.className = 'chat-member-dot ' + (isConnected ? 'connected' : m.detached ? 'detached' : 'disconnected');

    const body = document.createElement('div');
    body.className = 'chat-member-body';

    const name = document.createElement('span');
    name.className = 'chat-member-name';
    name.textContent = m.name;

    const meta = document.createElement('div');
    meta.className = 'chat-member-meta';

    // Assign unique color to LLM participants (skip dot color for detached — let CSS handle it)
    if (!m.isUser) {
      const color = getParticipantColor(m);
      if (!m.detached) dot.style.background = color;
    }

    body.appendChild(name);

    if (m.isUser) {
      const tag = document.createElement('span');
      tag.className = 'chat-member-tag';
      tag.textContent = 'You';
      meta.appendChild(tag);
    } else if (m.detached) {
      meta.appendChild(createMemberDetachedIndicator());
    } else {
      const state = m.status || 'idle';
      meta.appendChild(createMemberStatusIndicator(state));
    }

    if (!m.isUser) {
      meta.appendChild(createMemberModeIndicator(m.permissionMode || 'supervised'));
    }

    body.appendChild(meta);
    item.appendChild(dot);
    item.appendChild(body);
    listEl.appendChild(item);
  }
}

// ── Rendering: Messages ─────────────────────────────────────────────

function renderAllMessages() {
  const listEl = _container?.querySelector('#chat-messages-list');
  if (!listEl) return;

  listEl.innerHTML = '';
  if (_messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty-state';
    empty.innerHTML = `
      <div class="chat-empty-icon">\u275D</div>
      <div>No messages yet</div>
      <div class="chat-empty-hint">Send a message or have an LLM join with chat_join</div>
    `;
    listEl.appendChild(empty);
    return;
  }

  for (const msg of _messages) {
    appendMessageEl(msg, false);
  }
  renderMermaidBlocks();
  scrollToBottom();
}

function appendMessageEl(msg, doScroll = true) {
  const listEl = _container?.querySelector('#chat-messages-list');
  if (!listEl) return;

  // Hide pipe control delivery messages (handoff/fan-out/synth prompts) from normal chat view
  const pipeRole = msg.pipe?.role;
  if (pipeRole && msg.type === 'system' && ['handoff', 'fan-out-request', 'synth-request'].includes(pipeRole)) return;

  // Remove empty state if present
  const empty = listEl.querySelector('.chat-empty-state');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.dataset.id = msg.id;

  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave') {
    el.classList.add('from-system');
    el.textContent = msg.body;
  } else if (msg.from === 'user') {
    el.classList.add('from-user');
    const body = document.createElement('div');
    body.className = 'chat-msg-body chat-markdown';
    body.innerHTML = renderMarkdown(msg.body);
    const time = document.createElement('div');
    time.className = 'chat-msg-time';
    time.textContent = formatTime(msg.ts);
    el.appendChild(body);
    el.appendChild(time);
  } else if (pipeRole && pipeRole !== 'final' && ['stage-output', 'fan-out'].includes(pipeRole)) {
    // ── Pipe intermediate: collapsed (expandable) ──
    el.classList.add('from-llm', 'chat-pipe-intermediate');
    const color = getParticipantColor(findParticipant(msg.from));
    el.style.borderLeftColor = color;

    const stageLabel = msg.pipe.stage ? ` stage ${msg.pipe.stage}` : '';
    const collapsed = document.createElement('div');
    collapsed.className = 'chat-pipe-collapsed';
    collapsed.innerHTML = `<span class="chat-pipe-badge">#pipe-${escapeHtml(msg.pipe.pipeId)}${escapeHtml(stageLabel)}</span> <span style="color:${escapeAttr(color)}">${escapeHtml(msg.from)}</span> responded`;
    collapsed.style.cursor = 'pointer';
    collapsed.addEventListener('click', () => {
      const expanded = el.querySelector('.chat-pipe-expanded');
      if (expanded) expanded.classList.toggle('hidden');
      collapsed.classList.toggle('chat-pipe-collapsed-open');
    });

    const expanded = document.createElement('div');
    expanded.className = 'chat-pipe-expanded hidden';
    const body = document.createElement('div');
    body.className = 'chat-msg-body chat-markdown';
    body.innerHTML = renderMarkdown(msg.body);
    expanded.appendChild(body);

    el.appendChild(collapsed);
    el.appendChild(expanded);
  } else {
    // ── Regular LLM message or pipe final ──
    el.classList.add('from-llm');
    const color = getParticipantColor(findParticipant(msg.from));
    el.style.borderLeftColor = color;
    const sender = document.createElement('div');
    sender.className = 'chat-msg-sender';
    sender.style.color = color;
    let senderText = msg.from + (msg.to ? ` \u2192 ${msg.to}` : '');
    sender.textContent = senderText;

    // Add pipe result badge if final
    if (pipeRole === 'final') {
      const badge = document.createElement('span');
      badge.className = 'chat-pipe-badge chat-pipe-badge-final';
      badge.textContent = `#pipe-${msg.pipe.pipeId} result`;
      sender.appendChild(document.createTextNode(' '));
      sender.appendChild(badge);
    }

    const body = document.createElement('div');
    body.className = 'chat-msg-body chat-markdown';
    body.innerHTML = renderMarkdown(msg.body);
    const time = document.createElement('div');
    time.className = 'chat-msg-time';
    time.textContent = formatTime(msg.ts);
    el.appendChild(sender);
    el.appendChild(body);
    el.appendChild(time);
  }


  listEl.appendChild(el);
  renderMermaidBlocks(el);

  if (doScroll) {
    if (_autoScroll) {
      scrollToBottom();
    } else {
      showNewIndicator();
    }
  }
}


function formatTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function scrollToBottom() {
  const listEl = _container?.querySelector('#chat-messages-list');
  if (listEl) {
    listEl.scrollTop = listEl.scrollHeight;
  }
  hideNewIndicator();
}

function showNewIndicator() {
  const el = _container?.querySelector('#chat-new-indicator');
  if (el) el.classList.remove('hidden');
}

function hideNewIndicator() {
  const el = _container?.querySelector('#chat-new-indicator');
  if (el) el.classList.add('hidden');
}

function setRulesStatus(message, tone = 'info') {
  const el = _container?.querySelector('#chat-rules-status');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.className = 'chat-rules-status hidden';
    return;
  }
  el.textContent = message;
  el.className = `chat-rules-status ${tone}`;
}

function syncRulesDraftFromInput() {
  const textarea = _container?.querySelector('#chat-rules-textarea');
  if (!textarea) return;
  _rulesDraft = textarea.value;
}

async function loadRules(force = false) {
  if (_rulesLoaded && !force) return true;
  setRulesStatus('Loading rules...');
  try {
    const res = await api('/rules');
    const data = await parseJsonSafely(res);
    if (!res.ok) throw new Error(data?.error || 'Failed to load rules');

    const rules = typeof data?.rules === 'string' ? data.rules : '';
    _rulesDraft = rules;
    _rulesLoaded = true;
    const textarea = _container?.querySelector('#chat-rules-textarea');
    if (textarea) textarea.value = rules;
    setRulesStatus(data?.isDefault ? 'Loaded default rules.' : 'Loaded project override rules.');
    return true;
  } catch (err) {
    setRulesStatus(err instanceof Error ? err.message : 'Failed to load rules.', 'error');
    return false;
  }
}

async function openRulesEditor() {
  const overlay = _container?.querySelector('#chat-rules-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const ok = await loadRules();
  if (ok) _container?.querySelector('#chat-rules-textarea')?.focus();
}

function closeRulesEditor() {
  _container?.querySelector('#chat-rules-overlay')?.classList.add('hidden');
}

async function saveRules() {
  syncRulesDraftFromInput();
  setRulesStatus('Saving rules...');
  try {
    const res = await api('/rules', {
      method: 'PUT',
      body: JSON.stringify({ rules: _rulesDraft }),
    });
    const data = await parseJsonSafely(res);
    if (!res.ok) throw new Error(data?.error || 'Failed to save rules');
    _rulesLoaded = true;
    setRulesStatus('Project rules saved.', 'success');
  } catch (err) {
    setRulesStatus(err instanceof Error ? err.message : 'Failed to save rules.', 'error');
  }
}

async function resetRules() {
  setRulesStatus('Resetting rules...');
  try {
    const res = await api('/rules', { method: 'DELETE' });
    const data = await parseJsonSafely(res);
    if (!res.ok) throw new Error(data?.error || 'Failed to reset rules');
    _rulesLoaded = false;
    await loadRules(true);
    setRulesStatus('Project override removed. Using default rules.', 'success');
  } catch (err) {
    setRulesStatus(err instanceof Error ? err.message : 'Failed to reset rules.', 'error');
  }
}

// ── Input handling ──────────────────────────────────────────────────

function autoResizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function sendMessage() {
  const input = _container?.querySelector('#chat-input');
  if (!input) return;
  if (!input.value.trim()) return;
  const text = input.value;

  input.value = '';
  autoResizeInput(input);
  sessionStorage.removeItem(draftKey(_projectId));
  closeMentionPopup();
  input.focus();

  // Let the server resolve all @mentions from the message body
  _socket.emit('chat:send', { message: text });
}

// ── @mention autocomplete ───────────────────────────────────────────

function onInputChange(e) {
  const input = e.target;
  autoResizeInput(input);
  const val = input.value;
  const cursorPos = input.selectionStart;
  const before = val.substring(0, cursorPos);

  // ── Slash command autocomplete ──
  // If input starts with '/' and no space yet, suggest pipe commands
  const slashMatch = before.match(/^\/(\S*)$/);
  if (slashMatch) {
    const query = slashMatch[1].toLowerCase();
    const matches = PIPE_COMMANDS.filter(c => c.name.substring(1).startsWith(query));
    if (matches.length > 0) {
      showCommandPopup(matches);
      return;
    }
  }

  // ── Pipe assignee autocomplete ──
  // If inside a pipe command (before ':'), autocomplete @mentions for connected LLM members only
  const pipeAssigneeMatch = before.match(/^\/(linear-pipe|merge-pipe|merge-all-pipe)\s+[^:]*@(\w*)$/);
  if (pipeAssigneeMatch) {
    const query = pipeAssigneeMatch[2].toLowerCase();
    const matches = getPipeAssigneeMatches(_members, query);
    if (matches.length > 0) {
      const atIdx = before.lastIndexOf('@');
      showMentionPopup(matches, atIdx);
      return;
    }
  }

  // ── Regular @mention autocomplete ──
  const atMatch = before.match(/@(\w*)$/);
  if (atMatch) {
    const query = atMatch[1].toLowerCase();
    const matches = getMentionMatches(_members, query);

    if (matches.length > 0) {
      showMentionPopup(matches, atMatch.index);
      return;
    }
  }

  closeMentionPopup();
}

function showCommandPopup(commands) {
  const popup = _container?.querySelector('#chat-mention-popup');
  if (!popup) return;

  _mentionIdx = 0;
  _popupMode = 'command';
  popup.innerHTML = '';
  popup.classList.remove('hidden');

  for (let i = 0; i < commands.length; i++) {
    const item = document.createElement('div');
    item.className = 'chat-mention-item' + (i === 0 ? ' selected' : '');
    item.innerHTML = `<span style="font-weight:600">${escapeHtml(commands[i].name)}</span> <span style="opacity:0.5;font-size:11px">${escapeHtml(commands[i].hint)}</span>`;
    item.dataset.command = commands[i].name;
    item.addEventListener('click', () => insertCommand(commands[i].name));
    popup.appendChild(item);
  }
}

function insertCommand(command) {
  const input = _container?.querySelector('#chat-input');
  if (!input) return;
  const afterCursor = input.value.substring(input.selectionStart);
  input.value = command + ' ' + afterCursor;
  const newPos = command.length + 1;
  input.setSelectionRange(newPos, newPos);
  closeMentionPopup();
  input.focus();
}

function showMentionPopup(names, atIndex) {
  const popup = _container?.querySelector('#chat-mention-popup');
  if (!popup) return;

  _mentionIdx = 0;
  _popupMode = 'mention';
  popup.innerHTML = '';
  popup.classList.remove('hidden');

  for (let i = 0; i < names.length; i++) {
    const item = document.createElement('div');
    item.className = 'chat-mention-item' + (i === 0 ? ' selected' : '');
    item.textContent = '@' + names[i];
    item.dataset.name = names[i];
    item.addEventListener('click', () => insertMention(names[i], atIndex));
    popup.appendChild(item);
  }
}

function closeMentionPopup() {
  const popup = _container?.querySelector('#chat-mention-popup');
  if (popup) {
    popup.classList.add('hidden');
    popup.innerHTML = '';
  }
  _mentionIdx = -1;
  _popupMode = 'none';
}

function insertMention(name, atIndex) {
  const input = _container?.querySelector('#chat-input');
  if (!input) return;
  const val = input.value;
  const before = val.substring(0, atIndex);
  const afterCursor = val.substring(input.selectionStart);
  input.value = before + '@' + name + ' ' + afterCursor;
  const newPos = before.length + name.length + 2;
  input.setSelectionRange(newPos, newPos);
  closeMentionPopup();
  input.focus();
}

function onInputKeyDown(e) {
  const popup = _container?.querySelector('#chat-mention-popup');
  const isPopupOpen = popup && !popup.classList.contains('hidden');

  if (isPopupOpen) {
    const items = popup.querySelectorAll('.chat-mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[_mentionIdx]?.classList.remove('selected');
      _mentionIdx = (_mentionIdx + 1) % items.length;
      items[_mentionIdx]?.classList.add('selected');
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[_mentionIdx]?.classList.remove('selected');
      _mentionIdx = (_mentionIdx - 1 + items.length) % items.length;
      items[_mentionIdx]?.classList.add('selected');
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      const selected = items[_mentionIdx];
      if (selected) {
        // Handle command popup vs mention popup
        if (_popupMode === 'command' && selected.dataset.command) {
          insertCommand(selected.dataset.command);
        } else {
          const input = _container?.querySelector('#chat-input');
          const before = input.value.substring(0, input.selectionStart);
          const atMatch = before.match(/@(\w*)$/);
          if (atMatch) {
            insertMention(selected.dataset.name, atMatch.index);
          }
        }
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionPopup();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ── Data loading ────────────────────────────────────────────────────

async function loadInitialData() {
  try {
    const [messagesRes, membersRes] = await Promise.all([
      api('/messages?limit=50'),
      api('/members'),
    ]);
    if (messagesRes.ok) {
      _messages = await messagesRes.json();
    }
    if (membersRes.ok) {
      _members = await membersRes.json();
    }
    renderMembers();
    renderAllMessages();
  } catch (err) {
    console.error('[chat] Failed to load initial data:', err);
  }
}

// ── Event binding ───────────────────────────────────────────────────

function bindEvents() {
  if (!_container) return;

  _container.addEventListener('mouseover', onTooltipOver);
  _container.addEventListener('mouseout', onTooltipOut);

  _container.querySelector('#chat-send-btn')?.addEventListener('click', sendMessage);

  const input = _container.querySelector('#chat-input');
  if (input) {
    input.addEventListener('keydown', onInputKeyDown);
    input.addEventListener('input', onInputChange);
  }

  _container.querySelector('#chat-btn-clear')?.addEventListener('click', async () => {
    await api('/messages', { method: 'DELETE' });
    _messages = [];
    renderAllMessages();
  });

  _container.querySelector('#chat-btn-rules')?.addEventListener('click', openRulesEditor);
  _container.querySelector('#chat-rules-close')?.addEventListener('click', closeRulesEditor);
  _container.querySelector('#chat-rules-save')?.addEventListener('click', saveRules);
  _container.querySelector('#chat-rules-reset')?.addEventListener('click', resetRules);
  _container.querySelector('#chat-rules-textarea')?.addEventListener('input', syncRulesDraftFromInput);
  _container.querySelector('#chat-rules-overlay')?.addEventListener('click', (e) => {
    if (e.target?.id === 'chat-rules-overlay') closeRulesEditor();
  });

  // Auto-scroll detection
  const listEl = _container.querySelector('#chat-messages-list');
  if (listEl) {
    listEl.addEventListener('scroll', () => {
      const threshold = 50;
      _autoScroll = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - threshold;
      if (_autoScroll) hideNewIndicator();
    });
  }

  // New messages indicator click
  _container.querySelector('#chat-new-indicator')?.addEventListener('click', scrollToBottom);
}

// ── Invite LLM ─────────────────────────────────────────────────────


// ── Exports ─────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
  _projectId = ctx?.project?.id || null;
  _messages = [];
  _members = [];
  _autoScroll = true;
  _rulesDraft = '';
  _rulesLoaded = false;


  container.classList.add('page-chat', 'app-page');
  container.innerHTML = BODY_HTML;

  // Load marked.js for markdown rendering (reuse kanban's vendored copy)
  loadScript('/app/kanban/vendor/marked.min.js', 'marked')
    .then(() => { initMarked(); renderAllMessages(); })
    .catch(() => { /* graceful degradation — messages render as plain text */ });

  // Load mermaid.js for chart rendering (CDN, ESM build)
  loadScript('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js', 'mermaid')
    .then(() => { initMermaid(); renderMermaidBlocks(); })
    .catch(() => { _mermaidFailed = true; fallbackAllMermaidBlocks(); });

  bindEvents();
  loadInitialData();
  connectSocket();

  // Voice STT — insert transcribed text into chat input
  _voiceHandler = (e) => {
    const text = e.detail?.text;
    if (!text) return;
    const input = container.querySelector('#chat-input');
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + text.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  document.addEventListener('voice:result', _voiceHandler);

  // Restore draft text (scoped to current project)
  const draft = sessionStorage.getItem(draftKey(_projectId));
  if (draft) {
    const input = container.querySelector('#chat-input');
    if (input) {
      input.value = draft;
      autoResizeInput(input);
    }
  }

  // Auto-focus the input when navigating to chat
  container.querySelector('#chat-input')?.focus();
}

export function unmount(container) {
  // Save draft text before teardown (scoped to current project)
  const input = container.querySelector('#chat-input');
  const key = draftKey(_projectId);
  if (input?.value) {
    sessionStorage.setItem(key, input.value);
  } else {
    sessionStorage.removeItem(key);
  }

  if (_voiceHandler) {
    document.removeEventListener('voice:result', _voiceHandler);
    _voiceHandler = null;
  }
  closeMentionPopup();
  disconnectSocket();
  container.classList.remove('page-chat', 'app-page');
  container.innerHTML = '';
  _container = null;
  _projectId = null;
  _messages = [];
  _members = [];
  _rulesDraft = '';
  _rulesLoaded = false;

  _mermaidIdCounter = 0;
  _mermaidFailed = false;
}

export function onProjectChange(project) {
  // Save current project's draft before switching
  const input = _container?.querySelector('#chat-input');
  const oldKey = draftKey(_projectId);
  if (input?.value) {
    sessionStorage.setItem(oldKey, input.value);
  } else {
    sessionStorage.removeItem(oldKey);
  }

  _projectId = project?.id || null;
  _messages = [];
  _members = [];
  _rulesDraft = '';
  _rulesLoaded = false;

  if (_container) {
    // Restore the new project's draft (or clear)
    const newDraft = sessionStorage.getItem(draftKey(_projectId));
    if (input) {
      input.value = newDraft || '';
      autoResizeInput(input);
    }
    loadInitialData();
  }
}
