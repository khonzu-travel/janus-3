import { defineConfig } from '@playwright/test';

// The Electron journeys, run against the built app with
// Playwright's Electron support. `pnpm test:desktop` builds first and runs them
// under xvfb-run on Linux when there is no display.
export default defineConfig({
  testDir: 'test',
  testMatch: '**/*.spec.ts',
  outputDir: '../../test-results/desktop',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
