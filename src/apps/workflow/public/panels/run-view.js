// ── Workflow Editor — Execution Monitor ─────────────────────────────────
// SSE-driven run execution monitor with log output and node status updates.

import { store } from '../state/store.js';

const API = '/api/workflow';

let _container = null;
let _eventSource = null;
let _startTime = null;
let _timerInterval = null;
let _nodeStatusCb = null;
let _edgeTraversedCb = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function updateTimer() {
  if (!_container || !_startTime) return;
  const el = _container.querySelector('.wb-run-timer');
  if (el) {
    el.textContent = formatDuration(Date.now() - _startTime);
  }
}

function render(status = 'idle') {
  if (!_container) return;

  _container.innerHTML = `
    <div class="wb-run-bar">
      <span class="wb-run-status-indicator" style="width:7px;height:7px;border-radius:50%;
        background:var(--df-color-text-muted);flex-shrink:0;"></span>
      <span class="wb-run-status-text" style="text-transform:uppercase;
        letter-spacing:var(--df-letter-spacing-wider);">${esc(status)}</span>
      <span class="wb-run-timer" style="color:var(--df-color-text-muted);"></span>
      <span style="flex:1;"></span>
      <button class="btn btn-secondary wb-run-cancel" style="display:none;">Cancel</button>
      <button class="btn btn-secondary wb-run-toggle-log" title="Toggle log panel">Log</button>
    </div>
    <pre class="wb-run-log" style="display:none;"></pre>
  `;

  const toggleBtn = _container.querySelector('.wb-run-toggle-log');
  const logPanel = _container.querySelector('.wb-run-log');
  if (toggleBtn && logPanel) {
    toggleBtn.addEventListener('click', () => {
      logPanel.style.display = logPanel.style.display === 'none' ? 'block' : 'none';
    });
  }
}

function setStatus(status) {
  if (!_container) return;

  const indicator = _container.querySelector('.wb-run-status-indicator');
  const statusText = _container.querySelector('.wb-run-status-text');
  const cancelBtn = _container.querySelector('.wb-run-cancel');

  if (statusText) statusText.textContent = status;

  if (indicator) {
    switch (status) {
      case 'running':
        indicator.style.background = 'var(--df-color-state-recording)';
        break;
      case 'passed':
        indicator.style.background = 'var(--df-color-state-success)';
        break;
      case 'failed':
        indicator.style.background = 'var(--df-color-state-error)';
        break;
      default:
        indicator.style.background = 'var(--df-color-text-muted)';
    }
  }

  if (cancelBtn) {
    cancelBtn.style.display = status === 'running' ? '' : 'none';
  }
}

function appendLog(text) {
  if (!_container) return;
  const logPanel = _container.querySelector('.wb-run-log');
  if (!logPanel) return;
  logPanel.textContent += text;

  // Only auto-scroll if user is already near the bottom
  const isNearBottom = (logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight) < 50;
  if (isNearBottom) {
    logPanel.scrollTop = logPanel.scrollHeight;
  }

  // Auto-show log on first output
  if (logPanel.style.display === 'none') {
    logPanel.style.display = 'block';
  }
}

function handleSSEMessage(msg) {
  switch (msg.type) {
    case 'snapshot': {
      setStatus('running');
      if (msg.run?.nodes) {
        const nodeStates = new Map();
        for (const n of msg.run.nodes) {
          nodeStates.set(n.id, n.status || 'pending');
        }
        store.set('nodeStates', nodeStates);
      }
      break;
    }

    case 'node_start': {
      setStatus('running');
      const states = store.get('nodeStates') ?? new Map();
      states.set(msg.nodeId, 'running');
      store.set('nodeStates', new Map(states));
      _nodeStatusCb?.(msg.nodeId, 'running');
      appendLog(`\n> Starting: ${msg.label ?? msg.nodeId}\n`);
      break;
    }

    case 'output': {
      appendLog(msg.data ?? '');
      break;
    }

    case 'node_done': {
      const status = msg.exitCode === 0 ? 'passed' : 'failed';
      const states = store.get('nodeStates') ?? new Map();
      states.set(msg.nodeId, status);
      store.set('nodeStates', new Map(states));
      _nodeStatusCb?.(msg.nodeId, status);
      appendLog(`  ${status === 'passed' ? '\u2713' : '\u2717'} ${msg.label ?? msg.nodeId} (${formatDuration(msg.duration ?? 0)})\n`);
      break;
    }

    case 'edge_traversed': {
      _edgeTraversedCb?.(msg.edgeId);
      break;
    }

    case 'done': {
      const finalStatus = msg.status ?? 'passed';
      setStatus(finalStatus);
      if (_timerInterval) {
        clearInterval(_timerInterval);
        _timerInterval = null;
      }
      if (_startTime) {
        appendLog(`\nCompleted: ${finalStatus} in ${formatDuration(Date.now() - _startTime)}\n`);
      }
      store.set('runId', null);
      closeSSE();
      break;
    }
  }
}

function closeSSE() {
  if (_eventSource) {
    _eventSource.close();
    _eventSource = null;
  }
}

// ── Exports ─────────────────────────────────────────────────────────────

export const RunView = {
  /**
   * Mount the run panel into a container.
   * @param {HTMLElement} container
   */
  mount(container) {
    _container = container;
    render('idle');
  },

  /**
   * Unmount and clean up resources.
   */
  unmount() {
    closeSSE();
    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }
    if (_container) _container.innerHTML = '';
    _container = null;
    _nodeStatusCb = null;
    _edgeTraversedCb = null;
  },

  /**
   * Start monitoring a workflow run via SSE.
   * @param {string} runId
   */
  startRun(runId) {
    closeSSE();
    if (_timerInterval) clearInterval(_timerInterval);

    store.set('runId', runId);
    _startTime = Date.now();
    render('running');
    setStatus('running');

    // Start duration timer
    _timerInterval = setInterval(updateTimer, 500);

    // Wire cancel button
    const cancelBtn = _container?.querySelector('.wb-run-cancel');
    if (cancelBtn) {
      cancelBtn.style.display = '';
      cancelBtn.addEventListener('click', () => this.stopRun());
    }

    // Connect to SSE stream
    _eventSource = new EventSource(`${API}/runs/${runId}/stream`);
    _eventSource.onmessage = (e) => {
      try {
        handleSSEMessage(JSON.parse(e.data));
      } catch { /* swallow parse errors */ }
    };
    _eventSource.onerror = () => {
      closeSSE();
      setStatus('disconnected');
      if (_timerInterval) {
        clearInterval(_timerInterval);
        _timerInterval = null;
      }
      store.set('runId', null);
    };
  },

  /**
   * Cancel the active run.
   */
  async stopRun() {
    const runId = store.get('runId');
    if (runId) {
      try {
        await fetch(`${API}/runs/${runId}/cancel`, { method: 'POST' });
      } catch { /* swallow */ }
    }
    closeSSE();
    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }
    setStatus('cancelled');
    store.set('runId', null);
  },

  /**
   * Register callback for node status changes during execution.
   * @param {function} callback - Receives (nodeId, status)
   */
  onNodeStatus(callback) {
    _nodeStatusCb = callback;
  },

  /**
   * Register callback for edge traversal events during execution.
   * @param {function} callback - Receives (edgeId)
   */
  onEdgeTraversed(callback) {
    _edgeTraversedCb = callback;
  },
};
