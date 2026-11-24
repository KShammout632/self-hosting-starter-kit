import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { agent: 'src/main.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // Only the install tests build with SELFHOST_TEST_BUILD=1. See config.ts.
  define: { __TEST_BUILD__: process.env.SELFHOST_TEST_BUILD === '1' ? 'true' : 'false' },
  loader: { '.tmpl': 'text' },
  // One self-contained file, so the target machine needs only the bundled Node binary.
  noExternal: [/.*/],
  esbuildOptions(options) {
    options.alias = { ssh2: './stubs/ssh2.js' };
  },
});
