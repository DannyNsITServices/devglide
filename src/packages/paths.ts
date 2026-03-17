/**
 * Centralized path constants for ~/.devglide subdirectories.
 * Single source of truth — all apps import from here.
 */

import { join } from 'path';
import { homedir } from 'os';

export const DEVGLIDE_DIR: string = join(homedir(), '.devglide');
export const PROJECTS_DIR: string = join(DEVGLIDE_DIR, 'projects');
/** Per-project data dir: ~/.devglide/projects/{projectId}/{sub} */
export function projectDataDir(projectId: string, sub: string): string {
  return join(PROJECTS_DIR, projectId, sub);
}
// Legacy flat dirs — kept for global (non-project-scoped) data
export const DATABASES_DIR: string = join(DEVGLIDE_DIR, 'databases');
export const WORKFLOWS_DIR: string = join(DEVGLIDE_DIR, 'workflows');
export const INSTRUCTIONS_DIR: string = join(DEVGLIDE_DIR, 'instructions');
export const VOCABULARY_DIR: string = join(DEVGLIDE_DIR, 'vocabulary');
export const VOICE_DIR: string = join(DEVGLIDE_DIR, 'voice');
export const LOGS_DIR: string = join(DEVGLIDE_DIR, 'logs');
export const PROJECTS_FILE: string = join(DEVGLIDE_DIR, 'projects.json');
export const PROMPTS_DIR: string = join(DEVGLIDE_DIR, 'prompts');
export const DOCS_DIR: string = join(DEVGLIDE_DIR, 'documentation');
