import { Router } from 'express';
import type { Namespace } from 'socket.io';
import { z } from 'zod';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { asyncHandler, errorMessage } from '../packages/error-middleware.js';
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

// ── Zod schemas ──────────────────────────────────────────────────────────────

const createProjectSchema = z.object({
  name: z.string().min(1, 'name is required'),
  path: z.string().min(1, 'path is required'),
});

const updateProjectSchema = createProjectSchema.partial();

const projectIdParamSchema = z.object({
  id: z.string().min(1, 'project id is required'),
});

const browseQuerySchema = z.object({
  path: z.string().optional(),
});

function badRequest(res: { status: (code: number) => { json: (body: unknown) => void } }, message: string): void {
  res.status(400).json({ error: message });
}

function notFound(res: { status: (code: number) => { json: (body: unknown) => void } }, message: string): void {
  res.status(404).json({ error: message });
}

// ── REST API: Project context ──────────────────────────────────────────────

router.get('/projects', (_req, res) => {
  res.json(listProjects());
});

router.post('/projects', asyncHandler(async (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const project = addProject(parsed.data.name, parsed.data.path);
  dashboardNsp?.emit('project:list', listProjects());
  res.status(201).json(project);
}));

router.delete('/projects/:id', (req, res) => {
  const params = projectIdParamSchema.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
  const removed = removeProject(params.data.id);
  if (!removed) return notFound(res, 'Project not found');
  const store = listProjects();
  dashboardNsp?.emit('project:list', store);
  dashboardNsp?.emit('project:active', store.activeProjectId
    ? store.projects.find((p) => p.id === store.activeProjectId) ?? null
    : null);
  const active = getActiveProject();
  setActiveProject(active ? { id: active.id, name: active.name, path: active.path } : null);
  res.json({ ok: true });
  return;
});

router.put('/projects/:id', asyncHandler(async (req, res) => {
  const params = projectIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const parsed = updateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  try {
    const project = updateProject(params.data.id, { name: parsed.data.name, path: parsed.data.path });
    const store = listProjects();
    dashboardNsp?.emit('project:list', store);
    const active = getActiveProject();
    if (active && active.id === params.data.id) {
      dashboardNsp?.emit('project:active', project);
      setActiveProject({ id: project.id, name: project.name, path: project.path });
    }
    res.json(project);
  } catch (err: unknown) {
    const message = errorMessage(err);
    if (message === 'Project not found') {
      notFound(res, message);
      return;
    }
    badRequest(res, message);
  }
}));

router.put('/projects/:id/activate', (req, res) => {
  const params = projectIdParamSchema.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
  const project = activateProject(params.data.id);
  if (!project) return notFound(res, 'Project not found');
  dashboardNsp?.emit('project:active', project);
  setActiveProject({ id: project.id, name: project.name, path: project.path });
  res.json(project);
  return;
});

// ── REST API: Directory browsing ─────────────────────────────────────────────

router.get('/browse', (req, res) => {
  const query = browseQuerySchema.safeParse(req.query);
  if (!query.success) return badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
  const raw = query.data.path ?? '';
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
        if (typeof ack === 'function') ack({ ok: false, error: errorMessage(err) });
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
        if (typeof ack === 'function') ack({ ok: false, error: errorMessage(err) });
      }
    });
  });
}
