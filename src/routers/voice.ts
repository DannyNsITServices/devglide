import { Router } from 'express';
import { transcribeRouter } from '../apps/voice/src/routes/transcribe.js';
import { configRouter } from '../apps/voice/src/routes/config.js';
import { configStore } from '../apps/voice/src/services/config-store.js';
import { stats } from '../apps/voice/src/services/stats.js';
import { onProjectChange } from '../project-context.js';
import { projectDataDir, VOICE_DIR } from '../packages/paths.js';

export const router: Router = Router();

router.use('/transcribe', transcribeRouter);
router.use('/config', configRouter);

// Switch voice data dir when the active project changes
onProjectChange((project) => {
  const dir = project ? projectDataDir(project.id, 'voice') : VOICE_DIR;
  configStore.switchDataDir(dir);
  stats.switchDataDir(dir);
});

export { createVoiceMcpServer } from '../apps/voice/src/mcp.js';
