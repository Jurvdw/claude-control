import { defineConfig } from '@playwright/test';

// Electron e2e. Each test launches the packaged app against a throwaway
// user-data dir (own Postgres, storage and secrets), so runs are isolated from
// the real workspace — but the backend port is fixed at 4000, so the installed
// app must be CLOSED while these run.
export default defineConfig({
  testDir: './e2e',
  // Booting Electron + initialising a fresh Postgres cluster is genuinely slow.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  // One app instance at a time — they would fight over port 4000.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
