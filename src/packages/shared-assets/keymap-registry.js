/**
 * DevGlide Keymap Registry
 *
 * Global, platform-aware keymap registry loaded via <script> tag.
 * Manages default bindings, user overrides (persisted to localStorage),
 * and provides matching / formatting utilities for keyboard shortcuts.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'devglide:keymap';

  // ---------------------------------------------------------------------------
  // Platform detection
  // ---------------------------------------------------------------------------

  var isMac = typeof navigator !== 'undefined' &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  /** @type {Map<string, {defaultBinding: object, description: string, group: string}>} */
  var actions = new Map();

  /** @type {Map<string, object>} user overrides keyed by actionId */
  var overrides = new Map();

  /** @type {Set<Function>} change listeners */
  var listeners = new Set();

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  function loadOverrides() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach(function (id) {
            overrides.set(id, parsed[id]);
          });
        }
      }
    } catch (_) { /* ignore corrupt data */ }
  }

  function saveOverrides() {
    try {
      var obj = {};
      overrides.forEach(function (binding, id) {
        obj[id] = binding;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (_) { /* storage full / unavailable */ }
  }

  // ---------------------------------------------------------------------------
  // Notify helpers
  // ---------------------------------------------------------------------------

  function notifyChange(actionId) {
    listeners.forEach(function (cb) {
      try { cb(actionId); } catch (_) { /* swallow listener errors */ }
    });
  }

  // ---------------------------------------------------------------------------
  // Modifier resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether a modifier flag matches the event.
   * Handles the special 'ctrlOrMeta' value.
   */
  function modifierMatches(bindingValue, eventCtrl, eventMeta) {
    if (bindingValue === true) return true;
    if (bindingValue === 'ctrlOrMeta') {
      return isMac ? eventMeta : eventCtrl;
    }
    return false;
  }

  function eventHasCtrlOrMeta(e) {
    return isMac ? e.metaKey : e.ctrlKey;
  }

  // ---------------------------------------------------------------------------
  // Matching helpers
  // ---------------------------------------------------------------------------

  var MODIFIER_KEYS = new Set([
    'Control', 'Alt', 'Shift', 'Meta',
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight',
    'MetaLeft', 'MetaRight',
  ]);

  function isModifierKey(event) {
    return MODIFIER_KEYS.has(event.key) || MODIFIER_KEYS.has(event.code);
  }

  /**
   * Check if a binding specifies a modifier-only combo (no key/code).
   */
  function isModifierOnly(binding) {
    return !binding.key && !binding.code;
  }

  /**
   * Check if a binding requires no modifiers at all.
   */
  function hasNoModifiers(binding) {
    return !binding.ctrlKey && !binding.altKey && !binding.shiftKey &&
      !binding.ctrlOrMeta && binding.ctrlOrMeta !== 'ctrlOrMeta' &&
      binding.ctrlKey !== 'ctrlOrMeta';
  }

  /**
   * Return true if `event` satisfies `binding`.
   */
  function bindingMatchesEvent(binding, event) {
    // --- Modifier checks ---

    // ctrlKey on binding
    var expectCtrl = binding.ctrlKey;
    var expectCtrlOrMeta = (binding.ctrlOrMeta === true) ||
      (binding.ctrlKey === 'ctrlOrMeta') ||
      (binding.ctrlOrMeta === 'ctrlOrMeta');

    if (expectCtrlOrMeta) {
      // On Mac: require metaKey, on Win/Linux: require ctrlKey
      if (isMac) {
        if (!event.metaKey) return false;
      } else {
        if (!event.ctrlKey) return false;
      }
    } else if (expectCtrl === true) {
      if (!event.ctrlKey) return false;
    } else {
      // No ctrl expected — but we must ensure the user isn't pressing ctrl
      // (unless ctrlOrMeta accounts for it on the platform)
      if (event.ctrlKey && !isMac) return false;
      // On Mac, ctrlKey can be physical Control which we might want to ignore
      // but for clean matching, if no ctrl is expected, reject if ctrl pressed
      if (event.ctrlKey && isMac) {
        // Allow ctrlKey on Mac if metaKey is what ctrlOrMeta maps to.
        // Actually, if we're here, there's no ctrlOrMeta, so reject.
        return false;
      }
    }

    // altKey
    if (binding.altKey) {
      if (!event.altKey) return false;
    } else {
      if (event.altKey) return false;
    }

    // shiftKey
    if (binding.shiftKey) {
      if (!event.shiftKey) return false;
    } else {
      if (event.shiftKey) return false;
    }

    // metaKey: if ctrlOrMeta is active and we're on Mac, we already checked
    // metaKey above.  Otherwise, meta should not be pressed (unless on Mac
    // where ctrlOrMeta covers it).
    if (!expectCtrlOrMeta) {
      if (isMac && event.metaKey) return false;
      if (!isMac && event.metaKey) return false;
    } else {
      // On the non-matching platform side, the other modifier should not be
      // pressed.  E.g. on Mac, ctrlOrMeta -> metaKey, so ctrlKey should be
      // false (unless it happens to also be pressed, which we'll be lenient
      // about — actually let's be strict for clean matching).
      // We already validated the primary; no extra check needed since we
      // checked ctrlKey above for non-ctrlOrMeta case.
    }

    // --- Key / Code checks ---

    if (isModifierOnly(binding)) {
      // Modifier-only binding: match when the event key is itself a modifier.
      return isModifierKey(event);
    }

    if (binding.code) {
      if (event.code !== binding.code) return false;
    }

    if (binding.key) {
      if (event.key !== binding.key) return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var KeymapRegistry = {

    /**
     * Register an action with its default key binding.
     */
    register: function (actionId, defaultBinding, description, group) {
      actions.set(actionId, {
        defaultBinding: defaultBinding,
        description: description || '',
        group: group || 'General',
      });
    },

    /**
     * Given a KeyboardEvent, return the matching actionId or null.
     */
    resolve: function (event) {
      var matched = null;
      actions.forEach(function (entry, actionId) {
        if (matched) return; // already found
        var binding = overrides.has(actionId)
          ? overrides.get(actionId)
          : entry.defaultBinding;
        if (bindingMatchesEvent(binding, event)) {
          matched = actionId;
        }
      });
      return matched;
    },

    /**
     * Return all registered actions grouped by their group name.
     * Each entry contains actionId, description, binding, defaultBinding,
     * and whether the binding has been overridden.
     */
    getAll: function () {
      var groups = {};
      actions.forEach(function (entry, actionId) {
        var group = entry.group;
        if (!groups[group]) groups[group] = [];
        var currentBinding = overrides.has(actionId)
          ? overrides.get(actionId)
          : entry.defaultBinding;
        groups[group].push({
          actionId: actionId,
          description: entry.description,
          group: group,
          binding: currentBinding,
          defaultBinding: entry.defaultBinding,
          overridden: overrides.has(actionId),
        });
      });
      return groups;
    },

    /**
     * Return the current binding for an action.
     */
    getBinding: function (actionId) {
      if (overrides.has(actionId)) return overrides.get(actionId);
      var entry = actions.get(actionId);
      return entry ? entry.defaultBinding : null;
    },

    /**
     * Set a user override for an action.
     */
    rebind: function (actionId, newBinding) {
      overrides.set(actionId, newBinding);
      saveOverrides();
      notifyChange(actionId);
    },

    /**
     * Remove the user override for a single action.
     */
    reset: function (actionId) {
      if (overrides.has(actionId)) {
        overrides.delete(actionId);
        saveOverrides();
        notifyChange(actionId);
      }
    },

    /**
     * Remove all user overrides.
     */
    resetAll: function () {
      var ids = Array.from(overrides.keys());
      overrides.clear();
      saveOverrides();
      ids.forEach(function (id) { notifyChange(id); });
    },

    /**
     * Format a binding for display.
     * Returns a string like "Ctrl+Alt+J" or "Cmd+Alt+J" on Mac.
     */
    formatBinding: function (binding) {
      if (!binding) return '';
      var parts = [];

      // ctrlOrMeta / ctrlKey
      var hasCtrlOrMeta = (binding.ctrlOrMeta === true) ||
        (binding.ctrlKey === 'ctrlOrMeta') ||
        (binding.ctrlOrMeta === 'ctrlOrMeta');
      if (hasCtrlOrMeta) {
        parts.push(isMac ? 'Cmd' : 'Ctrl');
      } else if (binding.ctrlKey === true) {
        parts.push('Ctrl');
      }

      if (binding.altKey) parts.push('Alt');
      if (binding.shiftKey) parts.push('Shift');

      // Key label
      var keyLabel = null;
      if (binding.code) {
        // Convert code to a readable label
        if (binding.code.startsWith('Digit')) {
          keyLabel = binding.code.replace('Digit', '');
        } else if (binding.code.startsWith('Key')) {
          keyLabel = binding.code.replace('Key', '');
        } else {
          keyLabel = binding.code;
        }
      } else if (binding.key) {
        // Friendly names for special keys
        var friendlyKeys = {
          'ArrowLeft': 'Left',
          'ArrowRight': 'Right',
          'ArrowUp': 'Up',
          'ArrowDown': 'Down',
          'Escape': 'Esc',
          ' ': 'Space',
          'Enter': 'Enter',
          'Backspace': 'Backspace',
          'Delete': 'Delete',
          'Tab': 'Tab',
        };
        keyLabel = friendlyKeys[binding.key] || binding.key;
      }

      if (keyLabel) parts.push(keyLabel);
      return parts.join('+');
    },

    /**
     * Given a KeyboardEvent, build and return a binding object.
     * Used by the settings UI key-capture recorder.
     */
    captureBinding: function (event) {
      var binding = {};

      // Determine modifier state
      if (isMac ? event.metaKey : event.ctrlKey) {
        binding.ctrlOrMeta = true;
      }
      if (binding.ctrlOrMeta && isMac && event.ctrlKey) {
        // User also pressed physical Ctrl on Mac alongside Cmd
        binding.ctrlKey = true;
      }
      if (!isMac && event.metaKey && !binding.ctrlOrMeta) {
        // Meta on non-Mac without ctrlOrMeta
        binding.ctrlOrMeta = true;
      }

      binding.altKey = event.altKey || false;
      binding.shiftKey = event.shiftKey || false;

      // Key / code
      if (!isModifierKey(event)) {
        // Prefer code for letter and digit keys
        if (event.code && (event.code.startsWith('Key') || event.code.startsWith('Digit'))) {
          binding.code = event.code;
        } else {
          binding.key = event.key;
        }
      }
      // If it's a modifier key, leave key/code absent (modifier-only combo)

      return binding;
    },

    /**
     * Export user overrides as a JSON string.
     */
    exportConfig: function () {
      var obj = {};
      overrides.forEach(function (binding, id) {
        obj[id] = binding;
      });
      return JSON.stringify(obj, null, 2);
    },

    /**
     * Import user overrides from a JSON string.
     * Replaces all current overrides.
     */
    importConfig: function (json) {
      var parsed;
      try {
        parsed = JSON.parse(json);
      } catch (_) {
        throw new Error('Invalid JSON for keymap config');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Keymap config must be a JSON object');
      }
      overrides.clear();
      Object.keys(parsed).forEach(function (id) {
        overrides.set(id, parsed[id]);
      });
      saveOverrides();
      // Notify for all imported actions
      Object.keys(parsed).forEach(function (id) { notifyChange(id); });
    },

    /**
     * Register a listener for binding changes.
     * Callback receives the actionId that changed.
     * Returns an unsubscribe function.
     */
    onChange: function (callback) {
      listeners.add(callback);
      return function () { listeners.delete(callback); };
    },

    /**
     * Check if a KeyboardEvent matches a specific action.
     */
    matchesAction: function (event, actionId) {
      var binding = overrides.has(actionId)
        ? overrides.get(actionId)
        : (actions.has(actionId) ? actions.get(actionId).defaultBinding : null);
      if (!binding) return false;
      return bindingMatchesEvent(binding, event);
    },

    /** Expose platform detection for consumers */
    isMac: isMac,
  };

  // ---------------------------------------------------------------------------
  // Initialisation — load overrides, register defaults
  // ---------------------------------------------------------------------------

  loadOverrides();

  // Shell group — All arrows navigate grid spatially
  KeymapRegistry.register('shell:terminal-down',
    { ctrlOrMeta: true, altKey: true, key: 'ArrowDown' },
    'Down terminal', 'Shell');

  KeymapRegistry.register('shell:terminal-up',
    { ctrlOrMeta: true, altKey: true, key: 'ArrowUp' },
    'Up terminal', 'Shell');

  KeymapRegistry.register('shell:terminal-right',
    { ctrlOrMeta: true, altKey: true, key: 'ArrowRight' },
    'Right terminal', 'Shell');

  KeymapRegistry.register('shell:terminal-left',
    { ctrlOrMeta: true, altKey: true, key: 'ArrowLeft' },
    'Left terminal', 'Shell');

  for (var i = 1; i <= 9; i++) {
    KeymapRegistry.register('shell:terminal-' + i,
      { ctrlOrMeta: true, altKey: true, code: 'Digit' + i },
      'Terminal ' + i, 'Shell');
  }

  KeymapRegistry.register('shell:new-terminal',
    { ctrlOrMeta: true, altKey: true, code: 'KeyJ' },
    'New terminal', 'Shell');

  KeymapRegistry.register('shell:new-browser',
    { ctrlOrMeta: true, altKey: true, code: 'KeyB' },
    'New browser', 'Shell');

  KeymapRegistry.register('shell:close-pane',
    { ctrlOrMeta: true, altKey: true, code: 'KeyK' },
    'Close pane', 'Shell');

  KeymapRegistry.register('shell:dashboard',
    { ctrlOrMeta: true, altKey: true, code: 'KeyD' },
    'Dashboard (grid view)', 'Shell');

  // Navigation group
  KeymapRegistry.register('nav:project-switcher',
    { ctrlOrMeta: true, altKey: true, code: 'KeyP' },
    'Project switcher', 'Navigation');

  // Voice group
  KeymapRegistry.register('voice:hold-to-speak',
    { ctrlOrMeta: true, altKey: true, shiftKey: true },
    'Hold to speak', 'Voice');

  // Kanban group
  KeymapRegistry.register('kanban:focus-search',
    { key: '/' },
    'Focus search', 'Kanban');

  KeymapRegistry.register('kanban:clear-search',
    { key: 'Escape' },
    'Clear search', 'Kanban');

  // ---------------------------------------------------------------------------
  // Expose globally
  // ---------------------------------------------------------------------------

  window.KeymapRegistry = KeymapRegistry;

})();
