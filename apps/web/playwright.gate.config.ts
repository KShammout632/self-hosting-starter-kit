import { defineConfig } from '@playwright/test';

// M2 exit gate: drives the real dashboard on a real install. DASHBOARD_URL and SETUP_CODE come from
// test/vm/m2-gate-inner.sh.
export default defineConfig({
  testDir: 'e2e-gate',
  timeout: 15 * 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
});
