import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || '7008', 10);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared-assets', express.static(path.join(__dirname, '../../packages/shared-assets')));
app.use('/design-tokens', express.static(path.join(__dirname, '../../packages/design-tokens/dist')));

const server = app.listen(PORT, () => {
  console.log(`Devglide Keymap running at http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
