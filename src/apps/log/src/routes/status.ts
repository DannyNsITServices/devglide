import path from "path";
import { Router } from "express";
import type { Request, Response, Router as RouterType } from "express";
import { getSessions } from "./log.js";
import { getActiveProject } from "../../../../project-context.js";
import { LOGS_DIR, projectDataDir } from "../../../../packages/paths.js";

export const statusRouter: RouterType = Router();

/**
 * GET /api/status — Return active sessions.
 *
 * Optional query parameter `projectPath` filters sessions to those whose
 * targetPath matches the project.  Matching uses the per-project log
 * directory (projects/{id}/logs/) or falls back to legacy name-based
 * matching under LOGS_DIR.  When `projectPath` is omitted, falls back to
 * the active project.  If neither is set, all sessions are returned.
 */
statusRouter.get("/", (req: Request, res: Response) => {
  let sessions = getSessions();

  const project = getActiveProject();
  const projectPath = (req.query.projectPath as string | undefined) || project?.path || null;
  if (projectPath) {
    const projectName = path.basename(projectPath);
    // Per-project log dir: ~/.devglide/projects/{id}/logs/
    const projectLogDir = project ? projectDataDir(project.id, 'logs') : null;
    // Legacy flat prefix: ~/.devglide/logs/{name}-*
    const legacyLogPrefix = path.join(LOGS_DIR, projectName);
    sessions = sessions.filter((s) => {
      if (!s.targetPath) return false;
      // Match log files under per-project logs dir
      if (projectLogDir && s.targetPath.startsWith(projectLogDir)) return true;
      // Legacy: flat LOGS_DIR named <project-name>-*
      if (s.targetPath.startsWith(legacyLogPrefix)) return true;
      // Legacy: targetPath was the project directory itself
      if (s.targetPath.startsWith(projectPath)) return true;
      return false;
    });
  }

  res.json({ sessions });
});
