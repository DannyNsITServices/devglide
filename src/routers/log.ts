import { Router } from 'express';
import { logRouter } from '../apps/log/src/routes/log.js';
import { statusRouter } from '../apps/log/src/routes/status.js';
import { FileTailer } from '../apps/log/src/services/file-tailer.js';
import { onProjectChange } from '../project-context.js';

export { createLogMcpServer } from '../apps/log/src/mcp.js';

export const router: Router = Router();

// Mount sub-routers
router.use('/', logRouter);
router.use('/status', statusRouter);

// ── File tailer lifecycle ────────────────────────────────────────────────────

let fileTailer: FileTailer | null = null;
let unsubscribe: (() => void) | null = null;

export function initLog(): void {
  fileTailer = new FileTailer();

  unsubscribe = onProjectChange((project) => {
    // Start/stop tailing based on active project
    if (project?.path) {
      fileTailer!.start(project.path);
    } else {
      fileTailer!.stop();
    }
  });
}

export function shutdownLog(): void {
  if (fileTailer) {
    fileTailer.stop();
    fileTailer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
