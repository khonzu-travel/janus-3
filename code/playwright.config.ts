import { defineConfig, devices } from '@playwright/test';

// The browser journeys. `pnpm test:e2e` builds the
// UI first. Every journey runs in Chromium, Firefox and WebKit; set
// JANUS_E2E_BROWSERS (for example `chromium`) to run fewer. Set
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use an already-installed Chromium
// instead of `playwright install`.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const selected = (process.env['JANUS_E2E_BROWSERS'] ?? BROWSERS.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');
for (const name of selected) {
  if (!(BROWSERS as readonly string[]).includes(name)) throw new Error(`JANUS_E2E_BROWSERS: unknown browser ${name}`);
}

const DEVICES = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' } as const;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    // Kept only on failure.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: BROWSERS.filter((name) => selected.includes(name)).map((name) => ({
    name,
    use: {
      ...devices[DEVICES[name]],
      viewport: { width: 1280, height: 800 },
      ...(name === 'chromium' && executablePath !== undefined ? { launchOptions: { executablePath } } : {}),
    },
  })),
});
