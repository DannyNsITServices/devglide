// ── Chat App — Page Module ────────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).

import { escapeHtml, escapeAttr, sanitizeHtml } from '/shared-assets/ui-utils.js';
import { dashboardSocket } from '/state.js';
import { createHeader } from '/shared-ui/components/header.js';

let _container = null;
let _socket = null;
let _members = [];
let _messages = [];
let _autoScroll = true;
let _mentionIdx = -1;
let _voiceHandler = null;
let _rulesDraft = '';
let _rulesLoaded = false;

const DRAFT_KEY = 'devglide-chat-draft';
let _markedReady = false;
let _mermaidReady = false;
let _mermaidFailed = false;
let _mermaidIdCounter = 0;

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
// Distinct hues that work on dark backgrounds. Colors are assigned in
// order as new participants appear — no hash collisions possible.

const PARTICIPANT_COLORS = [
  '#60a5fa', // blue
  '#f472b6', // pink
  '#34d399', // emerald
  '#fb923c', // orange
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#fbbf24', // amber
  '#e879f9', // fuchsia
  '#f87171', // red
  '#a3e635', // lime
];

const _colorMap = new Map();
let _nextColorIdx = 0;

function getParticipantColor(name) {
  if (_colorMap.has(name)) return _colorMap.get(name);
  const color = PARTICIPANT_COLORS[_nextColorIdx % PARTICIPANT_COLORS.length];
  _nextColorIdx++;
  _colorMap.set(name, color);
  return color;
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
      <div class="chat-members-title" id="chat-members-title">Members (0)</div>
      <div id="chat-members-list"></div>
    </div>

    <div class="chat-messages-area">
      <div class="chat-messages-list" id="chat-messages-list"></div>
      <div class="chat-new-indicator hidden" id="chat-new-indicator">New messages below</div>
      <div class="chat-input-area" style="position:relative">
        <div class="chat-mention-popup hidden" id="chat-mention-popup"></div>
        <input type="text" class="chat-input" id="chat-input" placeholder="Type a message... (@mention to signal who should act)" autocomplete="off" />
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
}

function disconnectSocket() {
  if (_socket) {
    _socket.off('chat:members', onMembers);
    _socket.off('chat:join', onJoin);
    _socket.off('chat:leave', onLeave);
    _socket.off('chat:message', onMessage);
    _socket.off('chat:cleared', onCleared);
    // Don't disconnect — shared socket, other pages need it
    _socket = null;
  }
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

    const name = document.createElement('span');
    name.className = 'chat-member-name';
    name.textContent = m.name;

    // Assign unique color to LLM participants (skip dot color for detached — let CSS handle it)
    if (!m.isUser) {
      const color = getParticipantColor(m.name);
      if (!m.detached) dot.style.background = color;
      name.style.color = color;
    }

    item.appendChild(dot);
    item.appendChild(name);

    if (m.isUser) {
      const tag = document.createElement('span');
      tag.className = 'chat-member-tag';
      tag.textContent = '(you)';
      item.appendChild(tag);
    } else if (m.detached) {
      const tag = document.createElement('span');
      tag.className = 'chat-member-tag detached';
      tag.textContent = m.model ? `(${m.model} · detached)` : '(detached)';
      item.appendChild(tag);
    } else {
      if (m.model) {
        const tag = document.createElement('span');
        tag.className = 'chat-member-tag';
        tag.textContent = `(${m.model})`;
        item.appendChild(tag);
      }
      const status = document.createElement('span');
      const state = m.status || 'idle';
      status.className = `chat-member-status ${state}`;
      status.textContent = state.replace(/-/g, ' ');
      item.appendChild(status);
    }

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
  } else {
    el.classList.add('from-llm');
    const color = getParticipantColor(msg.from);
    el.style.borderLeftColor = color;
    const sender = document.createElement('div');
    sender.className = 'chat-msg-sender';
    sender.style.color = color;
    sender.textContent = msg.from + (msg.to ? ` \u2192 ${msg.to}` : '');
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

function sendMessage() {
  const input = _container?.querySelector('#chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  sessionStorage.removeItem(DRAFT_KEY);
  closeMentionPopup();
  input.focus();

  // Let the server resolve all @mentions from the message body
  _socket.emit('chat:send', { message: text });
}

// ── @mention autocomplete ───────────────────────────────────────────

function onInputChange(e) {
  const input = e.target;
  const val = input.value;
  const cursorPos = input.selectionStart;
  const before = val.substring(0, cursorPos);

  // Check for @mention
  const atMatch = before.match(/@(\w*)$/);
  if (atMatch) {
    const query = atMatch[1].toLowerCase();
    const matches = _members
      .filter(m => m.name !== 'user' && m.name.toLowerCase().startsWith(query))
      .map(m => m.name);

    if (matches.length > 0) {
      showMentionPopup(matches, atMatch.index);
      return;
    }
  }

  closeMentionPopup();
}

function showMentionPopup(names, atIndex) {
  const popup = _container?.querySelector('#chat-mention-popup');
  if (!popup) return;

  _mentionIdx = 0;
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
        const input = _container?.querySelector('#chat-input');
        const before = input.value.substring(0, input.selectionStart);
        const atMatch = before.match(/@(\w*)$/);
        if (atMatch) {
          insertMention(selected.dataset.name, atMatch.index);
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

// ── Exports ─────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
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

  // Restore draft text
  const draft = sessionStorage.getItem(DRAFT_KEY);
  if (draft) {
    const input = container.querySelector('#chat-input');
    if (input) input.value = draft;
  }
}

export function unmount(container) {
  // Save draft text before teardown
  const input = container.querySelector('#chat-input');
  if (input?.value) {
    sessionStorage.setItem(DRAFT_KEY, input.value);
  } else {
    sessionStorage.removeItem(DRAFT_KEY);
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
  _messages = [];
  _members = [];
  _rulesDraft = '';
  _rulesLoaded = false;

  _colorMap.clear();
  _nextColorIdx = 0;
  _mermaidIdCounter = 0;
  _mermaidFailed = false;
}

export function onProjectChange(project) {
  _messages = [];
  _members = [];
  _rulesDraft = '';
  _rulesLoaded = false;

  _colorMap.clear();
  _nextColorIdx = 0;
  if (_container) {
    loadInitialData();
  }
}
