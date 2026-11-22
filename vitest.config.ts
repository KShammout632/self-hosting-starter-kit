import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'tmpl-as-text',
      transform(code, id) {
        if (id.endsWith('.tmpl'))
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        return null;
      },
    },
  ],
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/{src,*}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
