import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const devglideConfig = require('@devglide/eslint-config');

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/public/**', 'src/packages/design-tokens/**'] },
  ...devglideConfig,
];
