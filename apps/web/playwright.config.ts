import { defineConfig } from '@playwright/test';

// UI tests run against the Vite dev server with the API mocked in the browser, so they need no
// server. PW_CHANNEL lets a developer use an installed browser, for example msedge.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PW_CHANNEL || undefined,
  },
  webServer: {
    command: 'pnpm exec vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
