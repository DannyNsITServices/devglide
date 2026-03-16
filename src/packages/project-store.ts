import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DEVGLIDE_DIR, PROJECTS_FILE } from './paths.js';

const STORE_PATH = PROJECTS_FILE;

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface StoreData {
  projects: Project[];
  activeProjectId: string | null;
}

let _cache: StoreData | null = null;

function ensureLoaded(): StoreData {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    _cache = { projects: [], activeProjectId: null };
  }
  return _cache!;
}

function flushStore(): void {
  fs.mkdirSync(DEVGLIDE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(_cache, null, 2), 'utf8');
}

export function listProjects(): StoreData {
  return ensureLoaded();
}

export function addProject(name: string, projectPath: string): Project {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  if (!projectPath || typeof projectPath !== 'string') throw new Error('path is required');

  const absPath = path.resolve(projectPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    throw new Error(`Path does not exist or is not a directory: ${absPath}`);
  }

  const store = ensureLoaded();
  if (store.projects.some(p => p.path === absPath)) {
    throw new Error(`Project with path "${absPath}" already exists`);
  }

  const project: Project = { id: randomUUID(), name: name.trim(), path: absPath };
  store.projects.push(project);

  if (!store.activeProjectId) store.activeProjectId = project.id;

  flushStore();
  return project;
}

export function removeProject(id: string): boolean {
  const store = ensureLoaded();
  const before = store.projects.length;
  store.projects = store.projects.filter(p => p.id !== id);
  if (store.projects.length === before) return false;

  if (store.activeProjectId === id) {
    store.activeProjectId = store.projects.length > 0 ? store.projects[0].id : null;
  }
  flushStore();
  return true;
}

export function activateProject(id: string): Project | null {
  const store = ensureLoaded();
  const project = store.projects.find(p => p.id === id);
  if (!project) return null;

  store.activeProjectId = id;
  flushStore();
  return project;
}

export function updateProject(id: string, updates: { name?: string; path?: string }): Project {
  const store = ensureLoaded();
  const project = store.projects.find(p => p.id === id);
  if (!project) throw new Error('Project not found');

  if (updates.name !== undefined) {
    if (!updates.name || typeof updates.name !== 'string') {
      throw new Error('name must be a non-empty string');
    }
    project.name = updates.name.trim();
  }

  if (updates.path !== undefined) {
    if (!updates.path || typeof updates.path !== 'string') {
      throw new Error('path must be a non-empty string');
    }
    const absPath = path.resolve(updates.path);
    if (!path.isAbsolute(absPath)) {
      throw new Error(`Path must be absolute: ${updates.path}`);
    }
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      throw new Error(`Path does not exist or is not a directory: ${absPath}`);
    }
    if (store.projects.some(p => p.id !== id && p.path === absPath)) {
      throw new Error(`Another project with path "${absPath}" already exists`);
    }
    project.path = absPath;
  }

  flushStore();
  return project;
}

export function getActiveProject(): Project | null {
  const store = ensureLoaded();
  if (!store.activeProjectId) return null;
  return store.projects.find(p => p.id === store.activeProjectId) || null;
}

export function readActiveProjectId(): string | null {
  return ensureLoaded().activeProjectId;
}
