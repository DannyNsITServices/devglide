// ── Workflow Editor — Observable State Store ────────────────────────────
// Granular event-driven state with wildcard support.

export class Store {
  constructor() {
    this._state = {
      workflow: null,         // Current workflow being edited
      selectedNodeIds: new Set(),
      selectedEdgeIds: new Set(),
      zoom: 1,
      panX: 0,
      panY: 0,
      mode: 'select',         // 'select' | 'connect' | 'pan'
      isDirty: false,
      runId: null,            // Active run ID
      nodeStates: new Map(),  // Runtime node states during execution
    };
    this._listeners = new Map(); // event -> Set<fn>
  }

  get(key) {
    return this._state[key];
  }

  set(key, value) {
    const old = this._state[key];
    this._state[key] = value;
    this._emit(key, value, old);
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, ...args) {
    this._listeners.get(event)?.forEach(fn => {
      try { fn(...args); } catch { /* listener errors must not break store */ }
    });
    this._listeners.get('*')?.forEach(fn => {
      try { fn(event, ...args); } catch { /* swallow */ }
    });
  }
}

export const store = new Store();
