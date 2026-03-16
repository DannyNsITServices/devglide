import { Router } from 'express';
import { transcribeRouter } from '../apps/voice/src/routes/transcribe.js';
import { configRouter } from '../apps/voice/src/routes/config.js';
import { historyRouter } from '../apps/voice/src/routes/history.js';

export const router: Router = Router();

router.use('/transcribe', transcribeRouter);
router.use('/config', configRouter);
router.use('/history', historyRouter);

// Voice config is global (like keymaps), not per-project.
// Data dir is always ~/.devglide/voice/ (set by VOICE_DIR in config-store.ts).

export { createVoiceMcpServer } from '../apps/voice/src/mcp.js';
