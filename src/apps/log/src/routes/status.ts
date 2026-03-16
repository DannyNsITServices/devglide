import { Router } from "express";
import type { Request, Response, Router as RouterType } from "express";
import { getSessions } from "./log.js";
import { getActiveProject } from "../../../../project-context.js";

export const statusRouter: RouterType = Router();

/**
 * GET /api/status — Return active sessions.
 *
 * Optional query parameter `projectPath` filters sessions to those whose
 * targetPath starts with the given path.  When omitted, the server falls
 * back to the active project tracked via the Shell Socket.io connection.
 * If neither is set, all sessions are returned.
 */
statusRouter.get("/", (req: Request, res: Response) => {
  let sessions = getSessions();

  const projectPath = (req.query.projectPath as string | undefined) || getActiveProject()?.path || null;
  if (projectPath) {
    sessions = sessions.filter((s) => s.targetPath?.startsWith(projectPath));
  }

  res.json({ sessions });
});
