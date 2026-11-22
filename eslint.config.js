import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'bundle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/agent/stubs/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { exports: 'writable' } },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
