import { Router } from 'express';
import { featuresRouter } from '../apps/kanban/src/routes/features.js';
import { issuesRouter } from '../apps/kanban/src/routes/issues.js';
import { attachmentsRouter } from '../apps/kanban/src/routes/attachments.js';

export { createKanbanMcpServer } from '../apps/kanban/src/mcp.js';

declare global {
  namespace Express {
    interface Request {
      projectId?: string;
    }
  }
}

function parseCookie(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(cookieHeader.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, decodeURIComponent(v.join('='))];
  }));
}

export const router: Router = Router();

// Project context middleware
router.use((req, _res, next) => {
  const fromHeader = req.headers['x-project-id'];
  const cookies = parseCookie(req.headers.cookie);
  const fromCookie = cookies['devglide-project-id'];
  req.projectId = (typeof fromHeader === 'string' ? fromHeader : fromCookie) || undefined;
  next();
});

// Mount sub-routers
router.use('/features', featuresRouter);
router.use('/issues', issuesRouter);
router.use('/attachments', attachmentsRouter);
