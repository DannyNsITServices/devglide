import { Router } from 'express';
import { transcribeRouter } from '../apps/voice/src/routes/transcribe.js';
import { configRouter } from '../apps/voice/src/routes/config.js';

export const router: Router = Router();

router.use('/transcribe', transcribeRouter);
router.use('/config', configRouter);

export { createVoiceMcpServer } from '../apps/voice/src/mcp.js';
