// ── Workflow Editor — Undo/Redo History Manager ───────────────────────
// Command stack storing JSON snapshots, capped at 50 entries.

import { store } from '../state/store.js';

const MAX_HISTORY = 50;

let _stack = [];     // Array of JSON strings (workflow snapshots)
let _index = -1;     // Current position in the stack
let _unsub = null;   // Store subscription teardown
let _skipNext = false; // Prevent re-push during undo/redo restore

// ── Public API ──────────────────────────────────────────────────────────

export const HistoryManager = {
  /**
   * Initialize history tracking by subscribing to workflow changes.
   */
  init() {
    _stack = [];
    _index = -1;
    _skipNext = false;

    _unsub = store.on('workflow', (wf) => {
      if (_skipNext) {
        _skipNext = false;
        return;
      }
      if (!wf) return;
      this.push(wf);
    });

    // Keyboard shortcuts
    this._onKeyDown = (e) => {
      // Ctrl/Cmd+Z — undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (isInputFocused()) return;
        e.preventDefault();
        this.undo();
        return;
      }
      // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y — redo
      if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') ||
          ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
        if (isInputFocused()) return;
        e.preventDefault();
        this.redo();
        return;
      }
    };
    document.addEventListener('keydown', this._onKeyDown);
  },

  /**
   * Unsubscribe from the store.
   */
  destroy() {
    if (_unsub) {
      _unsub();
      _unsub = null;
    }
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    _stack = [];
    _index = -1;
  },

  /**
   * Push a workflow snapshot onto the history stack.
   * Truncates any redo entries ahead of the current index.
   * @param {object} state - Workflow object to snapshot
   */
  push(state) {
    const json = JSON.stringify(state);

    // Avoid duplicates (same as current top)
    if (_index >= 0 && _stack[_index] === json) return;

    // Truncate redo entries
    _stack = _stack.slice(0, _index + 1);
    _stack.push(json);

    // Cap at MAX_HISTORY
    if (_stack.length > MAX_HISTORY) {
      _stack.shift();
    }
    _index = _stack.length - 1;
  },

  /**
   * Restore the previous state.
   */
  undo() {
    if (!this.canUndo()) return;
    _index--;
    _skipNext = true;
    const snapshot = JSON.parse(_stack[_index]);
    store.set('workflow', snapshot);
    store.set('isDirty', true);
  },

  /**
   * Restore the next state (after an undo).
   */
  redo() {
    if (!this.canRedo()) return;
    _index++;
    _skipNext = true;
    const snapshot = JSON.parse(_stack[_index]);
    store.set('workflow', snapshot);
    store.set('isDirty', true);
  },

  /**
   * @returns {boolean}
   */
  canUndo() {
    return _index > 0;
  },

  /**
   * @returns {boolean}
   */
  canRedo() {
    return _index < _stack.length - 1;
  },

  /**
   * Clear all history.
   */
  clear() {
    _stack = [];
    _index = -1;
  },
};

/**
 * Check if an input/textarea/contenteditable is focused.
 */
function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}
