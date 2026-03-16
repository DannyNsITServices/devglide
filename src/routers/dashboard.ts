import { Router } from 'express';
import type { Namespace } from 'socket.io';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  listProjects,
  addProject,
  removeProject,
  updateProject,
  activateProject,
  getActiveProject,
} from '../packages/project-store.js';
import { setActiveProject } from '../project-context.js';

export const router: Router = Router();

let dashboardNsp: Namespace | null = null;

// ── REST API: Project context ──────────────────────────────────────────────

router.get('/projects', (_req, res) => {
  res.json(listProjects());
});

router.post('/projects', (req, res) => {
  try {
    const project = addProject(req.body?.name, req.body?.path);
    dashboardNsp?.emit('project:list', listProjects());
    res.status(201).json(project);
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

router.delete('/projects/:id', (req, res) => {
  const removed = removeProject(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Project not found' });
  const store = listProjects();
  dashboardNsp?.emit('project:list', store);
  dashboardNsp?.emit('project:active', store.activeProjectId
    ? store.projects.find((p) => p.id === store.activeProjectId) ?? null
    : null);
  const active = getActiveProject();
  setActiveProject(active ? { id: active.id, name: active.name, path: active.path } : null);
  res.json({ ok: true });
});

router.put('/projects/:id', (req, res) => {
  try {
    const project = updateProject(req.params.id, { name: req.body?.name, path: req.body?.path });
    const store = listProjects();
    dashboardNsp?.emit('project:list', store);
    const active = getActiveProject();
    if (active && active.id === req.params.id) {
      dashboardNsp?.emit('project:active', project);
      setActiveProject({ id: project.id, name: project.name, path: project.path });
    }
    res.json(project);
  } catch (err: unknown) {
    const status = (err instanceof Error ? err.message : String(err)) === 'Project not found' ? 404 : 400;
    res.status(status).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

router.put('/projects/:id/activate', (req, res) => {
  const project = activateProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  dashboardNsp?.emit('project:active', project);
  setActiveProject({ id: project.id, name: project.name, path: project.path });
  res.json(project);
});

// ── REST API: Directory browsing ─────────────────────────────────────────────

router.get('/browse', (req, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  const target = resolve(raw || homedir());

  try {
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }
  } catch {
    return res.status(400).json({ error: 'Path does not exist' });
  }

  try {
    const entries = readdirSync(target, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({ path: target, dirs });
  } catch {
    res.status(403).json({ error: 'Cannot read directory' });
  }
});

// ── Socket.io namespace initializer ────────────────────────────────────────

export function initDashboard(nsp: Namespace): void {
  dashboardNsp = nsp;

  nsp.on('connection', (socket) => {
    socket.emit('project:active', getActiveProject());
    socket.emit('project:list', listProjects());

    socket.on('project:activate', ({ id }) => {
      const project = activateProject(id);
      if (project) {
        nsp.emit('project:active', project);
        setActiveProject({ id: project.id, name: project.name, path: project.path });
      }
    });

    socket.on('project:add', ({ name, path: projectPath }, ack) => {
      try {
        const project = addProject(name, projectPath);
        nsp.emit('project:list', listProjects());
        if (typeof ack === 'function') ack({ ok: true, project });
      } catch (err: unknown) {
        if (typeof ack === 'function') ack({ ok: false, error: (err instanceof Error ? err.message : String(err)) });
      }
    });

    socket.on('project:remove', ({ id }, ack) => {
      const removed = removeProject(id);
      if (removed) {
        const store = listProjects();
        nsp.emit('project:list', store);
        nsp.emit('project:active', store.activeProjectId
          ? store.projects.find((p) => p.id === store.activeProjectId) ?? null
          : null);
        const active = getActiveProject();
        setActiveProject(active ? { id: active.id, name: active.name, path: active.path } : null);
      }
      if (typeof ack === 'function') ack({ ok: removed });
    });

    socket.on('project:update', ({ id, name, path: projectPath }, ack) => {
      try {
        const project = updateProject(id, { name, path: projectPath });
        nsp.emit('project:list', listProjects());
        const active = getActiveProject();
        if (active && active.id === id) {
          nsp.emit('project:active', project);
          setActiveProject({ id: project.id, name: project.name, path: project.path });
        }
        if (typeof ack === 'function') ack({ ok: true, project });
      } catch (err: unknown) {
        if (typeof ack === 'function') ack({ ok: false, error: (err instanceof Error ? err.message : String(err)) });
      }
    });
  });
}
