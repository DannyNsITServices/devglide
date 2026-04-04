// ── Chat App — Page Module ────────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).

import { escapeHtml, escapeAttr, sanitizeHtml } from '/shared-assets/ui-utils.js';
import { dashboardSocket } from '/state.js';
import { createHeader } from '/shared-ui/components/header.js';
import { getMentionMatches, getPipeAssigneeMatches } from './mention-suggestions.js';
import { DEFAULT_VISIBLE_TERMINAL, getVisiblePipeSummaries } from './pipe-visibility.js';

let _container = null;
let _socket = null;
let _members = [];
let _messages = [];
let _pipeEvents = [];
let _pipeSummaries = [];
let _pipeLeases = [];
let _pipeDeadLetters = [];
let _pipeStatusById = {};
let _pipeStatusLoading = new Set();
let _pipeTimingById = {};
let _pipeTimingLoading = new Set();
let _pipesCollapsed = false;
let _expandedPipeId = null;
let _showAllPipes = false;
let _pipesPollTimer = null;
let _leaseTickTimer = null;
let _autoScroll = true;
let _mentionIdx = -1;
let _voiceHandler = null;
let _rulesDraft = '';
let _rulesLoaded = false;
let _tooltipTarget = null;
let _brainstorms = {}; // brainstormId -> { phase, ... }
let _teamState = null;
let _teamLoading = false;
let _teamDraft = null;
let _teamRoles = [];
let _teamRefreshTimer = null;
let _teamFormMode = 'edit';
let _teamActiveDialog = null;
let _teamDialogReturnFocus = null;

const TEAM_ROLE_TEMPLATES = [
  {
    key: 'tech-lead',
    name: 'Tech Lead',
    summary: 'Coordinates scope, owns sequencing, and delegates decisions.',
    instructions: 'Keep the plan coherent, break work into slices, and hand off to independent reviewers/tests.',
    handoffTargets: ['Implementer', 'Reviewer', 'Tester', 'Kanban'],
    constraints: ['No self-approval', 'No self-review'],
  },
  {
    key: 'implementer',
    name: 'Implementer',
    summary: 'Builds the code changes and reports concrete file-level progress.',
    instructions: 'Stay implementation-focused, surface assumptions, and pass the result to reviewer/tester before closing.',
    handoffTargets: ['Reviewer', 'Tester', 'Kanban'],
    constraints: ['Do not approve your own work'],
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    summary: 'Checks correctness, regressions, and missing edge cases.',
    instructions: 'Look for behavioral issues, missing coverage, and contract mismatches. Escalate if the implementation needs another pass.',
    handoffTargets: ['Tester', 'Kanban'],
    constraints: ['Independent review required'],
  },
  {
    key: 'tester',
    name: 'Tester',
    summary: 'Verifies the user-visible behavior and regression surface.',
    instructions: 'Run focused checks, confirm the visible outcome, and report any gaps with concrete reproduction steps.',
    handoffTargets: ['Reviewer', 'Kanban'],
    constraints: ['Test the delivered behavior, not just the code diff'],
  },
  {
    key: 'kanban',
    name: 'Kanban',
    summary: 'Keeps task state and handoffs current.',
    instructions: 'Update issue state, preserve review history, and pass the next concrete task back to the room.',
    handoffTargets: ['Tech Lead', 'Implementer', 'Reviewer', 'Tester'],
    constraints: ['Do not self-approve work'],
  },
];

// Pipe slash-command state
const PIPE_COMMANDS = [
  { name: '/team', hint: 'run|create|status|add|remove|pause|resume|disband|roles', description: 'Team orchestration' },
  { name: '/linear-pipe', hint: 'min 2 assignees', description: 'Sequential processing chain' },
  { name: '/merge-pipe', hint: 'min 3 assignees', description: 'Parallel fan-out + synthesizer' },
  { name: '/merge-all-pipe', hint: 'min 2 assignees', description: 'Parallel fan-out (all) + synthesizer' },
  { name: '/explain', hint: 'defaults to active LLMs', description: 'Teaching-oriented multi-LLM explanation' },
  { name: '/summarize', hint: 'defaults to active LLMs', description: 'Concise multi-LLM digest for long topics' },
  { name: '/brainstorm', hint: 'defaults to active LLMs', description: 'Multi-phase brainstorm: ideate → detail → finalize' },
];
let _popupMode = 'none'; // 'none' | 'command' | 'mention'

const DRAFT_KEY_PREFIX = 'devglide-chat-draft';
let _projectId = null;
let _markedReady = false;
let _mermaidReady = false;
let _mermaidFailed = false;
let _mermaidIdCounter = 0;
const PIPE_POLL_INTERVAL_MS = 8_000;

function draftKey(projectId) {
  return projectId ? `${DRAFT_KEY_PREFIX}:${projectId}` : DRAFT_KEY_PREFIX;
}

function slugifyTeamKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getTeamRoleTemplates() {
  return _teamRoles.length > 0 ? _teamRoles : TEAM_ROLE_TEMPLATES;
}

function getTeamRoster() {
  const roster = Array.isArray(_teamState?.roster) ? _teamState.roster : Array.isArray(_teamState?.members) ? _teamState.members : [];
  return roster.filter(Boolean);
}

function getTeamProposals() {
  const proposals = Array.isArray(_teamState?.proposals) ? _teamState.proposals : [];
  return proposals.filter(Boolean);
}

function getTeamMemberContext(name) {
  return getTeamRoster().find(member => member.participantName === name || member.name === name || member.participant === name || member.member === name) ?? null;
}

function getTeamModeLabel(mode) {
  const normalized = String(mode || '').toLowerCase();
  if (!normalized) return 'manual';
  if (normalized === 'assist' || normalized === 'assisted') return 'assist';
  if (normalized === 'auto' || normalized === 'automated' || normalized === 'automatic') return 'auto';
  return normalized;
}

function getTeamStatusLabel(team) {
  const status = String(team?.status || '').toLowerCase();
  if (!team) return 'No active team';
  if (status === 'paused') return 'Paused';
  if (status === 'disbanded') return 'Disbanded';
  return status || 'Active';
}

function isTeamRunSummary(pipe) {
  if (!pipe) return false;
  const source = pipe.source ?? pipe.origin ?? pipe.runSource ?? pipe.provenance ?? null;
  if (source === 'team') return true;
  if (source && typeof source === 'object' && (source.kind === 'team' || source.type === 'team')) return true;
  return Boolean(
    pipe.teamRunId
    || pipe.teamId
    || pipe.teamName
    || pipe.teamGenerated
    || pipe.teamRun
    || pipe.generatedByTeam
    || pipe.createdByTeam
    || pipe.runKind === 'team'
  );
}

function getTeamRunLabel(pipe) {
  if (!isTeamRunSummary(pipe)) return null;
  const teamName = pipe.teamName || pipe.team?.name || pipe.teamLabel || pipe.teamId || pipe.teamRunId || '';
  return teamName ? `Team: ${teamName}` : 'Team run';
}

function isTeamProposalPending(proposal) {
  const state = String(proposal?.status || proposal?.state || proposal?.phase || 'pending').toLowerCase();
  return state === 'pending' || state === 'queued' || state === 'open';
}

function normalizeTeamSnapshot(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload[0] ?? null;
  if (payload.team && typeof payload.team === 'object') return payload.team;
  if (payload.data && typeof payload.data === 'object' && payload.data.team) return payload.data.team;
  return payload;
}

function setTeamSnapshot(snapshot) {
  _teamState = snapshot ? {
    ...snapshot,
    roster: Array.isArray(snapshot.roster) ? snapshot.roster : Array.isArray(snapshot.members) ? snapshot.members : [],
    proposals: Array.isArray(snapshot.proposals) ? snapshot.proposals : [],
  } : null;
  renderTeam();
  renderMembers();
  renderPipes();
}

function setTeamRoles(roles) {
  _teamRoles = Array.isArray(roles) ? roles.filter(Boolean) : [];
  renderTeam();
  renderMembers();
}

function getTeamActionBody(extra = {}) {
  return JSON.stringify({
    projectId: _projectId,
    teamId: _teamState?.id ?? _teamState?.teamId ?? null,
    ...extra,
  });
}

