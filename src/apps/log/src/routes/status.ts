import path from "path";
import { Router } from "express";
import type { Request, Response, Router as RouterType } from "express";
import { getSessions } from "./log.js";
import { getActiveProject } from "../../../../project-context.js";
import { LOGS_DIR } from "../../../../packages/paths.js";

export const statusRouter: RouterType = Router();

/**
 * GET /api/status — Return active sessions.
 *
 * Optional query parameter `projectPath` filters sessions to those whose
 * targetPath matches the project.  Matching works by project name (derived
 * from the log file name under LOGS_DIR) or by path prefix for legacy
 * targetPaths.  When `projectPath` is omitted, falls back to the active
 * project.  If neither is set, all sessions are returned.
 */
statusRouter.get("/", (req: Request, res: Response) => {
  let sessions = getSessions();

  const projectPath = (req.query.projectPath as string | undefined) || getActiveProject()?.path || null;
  if (projectPath) {
    const projectName = path.basename(projectPath);
    const expectedLogPrefix = path.join(LOGS_DIR, projectName);
    sessions = sessions.filter((s) => {
      if (!s.targetPath) return false;
      // Match log files under LOGS_DIR named <project-name>-*
      if (s.targetPath.startsWith(expectedLogPrefix)) return true;
      // Legacy: targetPath was the project directory itself
      if (s.targetPath.startsWith(projectPath)) return true;
      return false;
    });
  }

  res.json({ sessions });
});
