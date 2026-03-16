/**
 * Devglide devtools script sources — provides inlined console-sniffer
 * and scenario-runner JS for embedding in devtools endpoints.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read script sources once at startup
let snifferSource: string = '';
let runnerSource: string = '';
try {
  snifferSource = readFileSync(path.join(__dirname, '../apps/log/public/console-sniffer.js'), 'utf-8');
} catch {}
try {
  runnerSource = readFileSync(path.join(__dirname, '../apps/test/public/scenario-runner.js'), 'utf-8');
} catch {}

export { snifferSource, runnerSource };
