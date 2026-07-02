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
    const raw = v.join('=');
    try {
      return [k, decodeURIComponent(raw)];
    } catch {
      // Malformed percent-encoding — fall back to the raw value
      return [k, raw];
    }
  }));
}

export const router: Router = Router();

// Project IDs are used to build filesystem paths (kanban.db, uploads/) —
// only allow safe identifier characters to prevent path traversal.
const SAFE_PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;

// Project context middleware
router.use((req, res, next) => {
  const fromHeader = req.headers['x-project-id'];
  const cookies = parseCookie(req.headers.cookie);
  const fromCookie = cookies['devglide-project-id'];
  const projectId = (typeof fromHeader === 'string' ? fromHeader : fromCookie) || undefined;
  if (projectId !== undefined && !SAFE_PROJECT_ID_RE.test(projectId)) {
    res.status(400).json({ error: 'Invalid project id' });
    return;
  }
  req.projectId = projectId;
  next();
});

// Mount sub-routers
router.use('/features', featuresRouter);
router.use('/issues', issuesRouter);
router.use('/attachments', attachmentsRouter);
