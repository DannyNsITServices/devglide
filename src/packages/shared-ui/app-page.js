// ── AppPage — Shared base class for dashboard apps ──────────────────────────
// Provides lifecycle management, scoped DOM queries, and project-aware API fetch.
// Subclass and override init(), destroy(), reload(), and set BODY_HTML.
// Heavier apps can import individual helpers (api, $, $$) without subclassing.

export class AppPage {
  /** @param {string} appName — used for CSS class (page-{name}) and API prefix (/api/{name}) */
  constructor(appName) {
    this.appName = appName;
    this.container = null;
    this.projectId = null;
  }

  // ── Lifecycle (called by the dashboard) ─────────────────────────────────

  mount(container, ctx) {
    this.container = container;
    this.projectId = ctx?.project?.id ?? null;
    container.classList.add(`page-${this.appName}`);
    if (this.BODY_HTML) container.innerHTML = this.BODY_HTML;
    this.init();
  }

  unmount(container) {
    this.destroy();
    container.classList.remove(`page-${this.appName}`);
    container.innerHTML = '';
    this.container = null;
    this.projectId = null;
  }

  onProjectChange(project) {
    this.projectId = project?.id ?? null;
    this.reload();
  }

  // ── Subclass hooks (override these) ─────────────────────────────────────

  /** Called after mount — attach listeners, load initial data. */
  init() {}

  /** Called before unmount — cleanup timers, listeners, state. */
  destroy() {}

  /** Called on project change — refresh data for new project. */
  reload() {}

  // ── DOM helpers (scoped to container) ───────────────────────────────────

  $(selector) {
    return this.container?.querySelector(selector) ?? null;
  }

  $$(selector) {
    return this.container?.querySelectorAll(selector) ?? [];
  }

  // ── API helper (project-aware fetch) ────────────────────────────────────

  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    return fetch(`/api/${this.appName}${path}`, { ...opts, headers });
  }
}

// ── Standalone helpers for composition (no subclassing required) ─────────────

/**
 * Create a scoped querySelector bound to a container element.
 * @param {HTMLElement} container
 * @returns {{ $: (sel: string) => Element|null, $$: (sel: string) => NodeListOf<Element> }}
 */
export function createScopedQueries(container) {
  return {
    $(sel) { return container?.querySelector(sel) ?? null; },
    $$(sel) { return container?.querySelectorAll(sel) ?? []; },
  };
}

/**
 * Create a project-aware fetch helper for a specific app.
 * @param {string} appName — API route prefix (e.g. 'prompts' -> /api/prompts)
 * @returns {(path: string, opts?: RequestInit) => Promise<Response>}
 */
export function createApi(appName) {
  return function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    return fetch(`/api/${appName}${path}`, { ...opts, headers });
  };
}
