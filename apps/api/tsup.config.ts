import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { api: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  splitting: false,
  loader: { '.tmpl': 'text' },
  // Workspace packages and pure JavaScript dependencies are bundled. The two native modules stay
  // external and are installed next to the bundle in the dashboard image.
  noExternal: [/^(?!better-sqlite3$|@node-rs\/argon2)/],
  external: ['better-sqlite3', '@node-rs/argon2'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