function queueTeamRefresh(delayMs = 1500) {
  if (_teamRefreshTimer) clearTimeout(_teamRefreshTimer);
  _teamRefreshTimer = setTimeout(() => {
    _teamRefreshTimer = null;
    refreshTeamData().catch(() => {});
  }, delayMs);
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
// Panes 1–9 use hand-picked colors; higher pane numbers get a generated
// HSL color via golden-angle spacing (~137.5°) for maximum hue separation.

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

function getGeneratedParticipantColor(paneNumber) {
  const hue = (paneNumber * 137.508) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

function getParticipantColor(participant) {
  const paneNumber = participant?.paneNum ?? null;
  if (!paneNumber) return DEFAULT_PARTICIPANT_COLOR;
  return PANE_COLORS.get(paneNumber) ?? getGeneratedParticipantColor(paneNumber);
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

function mergeById(existing, incoming) {
  const map = new Map();
  for (const item of existing || []) {
    if (item?.id) map.set(item.id, item);
  }
  for (const item of incoming || []) {
    if (item?.id) map.set(item.id, item);
  }
  return [...map.values()];
}

function normalizePipeEvent(event) {
  if (!event || !event.pipeId) return null;
  const fallbackId = [
    'pipe',
    event.pipeId,
    event.type || 'event',
    event.role || event.actionType || event.assignee || event.from || 'ui',
    event.stage ?? '',
  ].filter(Boolean).join('-');
  return {
    ...event,
    id: event.id || fallbackId,
    ts: event.ts || new Date().toISOString(),
  };
}

function getTimelineEntries() {
  return [
    ..._messages.map(msg => ({ kind: 'message', id: msg.id, ts: msg.ts || '', payload: msg })),
    ..._pipeEvents.map(event => ({ kind: 'pipe', id: event.id, ts: event.ts || '', payload: event })),
  ].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
}

// ── HTML ────────────────────────────────────────────────────────────

const BODY_HTML = `
  ${createHeader({
    brand: 'Chat',
    meta: '<span id="chat-member-count"></span>',
    actions: `
      <button class="btn btn-primary" id="chat-btn-rules">Rules</button>
      <button class="btn btn-primary" id="chat-btn-clear">Clear</button>
    `,
  })}

  <main>
    <div class="chat-members-panel" id="chat-members-panel">
      <div class="chat-members-toolbar">
        <div class="chat-members-title" id="chat-members-title">Members (0)</div>
      </div>
      <div id="chat-members-list"></div>
      <div class="chat-team-section" id="chat-team-section">
        <div class="chat-team-toolbar">
          <div class="chat-team-toolbar-left">
            <div class="chat-team-title" id="chat-team-title">Team</div>
            <div class="chat-team-identity">
              <span class="chat-team-summary" id="chat-team-summary">No active team for this project.</span>
              <span class="chat-team-badge inactive hidden" id="chat-team-status-badge">Inactive</span>
            </div>
            <div class="chat-team-meta hidden" id="chat-team-meta">
              <span class="chat-team-chip" id="chat-team-mode-chip">manual</span>
              <span class="chat-team-chip" id="chat-team-run-chip">No run</span>
            </div>
          </div>
          <div class="chat-team-actions">
            <button class="btn btn-ghost btn-sm" id="chat-team-roles-trigger" type="button" aria-haspopup="dialog" aria-controls="chat-team-roles-overlay">Roles</button>
            <button class="btn btn-ghost btn-sm hidden" id="chat-team-members-btn" type="button">Members</button>
            <button class="btn btn-ghost btn-sm" id="chat-team-create" type="button">Create</button>
            <button class="btn btn-ghost btn-sm chat-team-icon-btn" id="chat-team-refresh" type="button" aria-label="Refresh team" title="Refresh">↺</button>
          </div>
        </div>
        <div class="chat-team-card hidden" id="chat-team-card">
          <div class="chat-team-roster" id="chat-team-roster"></div>
          <div class="chat-team-card-actions">
            <button class="btn btn-primary btn-sm" id="chat-team-run" type="button">Run</button>
            <button class="btn btn-secondary btn-sm" id="chat-team-edit" type="button">Edit</button>
            <button class="btn btn-ghost btn-sm" id="chat-team-pause" type="button">Pause</button>
            <button class="btn btn-ghost btn-sm" id="chat-team-disband" type="button">Disband</button>
          </div>
        </div>
        <div class="chat-team-proposals">
          <div class="chat-team-subtitle">Proposals</div>
          <div id="chat-team-proposals-list"></div>
        </div>
      </div>
      <div class="chat-pipes-section" id="chat-pipes-section">
        <div class="chat-pipes-toolbar">
          <div class="chat-pipes-title">
            <span id="chat-pipes-title">Pipes (0)</span>
            <span class="chat-pipes-alert hidden" id="chat-pipes-alert"></span>
          </div>
          <button class="btn btn-ghost btn-sm chat-pipes-toggle" id="chat-pipes-toggle" type="button" aria-expanded="true" aria-controls="chat-pipes-list">Hide</button>
        </div>
        <div id="chat-pipes-list"></div>
      </div>
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

  <div class="chat-rules-overlay hidden" id="chat-note-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-note-title">
    <div class="chat-rules-modal" style="width:min(480px, calc(100vw - 32px));">
      <div class="chat-rules-header">
        <h2 id="chat-note-title">Add a Note</h2>
      </div>
      <div class="chat-rules-body">
        <textarea class="chat-rules-textarea" id="chat-note-textarea" rows="4" style="min-height:auto" placeholder="Optional note..."></textarea>
      </div>
      <div class="chat-rules-actions">
        <button class="btn btn-secondary btn-sm" id="chat-note-cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" id="chat-note-submit">Submit</button>
      </div>
    </div>
  </div>

  <div class="chat-rules-overlay hidden" id="chat-team-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-team-editor-title" tabindex="-1">
    <div class="chat-rules-modal chat-team-modal">
      <div class="chat-rules-header">
        <div>
          <h2 id="chat-team-editor-title">Edit Team</h2>
          <p class="chat-rules-desc" id="chat-team-editor-desc">Adjust the current team definition and dispatch settings.</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="chat-team-editor-close" aria-label="Close team editor">Close</button>
      </div>
      <div class="chat-rules-body chat-team-editor-body">
        <label class="chat-team-field">
          <span>Team name</span>
          <input class="chat-team-input" id="chat-team-name-input" type="text" placeholder="Platform Crew">
        </label>
        <label class="chat-team-field">
          <span>Dispatch mode</span>
          <select class="chat-team-input" id="chat-team-dispatch-input">
            <option value="manual">Manual</option>
            <option value="assist">Assist</option>
          </select>
        </label>
      </div>
      <div class="chat-rules-actions">
        <button class="btn btn-secondary btn-sm" id="chat-team-editor-cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" id="chat-team-editor-save">Save Team</button>
      </div>
    </div>
  </div>

  <div class="chat-rules-overlay hidden" id="chat-team-roles-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-team-roles-title" tabindex="-1">
    <div class="chat-rules-modal chat-team-modal chat-team-roles-modal">
      <div class="chat-rules-header">
        <div>
          <h2 id="chat-team-roles-title">Built-In Roles</h2>
          <p class="chat-rules-desc">Reference the built-in team role templates without expanding the sidebar.</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="chat-team-roles-close" aria-label="Close built-in roles">Close</button>
      </div>
      <div class="chat-rules-body chat-team-dialog-body">
        <div class="chat-team-roles-list" id="chat-team-roles-modal-list"></div>
      </div>
      <div class="chat-rules-actions">
        <button class="btn btn-secondary btn-sm" id="chat-team-roles-done">Done</button>
      </div>
    </div>
  </div>

  <div class="chat-rules-overlay hidden" id="chat-team-disband-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-team-disband-title" tabindex="-1">
    <div class="chat-rules-modal chat-team-modal">
      <div class="chat-rules-header">
        <div>
          <h2 id="chat-team-disband-title">Disband Team</h2>
          <p class="chat-rules-desc">Confirm the team shutdown before the active record is retired.</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="chat-team-disband-close" aria-label="Close disband confirmation">Close</button>
      </div>
      <div class="chat-rules-body chat-team-dialog-body">
        <div class="chat-team-danger-note" id="chat-team-disband-name">Disband this team?</div>
        <div class="chat-team-dialog-copy" id="chat-team-disband-copy">This will make the current team inactive for this project. You can create a new team later, but the current team configuration will no longer be active.</div>
      </div>
      <div class="chat-rules-actions">
        <button class="btn btn-secondary btn-sm" id="chat-team-disband-cancel">Cancel</button>
        <button class="btn btn-primary btn-sm chat-team-danger-btn" id="chat-team-disband-confirm">Disband Team</button>
      </div>
    </div>
  </div>

  <div class="chat-rules-overlay hidden" id="chat-team-members-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-team-members-title" tabindex="-1">
    <div class="chat-rules-modal chat-team-modal chat-team-members-modal">
      <div class="chat-rules-header">
        <div>
          <h2 id="chat-team-members-title">Manage Members</h2>
          <p class="chat-rules-desc">Assign chat participants to roles in the active team.</p>
        </div>
      </div>
      <div class="chat-rules-body chat-team-members-body" id="chat-team-members-list"></div>
      <div class="chat-rules-actions" style="justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="chat-team-members-close" aria-label="Close member manager">Close</button>
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
  _socket.on('chat:pipe', handlePipeEvent);
  _socket.on('chat:error', onError);
  // Optional: live team state push (REST-first; socket is additive)
  _socket.on('chat:team', onTeamUpdate);
}

function disconnectSocket() {
  if (_socket) {
    _socket.off('chat:members', onMembers);
    _socket.off('chat:join', onJoin);
    _socket.off('chat:leave', onLeave);
    _socket.off('chat:message', onMessage);
    _socket.off('chat:cleared', onCleared);
    _socket.off('chat:pipe', handlePipeEvent);
    _socket.off('chat:error', onError);
    _socket.off('chat:team', onTeamUpdate);
    // Don't disconnect — shared socket, other pages need it
    _socket = null;
  }
}

// ── Brainstorm action panel ──────────────────────────────────────────────────

function buildBrainstormActions(brainstormId, phase) {
  const panel = document.createElement('div');
  panel.className = 'brainstorm-actions';
  panel.dataset.brainstormId = brainstormId;

  if (phase === 'ideas_review') {
    panel.appendChild(makeBsBtn('Accept Idea', 'accept', () => brainstormAction(brainstormId, 'accept-idea')));
    panel.appendChild(makeBsBtn('Retry', 'retry', () => brainstormAction(brainstormId, 'retry-ideas')));
    panel.appendChild(makeBsBtn('Retry with Note', 'note', () => brainstormActionWithNote(brainstormId, 'retry-ideas')));
  } else if (phase === 'details_review') {
    panel.appendChild(makeBsBtn('Finalize', 'accept', () => brainstormAction(brainstormId, 'finalize')));
    panel.appendChild(makeBsBtn('Adjust', 'note', () => brainstormActionWithNote(brainstormId, 'adjust-details')));
    panel.appendChild(makeBsBtn('Back to Ideas', 'retry', () => brainstormAction(brainstormId, 'back-to-ideas')));
  }
  return panel;
}

function makeBsBtn(label, variant, onClick) {
  const btn = document.createElement('button');
  const variantClass = { accept: 'btn-primary', note: 'btn-secondary', retry: 'btn-ghost' }[variant] || 'btn-secondary';
  btn.className = `btn btn-sm ${variantClass}`;
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    const result = await onClick();
    if (result === false) return; // cancelled — keep buttons alive
    const panel = btn.closest('.brainstorm-actions');
    if (panel) panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
  });
  return btn;
}

async function brainstormAction(brainstormId, action) {
  try {
    await fetch(`/api/chat/brainstorms/${brainstormId}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch { /* socket events will update the UI */ }
}

function openNoteModal() {
  return new Promise((resolve) => {
    const overlay = _container?.querySelector('#chat-note-overlay');
    const textarea = _container?.querySelector('#chat-note-textarea');
    const submitBtn = _container?.querySelector('#chat-note-submit');
    const cancelBtn = _container?.querySelector('#chat-note-cancel');
    if (!overlay || !textarea) { resolve(null); return; }

    textarea.value = '';
    overlay.classList.remove('hidden');
    textarea.focus();

    function cleanup() {
      overlay.classList.add('hidden');
      submitBtn?.removeEventListener('click', onSubmit);
      cancelBtn?.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
    }
    function onSubmit() { cleanup(); resolve(textarea.value || null); }
    function onCancel() { cleanup(); resolve(undefined); } // undefined = cancelled
    function onBackdrop(e) { if (e.target === overlay) { cleanup(); resolve(undefined); } }

    submitBtn?.addEventListener('click', onSubmit);
    cancelBtn?.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
  });
}

function openTeamDialog(overlaySelector, focusSelector = null) {
  const overlay = _container?.querySelector(overlaySelector);
  if (!overlay) return null;
  if (_teamActiveDialog && _teamActiveDialog !== overlaySelector) closeTeamDialog(_teamActiveDialog, false);

  const activeEl = document.activeElement;
  _teamDialogReturnFocus = activeEl instanceof HTMLElement ? activeEl : null;
  _teamActiveDialog = overlaySelector;
  overlay.classList.remove('hidden');

  const focusTarget = focusSelector ? overlay.querySelector(focusSelector) : null;
  queueMicrotask(() => {
    if (focusTarget instanceof HTMLElement) focusTarget.focus();
    else overlay.focus();
  });
  return overlay;
}

function closeTeamDialog(overlaySelector, restoreFocus = true) {
  const overlay = _container?.querySelector(overlaySelector);
  if (!overlay) return;
  overlay.classList.add('hidden');

  if (_teamActiveDialog === overlaySelector) {
    const returnFocus = restoreFocus ? _teamDialogReturnFocus : null;
    _teamActiveDialog = null;
    _teamDialogReturnFocus = null;
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  }
}

function closeActiveTeamDialog() {
  if (_teamActiveDialog) closeTeamDialog(_teamActiveDialog);
}

function onTeamDialogKeyDown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeActiveTeamDialog();
  }
}

