import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, startProxy, type Janus, type Proxy } from './harness.js';

// The startup acceptance journey, browser steps: the UI shows the configuration digest, the startup warnings, and the
// effective settings with their sources. The CLI steps are in tests/acceptance-startup.test.ts.

const TREE: Readonly<Record<string, string>> = {
  'janus.config.yaml': [
    'server:',
    '  port: 0',
    'fixtures:',
    '  root: ./fixtures',
    'onUnknownMethod: 404',
    'limits:',
    '  maxBodyBytes: 2048',
    '',
  ].join('\n'),
  'fixtures/default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  // Repeats the media type the file name sets: a startup warning, not an error.
  'fixtures/default/v1/products/GET/200.headers.json': '{"Content-Type":"application/json"}',
};

let root: string;
let janus: Janus;
let proxy: Proxy;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-e2e-config-'));
  for (const [path, contents] of Object.entries(TREE)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  janus = await startJanusWith(['--config', join(root, 'janus.config.yaml'), '--host', '127.0.0.1']);
  proxy = await startProxy(() => janus.port);
});

test.afterAll(async () => {
  await proxy.close();
  await janus.stop();
  await rm(root, { recursive: true, force: true });
});

test('show the configuration digest, startup warnings, and effective settings', async ({ page }) => {
  const health = (await (await fetch(`${janus.url}/_janus/health`)).json()) as { configDigest: string };
  expect(health.configDigest).toMatch(/^cfg_[0-9a-f]{16}$/);

  await page.goto(`${proxy.url}/ui/#/endpoints`);
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('status')).toHaveText(/Ready/);

  // The digest, in the inspector: abbreviated on screen and complete for assistive technology.
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText(`${health.configDigest.slice(0, 12)}…`);
  await expect(details.getByText(health.configDigest, { exact: true })).toBeAttached();

  // The warnings count opens the list of warnings, by keyboard.
  const toggle = banner.getByRole('button', { name: '1 startup warning' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const warnings = page.getByRole('region', { name: 'Startup warnings' });
  await expect(warnings.getByRole('listitem')).toHaveText([/^redundant-content-type: /]);

  // The read-only configuration dialog over the view, with a text source badge per setting.
  await banner.getByRole('button', { name: 'Configuration' }).click();
  await expect(page).toHaveURL(/[?&]config=1/);
  await expect(page.getByRole('dialog', { name: 'Configuration' })).toBeVisible();
  // One table per group; each row header keeps the full key for assistive technology.
  const rows = page
    .getByRole('table', { name: /^Effective settings: / })
    .getByRole('row')
    .filter({ hasNot: page.getByRole('columnheader') });
  await expect(rows).toHaveText([
    'atlas.resolvetruedefault',
    'codecs.xmltruedefault',
    'compression.enabledtruedefault',
    'compression.encodings[br, gzip, deflate]default',
    'compression.minBytes1024default',
    'cors.fixtures.credentialsfalsedefault',
    'cors.fixtures.maxAge600default',
    'cors.fixtures.origins[]default',
    'cors.maxAge600default',
    'cors.origins[]default',
    'diagnostics.headerstruedefault',
    'dynamic.aliases{}default',
    'dynamic.clockModefrozendefault',
    'dynamic.nownulldefault',
    'dynamic.seednulldefault',
    'dynamic.strictRefsfalsedefault',
    'dynamic.timezoneUTCdefault',
    'faults.enabledtruedefault',
    'faults.latencynulldefault',
    'faults.maxHeldConnections128default',
    'faults.timeoutMs120000default',
    'fixtures.watchfalsedefault',
    'idempotency.enabledtruedefault',
    'idempotency.headerIdempotency-Keydefault',
    'idempotency.maxEntries1000default',
    'idempotency.methods[POST, PATCH]default',
    'limits.maxBodyBytes2048file',
    'limits.maxDecodedBodyBytes4194304default',
    'limits.maxHeaderBytes16384default',
    'limits.maxUrlBytes8192default',
    'negotiation.mediaTypePreference[]default',
    'negotiation.onUnacceptable406default',
    'negotiation.onUnusableAccept400default',
    'onNoFixture404default',
    'onUnknownMethod404file',
    'promotion.modestageddefault',
    'recording.allowNonLoopbackfalsedefault',
    'recording.capturessetdefault',
    'recording.endpoints[]default',
    'recording.maxConcurrent4default',
    'recording.maxResponseBytes10485760default',
    'recording.timeoutMs30000default',
    'runner.allowNonLoopbackfalsedefault',
    'runner.extraCaCerts[]default',
    'runner.keepRuns50default',
    'runner.maxActiveRuns2default',
    'runner.maxImportBytes52428800default',
    'runner.rootsetdefault',
    'runner.scriptMemoryBytes33554432default',
    'runner.scriptTimeoutMs1000default',
    'runner.skipTlsVerifyfalsedefault',
    'scenarios.defaultdefaultdefault',
    'server.autoOptionstruedefault',
    'server.strictTrailingSlashtruedefault',
    'sessions.idleTimeout1800default',
    'sessions.keyFrom[]default',
    'sessions.max1000default',
    'ui.enabledtruedefault',
  ]);
  await expect(page.getByText('Running on defaults.')).toHaveCount(0);

  // Nothing path-like reached the page or the Atlas responses.
  expect(await page.content()).not.toContain(root);
  expect(proxy.atlasBodies.join('\n')).not.toContain(root);
  expect(proxy.atlasBodies.join('\n')).not.toContain('.headers.json');

  // The view survives a reload from its hash route.
  await page.reload();
  await expect(page.getByRole('table', { name: 'Effective settings: limits' })).toBeVisible();
});
