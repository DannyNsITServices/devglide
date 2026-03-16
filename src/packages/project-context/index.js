/**
 * Shared project context consumer — connects to Dashboard for active project tracking.
 *
 * Usage:
 *   import { connectProjectContext } from '../../packages/project-context.js';
 *
 *   const projectCtx = connectProjectContext({ service: 'log' });
 *   projectCtx.active;          // current project or null
 *   projectCtx.onChange(cb);     // subscribe to project changes
 *   projectCtx.disconnect();    // for shutdown
 */

import { io as ioClient } from 'socket.io-client';

const DASHBOARD_URL = 'http://localhost:7000';

/**
 * Connect to Dashboard for project context.
 * @param {{ service: string, port?: number }} opts
 * @returns {{ active: object|null, onChange: (cb: function) => function, disconnect: () => void }}
 */
export function connectProjectContext({ service, port } = {}) {
  const url = port ? `http://localhost:${port}` : DASHBOARD_URL;
  const socket = ioClient(url, { reconnection: true });

  let active = null;
  const listeners = new Set();

  socket.on('project:active', (project) => {
    active = project;
    for (const cb of listeners) cb(project);
  });

  socket.on('connect', () => {
    if (service) console.log(`[${service}] Connected to Dashboard for project context`);
  });

  socket.on('connect_error', () => {
    // Dashboard may not be running — silently retry
  });

  return {
    get active() { return active; },

    /** Subscribe to project changes. Returns an unsubscribe function. */
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    disconnect() {
      socket.disconnect();
    },
  };
}
