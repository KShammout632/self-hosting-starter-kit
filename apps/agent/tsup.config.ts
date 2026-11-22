import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { agent: 'src/main.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  loader: { '.tmpl': 'text' },
  // One self-contained file, so the target machine needs only the bundled Node binary.
  noExternal: [/.*/],
  esbuildOptions(options) {
    options.alias = { ssh2: './stubs/ssh2.js' };
  },
});