async function brainstormActionWithNote(brainstormId, action) {
  const note = await openNoteModal();
  if (note === undefined) return false; // user cancelled — keep buttons alive
  try {
    await fetch(`/api/chat/brainstorms/${brainstormId}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note || null }),
    });
  } catch { /* socket events will update the UI */ }
}

function getPipeTag(pipeId) {
  return `#pipe-${pipeId}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingPipeTag(text, pipeId) {
  if (!text || !pipeId) return text || '';
  const pattern = new RegExp(`^\\s*${escapeRegExp(getPipeTag(pipeId))}\\s*`, 'i');
  const stripped = text.replace(pattern, '');
  return stripped || text;
}

function createSenderEl(senderText, color) {
  const sender = document.createElement('div');
  sender.className = 'chat-msg-sender';
  sender.style.color = color;
  sender.textContent = senderText;
  return sender;
}

function buildPipeMetaEl(pipeId, label) {
  const meta = document.createElement('div');
  meta.className = 'chat-msg-meta chat-pipe-meta';

  const badge = document.createElement('span');
  badge.className = 'chat-pipe-badge';
  badge.textContent = getPipeTag(pipeId);
  meta.appendChild(badge);

  if (label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'chat-pipe-label';
    labelEl.textContent = label;
    meta.appendChild(labelEl);
  }

  return meta;
}

function getPipeOutputLabel(role, stage) {
  if (role === 'fan-out') return 'Fan-out output';
  if (stage) return `Stage ${stage} output`;
  return 'Intermediate output';
}

function buildPipeHeaderEl(senderText, color, pipeId, label) {
  const header = document.createElement('div');
  header.className = 'chat-msg-header';
  header.appendChild(createSenderEl(senderText, color));
  header.appendChild(buildPipeMetaEl(pipeId, label));
  return header;
}

function buildPipeOutputEl({ id, from, to = null, pipeId, label, content, ts, color, extraClass = '', collapsible = false }) {
  const el = document.createElement('div');
  el.className = ['chat-msg', 'from-llm', 'chat-pipe-output', extraClass].filter(Boolean).join(' ');
  el.dataset.id = id;
  el.style.borderLeftColor = color;

  const header = buildPipeHeaderEl((from || 'system') + (to ? ` \u2192 ${to}` : ''), color, pipeId, label);

  const body = document.createElement('div');
  body.className = 'chat-msg-body chat-markdown';
  body.innerHTML = renderMarkdown(stripLeadingPipeTag(content || '', pipeId));

  const time = document.createElement('div');
  time.className = 'chat-msg-time';
  time.textContent = formatTime(ts);

  if (collapsible) {
    const chevron = document.createElement('span');
    chevron.className = 'chat-pipe-chevron';
    chevron.textContent = '\u25B6';
    header.prepend(chevron);
    header.classList.add('chat-pipe-toggle');
    header.style.cursor = 'pointer';

    const detail = document.createElement('div');
    detail.className = 'chat-pipe-detail hidden';
    detail.appendChild(body);
    detail.appendChild(time);

    header.addEventListener('click', () => {
      const open = detail.classList.toggle('hidden');
      chevron.textContent = open ? '\u25B6' : '\u25BC';
      header.classList.toggle('chat-pipe-toggle-open', !open);
    });

    el.appendChild(header);
    el.appendChild(detail);
  } else {
    el.appendChild(header);
    el.appendChild(body);
    el.appendChild(time);
  }

  return el;
}

function appendRenderedPipeEventEl(event, doScroll = true) {
  if (!event || event.type !== 'stage-output' || !event.pipeId) return;

  const listEl = _container?.querySelector('#chat-messages-list');
  if (!listEl) return;

  const empty = listEl.querySelector('.chat-empty-state');
  if (empty) empty.remove();

  const color = getParticipantColor(findParticipant(event.from));
  const el = buildPipeOutputEl({
    id: event.id,
    from: event.from,
    pipeId: event.pipeId,
    label: getPipeOutputLabel(event.role, event.stage),
    content: event.content,
    ts: event.ts,
    color,
    extraClass: 'chat-pipe-intermediate',
    collapsible: true,
  });

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

function appendPipeEventTimelineEl(event, doScroll = true) {
  appendRenderedPipeEventEl(event, doScroll);
}

function handlePipeEvent(event) {
  const normalized = normalizePipeEvent(event);
  if (!normalized) return;
  if (_pipeEvents.some(existing => existing.id === normalized.id)) return;
  _pipeEvents.push(normalized);
  appendPipeEventTimelineEl(normalized);
  if (['start', 'complete', 'failed', 'cancel'].includes(normalized.type)) {
    fetchPipes();
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
  _pipeEvents = [];
  renderAllMessages();
}

function getPipeShortId(pipeId) {
  return `#${String(pipeId || '').slice(0, 8)}`;
}

function getPipeStatusSymbol(status) {
  if (status === 'running') return 'O';
  if (status === 'completed') return 'OK';
  if (status === 'failed') return 'ERR';
  if (status === 'cancelled') return 'X';
  return '?';
}

function formatPipeCountdown(ms) {
  if (ms == null) return 'leased';
  if (ms <= 0) return 'overdue';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatDurationMs(ms) {
  if (ms == null) return '--';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function renderPipeAlert() {
  const alertEl = _container?.querySelector('#chat-pipes-alert');
  if (!alertEl) return;
  if (_pipeDeadLetters.length === 0) {
    alertEl.textContent = '';
    alertEl.classList.add('hidden');
    return;
  }
  alertEl.textContent = `! ${_pipeDeadLetters.length}`;
  alertEl.classList.remove('hidden');
}

function getPipeSummary(pipeId) {
  return _pipeSummaries.find(pipe => pipe.pipeId === pipeId) ?? null;
}

function getPipeLeases(pipeId) {
  return _pipeLeases.filter(lease => lease.pipeId === pipeId);
}

function getPipeDeadLetters(pipeId) {
  return _pipeDeadLetters.filter(entry => entry.pipeId === pipeId);
}

function getPipeSlotStatus(slot, leases, deadLetters) {
  const deadLetter = deadLetters.find(entry => entry.assignee === slot.assignee && entry.role === slot.role && entry.stage === slot.stage);
  if (deadLetter) return deadLetter.status;

  if (slot.status === 'submitted') {
    return slot.submittedAt ? `submitted ${formatTime(slot.submittedAt)}` : 'submitted';
  }

  const lease = leases.find(entry => entry.assignee === slot.assignee && entry.slotRole === slot.role && entry.stage === slot.stage);
  if (lease) return formatPipeCountdown(lease.remainingMs);
  return slot.status;
}

function buildPipeSlotRow(slot, leases, deadLetters) {
  const row = document.createElement('div');
  row.className = 'chat-pipe-slot-row';

  const deadLetter = deadLetters.find(entry => entry.assignee === slot.assignee && entry.role === slot.role && entry.stage === slot.stage);
  if (deadLetter) row.classList.add('chat-pipe-slot-dead');

  const slotLabel = document.createElement('span');
  slotLabel.className = 'chat-pipe-slot-name';
  const stageLabel = slot.stage ? ` stage ${slot.stage}` : '';
  slotLabel.textContent = `${slot.assignee} (${slot.role}${stageLabel})`;

  const slotState = document.createElement('span');
  slotState.className = 'chat-pipe-slot-state';

  const lease = !deadLetter && slot.status !== 'submitted'
    ? leases.find(entry => entry.assignee === slot.assignee && entry.slotRole === slot.role && entry.stage === slot.stage)
    : null;

  if (lease?.deadline) {
    // Live countdown badge
    slotState.classList.add('pipe-lease-badge');
    slotState.dataset.deadline = String(new Date(lease.deadline).getTime());
    const pipe = getPipeSummary(lease.pipeId);
    slotState.dataset.timeout = String(pipe?.stageTimeoutMs ?? 0);
    const remainingMs = new Date(lease.deadline).getTime() - Date.now();
    slotState.textContent = formatPipeCountdown(remainingMs);
    // Initial color class
    const pct = pipe?.stageTimeoutMs ? remainingMs / pipe.stageTimeoutMs : (remainingMs > 0 ? 1 : 0);
    if (remainingMs <= 0) slotState.classList.add('lease-overdue');
    else if (pct < 0.25) slotState.classList.add('lease-critical');
    else if (pct < 0.5) slotState.classList.add('lease-warn');
    else slotState.classList.add('lease-ok');
  } else {
    slotState.textContent = getPipeSlotStatus(slot, leases, deadLetters);
    if (slot.status === 'submitted') slotState.classList.add('chat-pipe-slot-submitted');
  }

  row.appendChild(slotLabel);
  row.appendChild(slotState);
  return row;
}

function buildPipeTimingEl(timing) {
  const section = document.createElement('div');
  section.className = 'chat-pipe-timing';

  const header = document.createElement('div');
  header.className = 'chat-pipe-timing-header';
  header.textContent = `Total: ${formatDurationMs(timing.totalDurationMs)}`;
  section.appendChild(header);

  if (timing.stages?.length > 0) {
    for (const stage of timing.stages) {
      const row = document.createElement('div');
      row.className = 'chat-pipe-timing-row';

      const label = document.createElement('span');
      label.className = 'chat-pipe-timing-label';
      const stageLabel = stage.stage != null ? `stage ${stage.stage}` : stage.role;
      label.textContent = `${stage.assignee} (${stageLabel})`;

      const dur = document.createElement('span');
      dur.className = 'chat-pipe-timing-duration';
      dur.textContent = formatDurationMs(stage.durationMs);

      row.appendChild(label);
      row.appendChild(dur);
      section.appendChild(row);
    }
  }

  return section;
}

function buildPipeDetailEl(pipe) {
  const detail = document.createElement('div');
  detail.className = 'chat-pipe-row-detail';

  const detailState = _pipeStatusById[pipe.pipeId];
  const deadLetters = getPipeDeadLetters(pipe.pipeId);

  if (!detailState && _pipeStatusLoading.has(pipe.pipeId)) {
    const loading = document.createElement('div');
    loading.className = 'chat-pipe-row-hint';
    loading.textContent = 'Loading details...';
    detail.appendChild(loading);
  } else if (detailState?.prompt) {
    const prompt = document.createElement('div');
    prompt.className = 'chat-pipe-row-hint';
    prompt.textContent = detailState.prompt;
    detail.appendChild(prompt);
  }

  const slots = detailState?.slots ?? [];
  const leases = detailState?.leases ?? getPipeLeases(pipe.pipeId);
  if (slots.length > 0) {
    for (const slot of slots) {
      detail.appendChild(buildPipeSlotRow(slot, leases, deadLetters));
    }
  } else {
    const hint = document.createElement('div');
    hint.className = 'chat-pipe-row-hint';
    hint.textContent = pipe.status === 'running' ? 'Expand to inspect pipe state.' : 'No slot detail loaded.';
    detail.appendChild(hint);
  }

  if (deadLetters.length > 0) {
    const issue = document.createElement('div');
    issue.className = 'chat-pipe-row-issue';
    issue.textContent = deadLetters.map(entry => `${entry.assignee}: ${entry.reason}`).join(' | ');
    detail.appendChild(issue);
  }

  // Timing drilldown for terminal pipes
  const timing = _pipeTimingById[pipe.pipeId];
  if (pipe.status !== 'running' && timing) {
    detail.appendChild(buildPipeTimingEl(timing));
  } else if (pipe.status !== 'running' && _pipeTimingLoading.has(pipe.pipeId)) {
    const loadingTiming = document.createElement('div');
    loadingTiming.className = 'chat-pipe-row-hint';
    loadingTiming.textContent = 'Loading timing...';
    detail.appendChild(loadingTiming);
  }

  if (pipe.status === 'running') {
    const actionRow = document.createElement('div');
    actionRow.className = 'chat-pipe-row-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-sm';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel pipe';
    cancelBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const confirmed = globalThis.confirm?.(
        `Cancel pipe ${getPipeShortId(pipe.pipeId)}? This will release all leases and stop pending stages.`,
      ) ?? true;
      if (!confirmed) return;
      cancelBtn.disabled = true;
      try {
        await api(`/pipes/${pipe.pipeId}/cancel`, { method: 'POST' });
        await fetchPipes();
      } finally {
        cancelBtn.disabled = false;
      }
    });

    actionRow.appendChild(cancelBtn);
    detail.appendChild(actionRow);
  }

  return detail;
}

function buildPipeRowEl(pipe) {
  const row = document.createElement('div');
  row.className = 'chat-pipe-row';
  row.dataset.pipeId = pipe.pipeId;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'chat-pipe-row-header';
  header.setAttribute('aria-expanded', String(_expandedPipeId === pipe.pipeId));

  const left = document.createElement('span');
  left.className = 'chat-pipe-row-main';

  const chevron = document.createElement('span');
  chevron.className = 'chat-pipe-row-chevron';
  chevron.textContent = _expandedPipeId === pipe.pipeId ? 'v' : '>';

  const badge = document.createElement('span');
  badge.className = 'chat-pipe-row-badge';
  badge.textContent = getPipeShortId(pipe.pipeId);

  const mode = document.createElement('span');
  mode.className = 'chat-pipe-row-mode';
  mode.textContent = pipe.mode;

  left.appendChild(chevron);
  left.appendChild(badge);

  const teamRunLabel = getTeamRunLabel(pipe);
  if (teamRunLabel) {
    const teamBadge = document.createElement('span');
    teamBadge.className = 'chat-pipe-team-badge';
    teamBadge.textContent = teamRunLabel;
    left.appendChild(teamBadge);
  }

  left.appendChild(mode);

  const right = document.createElement('span');
  right.className = 'chat-pipe-row-meta';

  const status = document.createElement('span');
  status.className = 'chat-pipe-row-status';
  status.textContent = getPipeStatusSymbol(pipe.status);

  const progress = document.createElement('span');
  progress.className = 'chat-pipe-row-progress';
  progress.textContent = `${pipe.slotSummary?.submitted ?? 0}/${pipe.slotSummary?.total ?? 0}`;

  right.appendChild(status);
  right.appendChild(progress);

  header.appendChild(left);
  header.appendChild(right);
  header.addEventListener('click', async () => {
    const nextExpanded = _expandedPipeId === pipe.pipeId ? null : pipe.pipeId;
    _expandedPipeId = nextExpanded;
    renderPipes();
    if (nextExpanded) await ensurePipeStatusLoaded(nextExpanded);
  });

  row.appendChild(header);

  if (_expandedPipeId === pipe.pipeId) {
    row.appendChild(buildPipeDetailEl(pipe));
  }

  return row;
}

function renderPipes() {
  const listEl = _container?.querySelector('#chat-pipes-list');
  const titleEl = _container?.querySelector('#chat-pipes-title');
  const toggleEl = _container?.querySelector('#chat-pipes-toggle');
  if (!listEl) return;

  renderPipeAlert();
  if (toggleEl) {
    toggleEl.textContent = _pipesCollapsed ? 'Show' : 'Hide';
    toggleEl.setAttribute('aria-expanded', String(!_pipesCollapsed));
  }

  const {
    visiblePipes,
    hiddenTerminalCount,
    totalCount,
    totalTerminalCount,
    canToggleTerminalHistory,
  } = getVisiblePipeSummaries(_pipeSummaries, {
    expandedPipeId: _expandedPipeId,
    showAll: _showAllPipes,
    terminalLimit: DEFAULT_VISIBLE_TERMINAL,
  });

  if (titleEl) {
    titleEl.textContent = hiddenTerminalCount > 0
      ? `Pipes (${visiblePipes.length} of ${totalCount})`
      : `Pipes (${totalCount})`;
  }

  listEl.innerHTML = '';
  listEl.classList.toggle('hidden', _pipesCollapsed);
  if (_pipesCollapsed) return;

  if (visiblePipes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-pipe-row-hint';
    empty.textContent = 'No active or recent pipes.';
    listEl.appendChild(empty);
    return;
  }

  for (const pipe of visiblePipes) {
    listEl.appendChild(buildPipeRowEl(pipe));
  }

  if (canToggleTerminalHistory) {
    const historyToggle = document.createElement('button');
    historyToggle.className = 'btn btn-ghost btn-sm chat-pipes-show-all';
    historyToggle.type = 'button';
    historyToggle.textContent = _showAllPipes
      ? 'Show fewer'
      : `Show all history (${totalTerminalCount})`;
    historyToggle.addEventListener('click', () => {
      _showAllPipes = !_showAllPipes;
      renderPipes();
    });
    listEl.appendChild(historyToggle);
  }
}

async function fetchPipes() {
  try {
    const [allRes, leasesRes, deadLettersRes] = await Promise.all([
      api('/pipes/all'),
      api('/pipes/leases'),
      api('/pipes/dead-letters'),
    ]);

    if (allRes.ok) {
      _pipeSummaries = await allRes.json();
      if (_expandedPipeId && !getPipeSummary(_expandedPipeId)) _expandedPipeId = null;
    }
    if (leasesRes.ok) _pipeLeases = await leasesRes.json();
    if (deadLettersRes.ok) _pipeDeadLetters = await deadLettersRes.json();

    renderPipes();
    if (_expandedPipeId) ensurePipeStatusLoaded(_expandedPipeId, true);
  } catch (err) {
    console.error('[chat] Failed to fetch pipe monitor data:', err);
  }
}

async function ensurePipeStatusLoaded(pipeId, force = false) {
  if (!pipeId || _pipeStatusLoading.has(pipeId)) return;
  if (!force && _pipeStatusById[pipeId]) return;

  _pipeStatusLoading.add(pipeId);
  renderPipes();
  try {
    const res = await api(`/pipes/${pipeId}/status`);
    if (!res.ok) return;
    _pipeStatusById = { ..._pipeStatusById, [pipeId]: await res.json() };
    // Auto-fetch timing for terminal pipes
    const pipe = getPipeSummary(pipeId);
    if (pipe && pipe.status !== 'running') {
      ensurePipeTimingLoaded(pipeId);
    }
  } catch (err) {
    console.error(`[chat] Failed to load pipe status for ${pipeId}:`, err);
  } finally {
    _pipeStatusLoading.delete(pipeId);
    renderPipes();
  }
}

async function ensurePipeTimingLoaded(pipeId, force = false) {
  if (!pipeId || _pipeTimingLoading.has(pipeId)) return;
  if (!force && _pipeTimingById[pipeId]) return;

  _pipeTimingLoading.add(pipeId);
  try {
    const res = await api(`/pipes/${pipeId}/timing`);
    if (!res.ok) return;
    _pipeTimingById = { ..._pipeTimingById, [pipeId]: await res.json() };
  } catch (err) {
    console.error(`[chat] Failed to load pipe timing for ${pipeId}:`, err);
  } finally {
    _pipeTimingLoading.delete(pipeId);
    renderPipes();
  }
}

function startPipePolling() {
  stopPipePolling();
  _pipesPollTimer = setInterval(() => { fetchPipes(); }, PIPE_POLL_INTERVAL_MS);
}

function stopPipePolling() {
  if (_pipesPollTimer) {
    clearInterval(_pipesPollTimer);
    _pipesPollTimer = null;
  }
}

function startLeaseCountdown() {
  stopLeaseCountdown();
  _leaseTickTimer = setInterval(() => {
    const badges = _container?.querySelectorAll('.pipe-lease-badge[data-deadline]');
    if (!badges || badges.length === 0) return;
    const now = Date.now();
    for (const badge of badges) {
      const deadline = Number(badge.dataset.deadline);
      const timeout = Number(badge.dataset.timeout) || 0;
      if (!deadline) continue;
      const remainingMs = deadline - now;
      badge.textContent = formatPipeCountdown(remainingMs);
      // Color-code by percentage of time remaining
      const pct = timeout > 0 ? remainingMs / timeout : (remainingMs > 0 ? 1 : 0);
      badge.classList.remove('lease-ok', 'lease-warn', 'lease-critical', 'lease-overdue');
      if (remainingMs <= 0) {
        badge.classList.add('lease-overdue');
      } else if (pct < 0.25) {
        badge.classList.add('lease-critical');
      } else if (pct < 0.5) {
        badge.classList.add('lease-warn');
      } else {
        badge.classList.add('lease-ok');
      }
    }
  }, 1000);
}

function stopLeaseCountdown() {
  if (_leaseTickTimer) {
    clearInterval(_leaseTickTimer);
    _leaseTickTimer = null;
  }
}


// ── Team API helpers ────────────────────────────────────────────────

async function refreshTeamData() {
  if (_teamLoading) return;
  _teamLoading = true;
  renderTeam();
  try {
    const [teamRes, rolesRes, proposalsRes] = await Promise.all([
      api('/team'),
      api('/team/roles'),
      api('/team/proposals'),
    ]);
    const [teamData, rolesData, proposalsData] = await Promise.all([
      teamRes.ok ? parseJsonSafely(teamRes) : Promise.resolve(null),
      rolesRes.ok ? parseJsonSafely(rolesRes) : Promise.resolve(null),
      proposalsRes.ok ? parseJsonSafely(proposalsRes) : Promise.resolve(null),
    ]);
    if (teamRes.ok) {
      const snapshot = normalizeTeamSnapshot(teamData);
      // Proposals live at /team/proposals — merge into snapshot so getTeamProposals() works
      if (snapshot) {
        // Backend returns { proposals: Proposal[] }; tolerate bare array as fallback
        snapshot.proposals = Array.isArray(proposalsData?.proposals)
          ? proposalsData.proposals
          : Array.isArray(proposalsData) ? proposalsData : [];
      }
      setTeamSnapshot(snapshot);
    } else {
      setTeamSnapshot(null);
    }
    if (Array.isArray(rolesData)) setTeamRoles(rolesData);
  } catch (err) {
    console.error('[chat] Failed to load team data:', err);
    setTeamSnapshot(null);
  } finally {
    _teamLoading = false;
    renderTeam();
  }
}

function onTeamUpdate(payload) {
  setTeamSnapshot(normalizeTeamSnapshot(payload));
}

async function teamProposalAction(proposalId, action) {
  const res = await api(`/team/proposals/${proposalId}/${action}`, {
    method: 'POST',
    body: getTeamActionBody(),
  });
  if (!res.ok) {
    const data = await parseJsonSafely(res);
    throw new Error(data?.error || `Failed to ${action} proposal`);
  }
}

async function teamAction(action) {
  // Disband is DELETE /team; all other actions are POST /team/:action
  const isDisband = action === 'disband';
  const res = await api(isDisband ? '/team' : `/team/${action}`, {
    method: isDisband ? 'DELETE' : 'POST',
    body: isDisband ? undefined : getTeamActionBody(),
  });
  if (!res.ok) {
    const data = await parseJsonSafely(res);
    throw new Error(data?.error || `Failed to ${action} team`);
  }
  queueTeamRefresh();
}

function openTeamEditor() {
  const titleEl = _container?.querySelector('#chat-team-editor-title');
  const descEl = _container?.querySelector('#chat-team-editor-desc');

  const isDisbandedState = _teamState && String(_teamState.status || '').toLowerCase() === 'disbanded';
  _teamFormMode = (_teamState && !isDisbandedState) ? 'edit' : 'create';
  if (titleEl) titleEl.textContent = _teamFormMode === 'create' ? 'Create Team' : 'Edit Team';
  if (descEl) {
    descEl.textContent = _teamFormMode === 'create'
      ? 'Create a new team for this project and choose its dispatch mode.'
      : 'Adjust the current team definition and dispatch settings.';
  }

  const nameInput = _container.querySelector('#chat-team-name-input');
  const dispatchInput = _container.querySelector('#chat-team-dispatch-input');

  if (nameInput) nameInput.value = _teamFormMode === 'create' ? '' : (_teamState?.name || _teamState?.teamName || '');
  if (dispatchInput) dispatchInput.value = _teamFormMode === 'create' ? 'manual' : (getTeamModeLabel(_teamState?.dispatchMode || _teamState?.mode) || 'manual');

  openTeamDialog('#chat-team-overlay', '#chat-team-name-input');
}

function closeTeamEditor() {
  closeTeamDialog('#chat-team-overlay');
}

function openTeamRolesDialog() {
  renderTeamRoles();
  openTeamDialog('#chat-team-roles-overlay', '#chat-team-roles-close');
}

function closeTeamRolesDialog() {
  closeTeamDialog('#chat-team-roles-overlay');
}

function openTeamDisbandDialog() {
  if (!_teamState) return;

  const teamName = _teamState.name || _teamState.teamName || 'this team';
  const nameEl = _container?.querySelector('#chat-team-disband-name');
  const copyEl = _container?.querySelector('#chat-team-disband-copy');
  if (nameEl) nameEl.textContent = `Disband ${teamName}?`;
  if (copyEl) {
    copyEl.textContent = 'This will retire the current team record for this project. You can create a new team later, but the current role assignments and team state will no longer be active.';
  }

  openTeamDialog('#chat-team-disband-overlay', '#chat-team-disband-cancel');
}

function closeTeamDisbandDialog() {
  closeTeamDialog('#chat-team-disband-overlay');
}

function openTeamMembersDialog() {
  renderTeamMembersDialog();
  openTeamDialog('#chat-team-members-overlay', '#chat-team-members-close');
}

function closeTeamMembersDialog() {
  closeTeamDialog('#chat-team-members-overlay');
}

function renderTeamMembersDialog() {
  const listEl = _container?.querySelector('#chat-team-members-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const llmMembers = _members.filter(m => m.name !== 'user');
  if (llmMembers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-team-proposal-empty';
    empty.textContent = 'No LLM participants currently in chat.';
    listEl.appendChild(empty);
    return;
  }

  const roster = getTeamRoster();
  const roles = getTeamRoleTemplates();

  for (const member of llmMembers) {
    const assigned = roster.find(r => (r.participantName || r.name || r.participant || r.member || '') === member.name);
    const currentSlug = assigned?.roleSlug || assigned?.role || '';

    const row = document.createElement('div');
    row.className = 'chat-team-member-row';

    const isDetached = member.detached;
    const isOnline = Boolean(member.paneId) && !isDetached;
    const dot = document.createElement('span');
    dot.className = 'chat-team-online-dot' + (isDetached ? ' detached' : !isOnline ? ' offline' : '');
    if (!isDetached && isOnline) dot.style.background = getParticipantColor(member);

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-team-member-dialog-name';
    nameEl.textContent = member.name;

    const select = document.createElement('select');
    select.className = 'chat-team-input chat-team-role-select';
    select.title = `Role for ${member.name}`;
    select.setAttribute('aria-label', `Role for ${member.name}`);

    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '— no role —';
    select.appendChild(blankOpt);

    for (const role of roles) {
      const slug = role.slug || slugifyTeamKey(role.displayName || role.name || '');
      const label = role.displayName || role.name || slug;
      const opt = document.createElement('option');
      opt.value = slug;
      opt.textContent = label;
      if (slug === currentSlug) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', async () => {
      const slug = select.value;
      select.disabled = true;
      try {
        if (slug) {
          await assignMemberRole(member.name, slug);
        } else {
          await removeMemberFromTeam(member.name);
        }
        await refreshTeamData();
        renderTeamMembersDialog();
      } catch (err) {
        console.error('[chat] Member role update failed:', err);
        select.disabled = false;
      }
    });

    row.appendChild(dot);
    row.appendChild(nameEl);
    row.appendChild(select);
    listEl.appendChild(row);
  }
}

async function assignMemberRole(participantName, roleSlug) {
  const res = await api('/team/members', {
    method: 'POST',
    body: JSON.stringify({ projectId: _projectId, participantName, roleSlug }),
  });
  if (!res.ok) {
    const data = await parseJsonSafely(res);
    throw new Error(data?.error || 'Failed to assign role');
  }
}

async function removeMemberFromTeam(participantName) {
  const res = await api(`/team/members/${encodeURIComponent(participantName)}`, {
    method: 'DELETE',
    body: getTeamActionBody(),
  });
  if (!res.ok) {
    const data = await parseJsonSafely(res);
    throw new Error(data?.error || 'Failed to remove member');
  }
}

async function confirmTeamDisband() {
  const btn = _container?.querySelector('#chat-team-disband-confirm');
  if (btn) btn.disabled = true;
  try {
    await teamAction('disband');
    closeTeamDisbandDialog();
  } catch (err) {
    console.error('[chat] Failed to disband team:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveTeamFromEditor() {
  const nameInput = _container?.querySelector('#chat-team-name-input');
  const dispatchInput = _container?.querySelector('#chat-team-dispatch-input');
  const saveBtn = _container?.querySelector('#chat-team-editor-save');

  if (saveBtn) saveBtn.disabled = true;
  try {
    const method = _teamFormMode === 'create' ? 'POST' : 'PUT';
    const res = await api('/team', {
      method,
      body: getTeamActionBody({
        name: nameInput?.value?.trim() || '',
        dispatchMode: dispatchInput?.value || 'manual',
      }),
    });
    if (!res.ok) {
      const data = await parseJsonSafely(res);
      throw new Error(data?.error || 'Failed to save team');
    }
    closeTeamEditor();
    await refreshTeamData();
  } catch (err) {
    console.error('[chat] Failed to save team:', err);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
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

function getRoleDisplayName(member) {
  const slug = member.roleSlug || member.role || member.roleName || '';
  if (!slug) return '';
  const templates = getTeamRoleTemplates();
  const match = templates.find(t => {
    // Backend templates use `slug`; local fallback templates use `key`
    const tSlug = t.slug || t.key || '';
    const tDisplay = t.displayName || t.name || '';
    return tSlug === slug ||
      slugifyTeamKey(tDisplay) === slug ||
      tDisplay.toLowerCase() === slug.toLowerCase();
  });
  // Backend uses `displayName`; local fallback uses `name`
  return match?.displayName || match?.name || slug;
}

// ── Rendering: Team ─────────────────────────────────────────────────

function renderTeam() {
  const section = _container?.querySelector('#chat-team-section');
  if (!section) return;

  const titleEl = _container.querySelector('#chat-team-title');
  const summaryEl = _container.querySelector('#chat-team-summary');
  const cardEl = _container.querySelector('#chat-team-card');
  const statusBadge = _container.querySelector('#chat-team-status-badge');
  const modeChip = _container.querySelector('#chat-team-mode-chip');
  const runChip = _container.querySelector('#chat-team-run-chip');
  const metaRow = _container.querySelector('#chat-team-meta');
  const createBtn = _container.querySelector('#chat-team-create');
  const membersBtn = _container.querySelector('#chat-team-members-btn');
  const runBtn = _container.querySelector('#chat-team-run');
  const editBtn = _container.querySelector('#chat-team-edit');
  const pauseBtn = _container.querySelector('#chat-team-pause');
  const disbandBtn = _container.querySelector('#chat-team-disband');

  const hasTeam = Boolean(_teamState);
  const isDisbanded = hasTeam && String(_teamState.status || '').toLowerCase() === 'disbanded';

  if (cardEl) cardEl.classList.toggle('hidden', !hasTeam);
  if (statusBadge) statusBadge.classList.toggle('hidden', !hasTeam);
  if (metaRow) metaRow.classList.toggle('hidden', !hasTeam);
  if (createBtn) createBtn.classList.toggle('hidden', (hasTeam && !isDisbanded) || _teamLoading);
  if (membersBtn) membersBtn.classList.toggle('hidden', !hasTeam || isDisbanded);

  if (!hasTeam) {
    if (titleEl) titleEl.textContent = 'Team';
    if (summaryEl) summaryEl.textContent = _teamLoading ? 'Loading…' : 'No active team for this project.';
    renderTeamProposals();
    renderTeamRoles();
    return;
  }

  const teamName = _teamState.name || _teamState.teamName || '';
  if (titleEl) titleEl.textContent = 'Team';
  if (summaryEl) summaryEl.textContent = teamName;

  const statusLabel = getTeamStatusLabel(_teamState);
  if (statusBadge) {
    const s = statusLabel.toLowerCase();
    statusBadge.textContent = statusLabel;
    statusBadge.className = 'chat-team-badge ' +
      (s === 'paused' ? 'paused' : s === 'disbanded' ? 'disbanded' : s === 'active' ? '' : 'inactive');
  }

  if (modeChip) {
    modeChip.textContent = getTeamModeLabel(_teamState.dispatchMode || _teamState.mode);
  }

  if (runChip) {
    const activeRun = _teamState.activeRun || _teamState.currentRun;
    runChip.textContent = activeRun
      ? `Run ${String(activeRun.id || '').slice(0, 6)}`
      : 'No run';
  }

  const status = String(_teamState.status || '').toLowerCase();
  const isPaused = status === 'paused';
  if (runBtn) runBtn.disabled = isDisbanded || isPaused;
  if (editBtn) editBtn.disabled = isDisbanded;
  if (pauseBtn) {
    pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    pauseBtn.disabled = isDisbanded;
  }
  if (disbandBtn) disbandBtn.disabled = isDisbanded;

  renderTeamRoster();
  renderTeamProposals();
  renderTeamRoles();
}

function renderTeamRoster() {
  const el = _container?.querySelector('#chat-team-roster');
  if (!el) return;
  el.innerHTML = '';

  const roster = getTeamRoster();
  if (roster.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-team-proposal-empty';
    empty.textContent = 'No members assigned.';
    el.appendChild(empty);
    return;
  }

  for (const member of roster) {
    const memberName = member.participantName || member.name || member.participant || member.member || '';
    const row = document.createElement('div');
    row.className = 'chat-team-member';

    const participant = findParticipant(memberName);
    const isDetached = participant?.detached;
    const isOnline = Boolean(participant?.paneId) && !isDetached;
    const dot = document.createElement('span');
    dot.className = 'chat-team-online-dot' + (isDetached ? ' detached' : !isOnline ? ' offline' : '');

    const name = document.createElement('span');
    name.className = 'chat-team-member-name';
    name.textContent = memberName || '?';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chat-team-member-remove-btn';
    removeBtn.title = `Remove ${memberName} from team`;
    removeBtn.setAttribute('aria-label', `Remove ${memberName} from team`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      try {
        await removeMemberFromTeam(memberName);
        await refreshTeamData();
      } catch (err) {
        console.error('[chat] Member remove failed:', err);
        removeBtn.disabled = false;
      }
    });

    row.appendChild(dot);
    row.appendChild(name);

    const roleLabel = getRoleDisplayName(member);
    if (roleLabel) {
      const chip = document.createElement('span');
      chip.className = 'chat-team-role-chip';
      chip.textContent = roleLabel;
      row.appendChild(chip);
    }

    row.appendChild(removeBtn);
    el.appendChild(row);
  }
}

function renderTeamProposals() {
  const el = _container?.querySelector('#chat-team-proposals-list');
  if (!el) return;
  el.innerHTML = '';

  const proposals = getTeamProposals();
  if (proposals.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-team-proposal-empty';
    empty.textContent = 'No pending proposals.';
    el.appendChild(empty);
    return;
  }

  for (const proposal of proposals) {
    const item = document.createElement('div');
    item.className = 'chat-team-proposal';

    const title = document.createElement('div');
    title.className = 'chat-team-proposal-title';
    title.textContent = proposal.title || proposal.name
      || `Proposal ${String(proposal.id || '').slice(0, 6)}`;
    item.appendChild(title);

    if (proposal.description && (proposal.title || proposal.name)) {
      const desc = document.createElement('div');
      desc.className = 'chat-team-proposal-desc';
      desc.textContent = proposal.description;
      item.appendChild(desc);
    }

    if (isTeamProposalPending(proposal)) {
      const actions = document.createElement('div');
      actions.className = 'chat-team-proposal-actions';

      for (const [label, action, variant] of [
        ['Approve', 'approve', 'btn-primary'],
        ['Reject', 'reject', 'btn-ghost'],
        ['Dismiss', 'dismiss', 'btn-ghost'],
      ]) {
        const btn = document.createElement('button');
        btn.className = `btn ${variant} btn-sm`;
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.disabled = true;
          try {
            await teamProposalAction(proposal.id, action);
            queueTeamRefresh(500);
          } catch {
            btn.disabled = false;
          }
        });
        actions.appendChild(btn);
      }

      item.appendChild(actions);
    }

    el.appendChild(item);
  }
}

function renderTeamRoles() {
  const el = _container?.querySelector('#chat-team-roles-modal-list');
  if (!el) return;
  el.innerHTML = '';

  const roles = getTeamRoleTemplates();
  if (roles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-team-proposal-empty';
    empty.textContent = 'No role templates available.';
    el.appendChild(empty);
    return;
  }

  for (const role of roles) {
    const item = document.createElement('div');
    item.className = 'chat-team-role-item';

    const nameEl = document.createElement('div');
    nameEl.className = 'chat-team-role-name';
    // Backend uses `displayName`; local fallback templates use `name`
    nameEl.textContent = role.displayName || role.name;

    const summaryEl = document.createElement('div');
    summaryEl.className = 'chat-team-role-summary';
    // Backend uses `description`; local fallback templates use `summary`
    summaryEl.textContent = role.description || role.summary;

    item.appendChild(nameEl);
    item.appendChild(summaryEl);

    const handoffs = Array.isArray(role.handoffTargets) ? role.handoffTargets : [];
    if (handoffs.length > 0) {
      const metaEl = document.createElement('div');
      metaEl.className = 'chat-team-role-meta';
      metaEl.textContent = `Handoffs: ${handoffs.join(', ')}`;
      item.appendChild(metaEl);
    }

    el.appendChild(item);
  }
}

// ── Rendering: Messages ─────────────────────────────────────────────

function renderAllMessages() {
  const listEl = _container?.querySelector('#chat-messages-list');
  if (!listEl) return;

  listEl.innerHTML = '';
  const entries = getTimelineEntries();
  for (const entry of entries) {
    if (entry.kind === 'message') appendMessageEl(entry.payload, false);
    else appendPipeEventTimelineEl(entry.payload, false);
  }

  if (listEl.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty-state';
    empty.innerHTML = `
      <div class="chat-empty-icon">\u275D</div>
      <div>No messages yet</div>
      <div class="chat-empty-hint">Send a message or add an LLM from Shell, then join with chat_join</div>
    `;
    listEl.appendChild(empty);
    return;
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

  let el = document.createElement('div');
  el.className = 'chat-msg';
  el.dataset.id = msg.id;

  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave') {
    el.classList.add('from-system');
    el.textContent = msg.body;
    // Brainstorm review messages get action buttons
    const bsMatch = msg.body.match(/#brainstorm-([a-z0-9]+)/);
    if (bsMatch) {
      const bsId = bsMatch[1];
      // During historical render (!doScroll) disable buttons if the brainstorm
      // has advanced past the review phase or is no longer active.
      // Live messages (doScroll) always get active buttons.
      const stale = (phase) => !doScroll && (!_brainstorms[bsId] || _brainstorms[bsId].phase !== phase);
      if (msg.body.includes('Ideas phase complete') || msg.body.includes('Returning to ideas phase')) {
        const panel = buildBrainstormActions(bsId, 'ideas_review');
        if (stale('ideas_review')) panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
        el.appendChild(panel);
      } else if (msg.body.includes('Detail pass complete')) {
        const panel = buildBrainstormActions(bsId, 'details_review');
        if (stale('details_review')) panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
        el.appendChild(panel);
      }
    }
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
    if (msg.unresolvedTargets?.length > 0) {
      const warn = document.createElement('div');
      warn.className = 'chat-msg-unresolved-warn';
      warn.textContent = msg.unresolvedTargets.map(t => `⚠ @${t} not found — message not delivered via PTY`).join('\n');
      el.appendChild(warn);
    }
  } else if (pipeRole && pipeRole !== 'final' && ['stage-output', 'fan-out'].includes(pipeRole)) {
    // ── Pipe intermediate: rendered separately via pipe-event channel ──
    return;
  } else {
    // ── Regular LLM message or pipe final ──
    const color = getParticipantColor(findParticipant(msg.from));
    const isPipeFinal = pipeRole === 'final' && msg.pipe?.pipeId;
    if (isPipeFinal) {
      el = buildPipeOutputEl({
        id: msg.id,
        from: msg.from,
        to: msg.to,
        pipeId: msg.pipe.pipeId,
        label: 'Final output',
        content: msg.body,
        ts: msg.ts,
        color,
      });
    } else {
      el.classList.add('from-llm');
      el.style.borderLeftColor = color;
      const sender = createSenderEl(msg.from + (msg.to ? ` \u2192 ${msg.to}` : ''), color);
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
  const pipeAssigneeMatch = before.match(/^\/(linear-pipe|merge-pipe|merge-all-pipe|explain(?:-pipe)?|summarize(?:-pipe)?)\s+[^:]*@(\w*)$/);
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
    if (names[i] === 'all') {
      item.innerHTML = `<span style="font-weight:600">@all</span> <span style="opacity:0.5;font-size:11px">Broadcast to all participants</span>`;
    } else {
      item.textContent = '@' + names[i];
    }
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
    const [messagesRes, pipeEventsRes, membersRes, brainstormsRes] = await Promise.all([
      api('/messages?limit=50'),
      api('/pipe-events?limit=200'),
      api('/members'),
      api('/brainstorms'),
    ]);
    if (brainstormsRes.ok) {
      _brainstorms = {};
      for (const bs of await brainstormsRes.json()) _brainstorms[bs.id] = bs;
    }
    if (messagesRes.ok) {
      _messages = mergeById(_messages, await messagesRes.json());
    }
    if (pipeEventsRes.ok) {
      _pipeEvents = mergeById(_pipeEvents, await pipeEventsRes.json());
    }
    if (membersRes.ok) {
      _members = (await membersRes.json()).map(m => m.kind === 'llm' ? { ...m, status: 'idle' } : m);
    }
    renderMembers();
    await fetchPipes();
    renderAllMessages();
    refreshTeamData().catch(() => {});
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
    _pipeEvents = [];
    renderAllMessages();
  });

  _container.querySelector('#chat-btn-rules')?.addEventListener('click', openRulesEditor);
  _container.querySelector('#chat-rules-close')?.addEventListener('click', closeRulesEditor);
  _container.querySelector('#chat-rules-save')?.addEventListener('click', saveRules);
  _container.querySelector('#chat-rules-reset')?.addEventListener('click', resetRules);
  _container.querySelector('#chat-pipes-toggle')?.addEventListener('click', () => {
    _pipesCollapsed = !_pipesCollapsed;
    renderPipes();
  });

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

  // ── Team bindings ──
  _container.querySelector('#chat-team-roles-trigger')?.addEventListener('click', openTeamRolesDialog);
  _container.querySelector('#chat-team-members-btn')?.addEventListener('click', openTeamMembersDialog);
  _container.querySelector('#chat-team-create')?.addEventListener('click', openTeamEditor);
  _container.querySelector('#chat-team-refresh')?.addEventListener('click', () => refreshTeamData().catch(() => {}));

  _container.querySelector('#chat-team-run')?.addEventListener('click', async () => {
    // Capture run prompt via the note modal (backend requires non-empty prompt)
    const titleEl = _container.querySelector('#chat-note-title');
    const textareaEl = _container.querySelector('#chat-note-textarea');
    const prevTitle = titleEl?.textContent;
    const prevPlaceholder = textareaEl?.placeholder;
    if (titleEl) titleEl.textContent = 'Start Team Run';
    if (textareaEl) textareaEl.placeholder = 'Describe the run goal (required)…';

    const prompt = await openNoteModal();

    if (titleEl) titleEl.textContent = prevTitle ?? 'Add a Note';
    if (textareaEl) textareaEl.placeholder = prevPlaceholder ?? 'Optional note...';

    if (prompt === undefined) return; // user cancelled
    if (!prompt?.trim()) return;      // empty — backend requires non-empty prompt

    const btn = _container.querySelector('#chat-team-run');
    if (btn) btn.disabled = true;
    try {
      const res = await api('/team/run', {
        method: 'POST',
        body: getTeamActionBody({ prompt: prompt.trim() }),
      });
      if (!res.ok) {
        const data = await parseJsonSafely(res);
        console.error('[chat] Team run failed:', data?.error);
      }
      queueTeamRefresh();
    } catch (err) {
      console.error('[chat] Team run error:', err);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  _container.querySelector('#chat-team-edit')?.addEventListener('click', openTeamEditor);

  _container.querySelector('#chat-team-pause')?.addEventListener('click', async () => {
    const action = String(_teamState?.status || '').toLowerCase() === 'paused' ? 'resume' : 'pause';
    const btn = _container.querySelector('#chat-team-pause');
    if (btn) btn.disabled = true;
    try { await teamAction(action); } catch { /* no-op */ } finally {
      if (btn) btn.disabled = false;
    }
  });

  _container.querySelector('#chat-team-disband')?.addEventListener('click', openTeamDisbandDialog);

  _container.querySelector('#chat-team-editor-close')?.addEventListener('click', closeTeamEditor);
  _container.querySelector('#chat-team-editor-cancel')?.addEventListener('click', closeTeamEditor);
  _container.querySelector('#chat-team-editor-save')?.addEventListener('click', saveTeamFromEditor);
  _container.querySelector('#chat-team-roles-close')?.addEventListener('click', closeTeamRolesDialog);
  _container.querySelector('#chat-team-roles-done')?.addEventListener('click', closeTeamRolesDialog);
  _container.querySelector('#chat-team-disband-close')?.addEventListener('click', closeTeamDisbandDialog);
  _container.querySelector('#chat-team-disband-cancel')?.addEventListener('click', closeTeamDisbandDialog);
  _container.querySelector('#chat-team-disband-confirm')?.addEventListener('click', confirmTeamDisband);
  _container.querySelector('#chat-team-members-close')?.addEventListener('click', closeTeamMembersDialog);
  _container.querySelector('#chat-team-members-done')?.addEventListener('click', closeTeamMembersDialog);

  for (const [overlayId, closeHandler] of [
    ['chat-team-overlay', closeTeamEditor],
    ['chat-team-roles-overlay', closeTeamRolesDialog],
    ['chat-team-disband-overlay', closeTeamDisbandDialog],
    ['chat-team-members-overlay', closeTeamMembersDialog],
  ]) {
    const overlay = _container.querySelector(`#${overlayId}`);
    overlay?.addEventListener('click', (event) => {
      if (event.target?.id === overlayId) closeHandler();
    });
    overlay?.addEventListener('keydown', onTeamDialogKeyDown);
  }
}

// ── Exports ─────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
  _projectId = ctx?.project?.id || null;
  _messages = [];
  _pipeEvents = [];
  _members = [];
  _pipeSummaries = [];
  _pipeLeases = [];
  _pipeDeadLetters = [];
  _pipeStatusById = {};
  _pipeStatusLoading = new Set();
  _pipeTimingById = {};
  _pipeTimingLoading = new Set();
  _pipesCollapsed = false;
  _expandedPipeId = null;
  _showAllPipes = false;
  _autoScroll = true;
  _rulesDraft = '';
  _rulesLoaded = false;
  _teamState = null;
  _teamLoading = false;
  _teamDraft = null;
  _teamRoles = [];
  if (_teamRefreshTimer) { clearTimeout(_teamRefreshTimer); _teamRefreshTimer = null; }
  _teamFormMode = 'edit';
  _teamActiveDialog = null;
  _teamDialogReturnFocus = null;

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
  startPipePolling();
  startLeaseCountdown();

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
  stopPipePolling();
  stopLeaseCountdown();
  container.classList.remove('page-chat', 'app-page');
  container.innerHTML = '';
  _container = null;
  _projectId = null;
  _messages = [];
  _pipeEvents = [];
  _members = [];
  _pipeSummaries = [];
  _pipeLeases = [];
  _pipeDeadLetters = [];
  _pipeStatusById = {};
  _pipeStatusLoading = new Set();
  _pipeTimingById = {};
  _pipeTimingLoading = new Set();
  _pipesCollapsed = false;
  _expandedPipeId = null;
  _showAllPipes = false;
  _brainstorms = {};
  _rulesDraft = '';
  _rulesLoaded = false;
  _teamState = null;
  _teamLoading = false;
  _teamDraft = null;
  _teamRoles = [];
  if (_teamRefreshTimer) { clearTimeout(_teamRefreshTimer); _teamRefreshTimer = null; }
  _teamFormMode = 'edit';
  _teamActiveDialog = null;
  _teamDialogReturnFocus = null;

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
  _pipeEvents = [];
  _members = [];
  _pipeSummaries = [];
  _pipeLeases = [];
  _pipeDeadLetters = [];
  _pipeStatusById = {};
  _pipeStatusLoading = new Set();
  _pipeTimingById = {};
  _pipeTimingLoading = new Set();
  _pipesCollapsed = false;
  _expandedPipeId = null;
  _showAllPipes = false;
  _brainstorms = {};
  _rulesDraft = '';
  _rulesLoaded = false;
  _teamState = null;
  _teamLoading = false;
  _teamDraft = null;
  _teamRoles = [];
  if (_teamRefreshTimer) { clearTimeout(_teamRefreshTimer); _teamRefreshTimer = null; }
  _teamFormMode = 'edit';
  _teamActiveDialog = null;
  _teamDialogReturnFocus = null;

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
