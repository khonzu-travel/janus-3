import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  DELETE_PRODUCT,
  DIGEST,
  FakeAtlas,
  GREETING,
  LOGO,
  PAGE,
  PRODUCTS,
  V1,
  V2,
} from '../../test/fake-atlas.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';
import { folderPathsTo } from '../layouts/endpointTree.js';
import { SHOW_SNAPSHOT_COUNTS } from '../layouts/showSnapshotCounts.js';
import { App } from './App.js';
import { ConfigErrorPage } from './ConfigErrorPage.js';

function renderApp(fake = new FakeAtlas(), hash = '#/endpoints') {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
  return { fake, user: userEvent.setup() };
}

const inventory = () => screen.getByRole('navigation', { name: 'Endpoints' });
const status = () => within(screen.getByRole('banner')).getByRole('status');

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(status().textContent).toContain('Ready');
  });
  await within(inventory()).findAllByRole('link');
}

/** Opens the folders down to `path`; deeper than `/v1/products` they start closed. */
async function reveal(user: ReturnType<typeof userEvent.setup>, path: string): Promise<void> {
  for (const folder of folderPathsTo(path)) {
    const toggle = within(inventory()).getByRole('button', { name: folder });
    if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
  }
}

async function openEndpoint(user: ReturnType<typeof userEvent.setup>, path: string): Promise<HTMLElement> {
  await reveal(user, path);
  await user.click(
    within(inventory()).getByRole('link', {
      name: `GET ${path}, scenario default`.replace(/^GET \/v1\/products\/p-1/, 'DELETE /v1/products/p-1'),
    }),
  );
  return screen.findByRole('heading', { level: 2, name: new RegExp(path) });
}

describe('App', () => {
  it('opens Requests as the home page, keeping the query, with Endpoints one tab over', async () => {
    renderApp(new FakeAtlas(), '#/?scenario=default');
    // Requests then names the untitled tab it opens; the query stays.
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/requests\?scenario=default(&|$)/);
    });
    const views = await screen.findByRole('navigation', { name: 'Views' });
    await waitFor(() => {
      expect(within(views).getByRole('link', { name: 'Requests' }).getAttribute('aria-current')).toBe('page');
    });
    expect(within(views).getByRole('link', { name: 'Endpoints' }).getAttribute('href')).toBe(
      '#/endpoints?scenario=default',
    );
  });

  it('shows loading, then readiness in the connection header', async () => {
    renderApp();
    expect(screen.getByRole('progressbar', { name: 'Connecting to Janus' })).toBeDefined();
    expect(status().textContent).toContain('Connecting');
    await ready();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Janus');
    expect(header.textContent).toContain('http://janus.test/_janus/');
  });

  it.runIf(SHOW_SNAPSHOT_COUNTS)('shows the snapshot version and counts in the connection header', async () => {
    renderApp();
    await ready();
    const header = screen.getByRole('banner');
    expect(header.textContent).toContain(V1);
    expect(header.textContent).toMatch(/Endpoints\s*5/);
  });

  it('lists method, path, and scenario for every endpoint', async () => {
    const { user } = renderApp();
    await ready();
    await reveal(user, '/v1/products/p-1');
    const links = within(inventory()).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'GET /v1/greeting, scenario default',
      'GET /v1/logo, scenario default',
      'GET /v1/page, scenario default',
      'GET /v1/products, scenario default',
      'DELETE /v1/products/p-1, scenario default',
    ]);
    // The tree shows the last path segment; the label and the tooltip carry the whole path.
    expect(links[0]?.textContent).toBe('GETgreeting');
    expect(links[0]?.getAttribute('title')).toBe('/v1/greeting');
    expect(screen.getByRole('heading', { name: 'Select an endpoint' })).toBeDefined();
  });

  it('shows an explanatory empty state for an empty inventory', async () => {
    const fake = new FakeAtlas();
    fake.endpoints = [];
    renderApp(fake);
    expect(await screen.findByRole('heading', { name: 'No endpoints yet' })).toBeDefined();
    expect(inventory().textContent).toContain('Add response files');
    expect(within(inventory()).queryByRole('list')).toBeNull();
  });

  it('navigates from the inventory to an endpoint and a localized response', async () => {
    const { user } = renderApp();
    await ready();
    const heading = await openEndpoint(user, '/v1/greeting');
    expect(heading.textContent).toBe('GET /v1/greeting');
    expect(within(inventory()).getByRole('link', { current: 'page' }).getAttribute('aria-label')).toBe(
      'GET /v1/greeting, scenario default',
    );

    const table = screen.getByRole('table', { name: 'Configured responses for this endpoint' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      // A representation matrix: rows by locale, one column per media type.
      'LocaleResponsetext/plain',
      'Any (neutral)200View response 2 B',
      'fr200View response 7 B',
    ]);

    await user.click(screen.getByRole('link', { name: 'View response 200 (fr)' }));
    expect(await screen.findByRole('heading', { name: 'Response 200 (fr)' })).toBeDefined();
    expect(screen.getByLabelText('Body preview (text)').textContent).toBe('Bonjour');
    expect(window.location.hash).toBe(`#/endpoints/${GREETING.id}/fixtures/fx_0000000000000022`);
  });

  it('shows binary previews as labelled base64', async () => {
    const { user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/logo');
    await user.click(screen.getByRole('link', { name: 'View response 200' }));
    expect((await screen.findByLabelText('Body preview (binary, base64)')).textContent).toBe('iVBORw==');
    expect(screen.getByText(/Binary data shown as base64/)).toBeDefined();
    expect(LOGO.fixtures).toHaveLength(1);
  });

  it('renders fixture HTML as inert text and labels truncation', async () => {
    const { user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/page');
    await user.click(screen.getByRole('link', { name: 'View response 200' }));
    const preview = await screen.findByLabelText('Body preview (text)');
    expect(preview.textContent).toBe('<b id="injected">bold</b>');
    expect(document.getElementById('injected')).toBeNull();
    expect(screen.getByText(/showing the first 64 KiB of 68\.4 KiB/)).toBeDefined();
    expect(PAGE.fixtures[0]?.mediaType).toBe('text/html');
  });

  it('groups endpoints into a path tree, open to the second level', async () => {
    const { user } = renderApp();
    await ready();
    const toggles = () =>
      within(inventory())
        .getAllByRole('button')
        // The tree's folders, not the list's own fold button.
        .filter((button) => button.hasAttribute('aria-expanded') && !button.hasAttribute('aria-keyshortcuts'))
        .map((button) => [button.getAttribute('aria-label'), button.getAttribute('aria-expanded')]);
    expect(toggles()).toEqual([
      ['/v1', 'true'],
      ['/v1/greeting', 'true'],
      ['/v1/logo', 'true'],
      ['/v1/page', 'true'],
      ['/v1/products', 'true'],
      ['/v1/products/p-1', 'false'],
    ]);
    // Beyond the second level, endpoints wait for their folder to open.
    expect(within(inventory()).getAllByRole('link')).toHaveLength(4);
    await user.click(within(inventory()).getByRole('button', { name: '/v1/products/p-1' }));
    expect(within(inventory()).getByRole('link', { name: 'DELETE /v1/products/p-1, scenario default' })).toBeDefined();

    // Any folder closes, hiding everything under it.
    await user.click(within(inventory()).getByRole('button', { name: '/v1' }));
    expect(within(inventory()).queryAllByRole('link')).toEqual([]);
    expect(toggles()).toEqual([['/v1', 'false']]);
  });

  it('does not lose folder toggles queued before React renders', async () => {
    renderApp();
    await ready();
    const folder = within(inventory()).getByRole('button', { name: '/v1/products/p-1' });

    act(() => {
      folder.click();
      folder.click();
    });

    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(within(inventory()).queryByRole('link', { name: 'DELETE /v1/products/p-1, scenario default' })).toBeNull();
  });

  it('opens the folders leading to the endpoint on screen', async () => {
    renderApp(undefined, `#/endpoints/${DELETE_PRODUCT.id}`);
    await ready();
    const current = within(inventory()).getByRole('link', { current: 'page' });
    expect(current.getAttribute('aria-label')).toBe('DELETE /v1/products/p-1, scenario default');
  });

  it('marks bodyless responses with text, not color alone, and shows every header value', async () => {
    const { user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/products/p-1');
    await user.click(screen.getByRole('link', { name: 'View response 204' }));
    expect(await screen.findByText('No body: status 204 is bodyless.')).toBeDefined();
    expect(DELETE_PRODUCT.fixtures[0]?.status).toBe(204);

    await openEndpoint(user, '/v1/products');
    await user.click(screen.getByRole('link', { name: 'View response 200' }));
    await user.click(await screen.findByRole('tab', { name: /^Headers/ }));
    const headers = screen.getByRole('table', { name: 'Response headers' });
    const cookie = within(headers)
      .getAllByRole('row')
      .find((row) => row.textContent.startsWith('set-cookie'));
    expect(cookie?.textContent).toBe('set-cookiesession=example');
    expect(PRODUCTS.fixtures[0]?.headers).toContainEqual({ name: 'set-cookie', value: 'session=example' });
  });

  it('splits a response into tabs that follow the ARIA tabs pattern', async () => {
    const { user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/products');
    await user.click(screen.getByRole('link', { name: 'View response 200' }));
    const tablist = await screen.findByRole('tablist', { name: 'Response parts' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected'), tab.tabIndex])).toEqual([
      ['Body', 'true', 0],
      [`Headers${String(PRODUCTS.fixtures[0]?.headers.length)}`, 'false', -1],
    ]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
    expect(within(panel).getByRole('list', { name: 'Response body (JSON tree)' })).toBeDefined();

    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel')).getByRole('table', { name: 'Response headers' })).toBeDefined();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(tabs[1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('restores a deep link on hard refresh by following inventory and endpoint links', async () => {
    const { fake } = renderApp(undefined, `#/endpoints/${GREETING.id}/fixtures/fx_0000000000000022`);
    expect((await screen.findByLabelText('Body preview (text)')).textContent).toBe('Bonjour');
    // The header also reads the clock, which is not part of following links.
    expect(fake.requests.filter((request) => request !== '/_janus/clock')).toEqual([
      '/_janus/health',
      '/_janus/endpoints',
      `/_janus/endpoints/${GREETING.id}?at=${V1}`,
      `/_janus/fixtures/fx_0000000000000022?at=${V1}`,
    ]);
  });

  it('shows not-found for an unknown selection without clearing the inventory', async () => {
    renderApp(undefined, '#/endpoints/ep_ffffffffffffffff');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading').textContent).toBe('Endpoint not found');
    expect(within(alert).getByRole('link', { name: 'Back' })).toBeDefined();
    // Five endpoints; the one under /v1/products/p-1 starts collapsed.
    expect(within(inventory()).getAllByRole('link')).toHaveLength(4);
  });

  it('shows not-found for an unknown response ID', async () => {
    renderApp(undefined, `#/endpoints/${GREETING.id}/fixtures/fx_ffffffffffffffff`);
    expect(await screen.findByRole('heading', { name: 'Response not found' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: /\/v1\/greeting/ })).toBeDefined();
  });

  it('supports browser history', async () => {
    const { user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/greeting');
    await user.click(screen.getByRole('link', { name: 'View response 200 (fr)' }));
    await screen.findByRole('heading', { name: 'Response 200 (fr)' });
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Response 200 (fr)' })).toBeNull();
    });
    expect(screen.getByRole('heading', { level: 2, name: /\/v1\/greeting/ })).toBeDefined();
  });

  it('shows an unavailable state with the target and recovers on retry', async () => {
    const fake = new FakeAtlas();
    fake.down = true;
    const { user } = renderApp(fake);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading').textContent).toBe('Janus is unavailable');
    expect(alert.textContent).toContain('Could not reach the server');
    expect(alert.textContent).toContain('http://janus.test/_janus/');
    expect(status().textContent).toContain('Unavailable');

    fake.down = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry connection' }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes an incompatible server in the unavailable state', async () => {
    const fake = new FakeAtlas();
    fake.healthOverride = { apiVersion: 'atlas.v9' };
    renderApp(fake);
    expect((await screen.findByRole('alert')).textContent).toContain('The server speaks atlas.v9');
  });

  it('labels a stale snapshot on the next navigation and refreshes coherently', async () => {
    const { fake, user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/greeting');

    fake.version = V2;
    await user.click(within(inventory()).getByRole('link', { name: /\/v1\/logo/ }));
    const stale = await screen.findAllByRole('heading', { name: 'Snapshot changed' });
    expect(stale.length).toBeGreaterThan(0);
    expect(screen.getByRole('main').textContent).toContain(`loaded from snapshot ${V1}`);
    await waitFor(() => {
      expect(status().textContent).toContain('Snapshot changed');
    });
    // The old inventory stays visible for context, but labelled stale.
    expect(within(inventory()).getByRole('heading', { name: 'Snapshot changed' })).toBeDefined();
    expect(within(inventory()).getAllByRole('link')).toHaveLength(4);

    const requestsBefore = fake.requests.length;
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { level: 2, name: /\/v1\/logo/ })).toBeDefined();
    expect(fake.requests.slice(requestsBefore).filter((request) => request !== '/_janus/clock')).toEqual([
      '/_janus/health',
      '/_janus/endpoints',
      `/_janus/endpoints/${LOGO.id}?at=${V2}`,
    ]);
    expect(screen.queryByRole('heading', { name: 'Snapshot changed' })).toBeNull();
    if (SHOW_SNAPSHOT_COUNTS) expect(screen.getByRole('banner').textContent).toContain(V2);
  });

  it('cancels an obsolete request when navigating away', async () => {
    const fake = new FakeAtlas();
    fake.hold.add(`/_janus/endpoints/${PRODUCTS.id}`);
    const { user } = renderApp(fake);
    await ready();
    await user.click(within(inventory()).getByRole('link', { name: 'GET /v1/products, scenario default' }));
    expect(await screen.findByRole('progressbar', { name: 'Loading endpoint' })).toBeDefined();
    await openEndpoint(user, '/v1/greeting');
    await waitFor(() => {
      expect(fake.aborted).toEqual([`/_janus/endpoints/${PRODUCTS.id}?at=${V1}`]);
    });
  });

  it('is keyboard operable', async () => {
    const { user } = renderApp();
    await ready();
    // The skip link comes first, then the logo (the theme switch), the status light and the views.
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Skip to main content');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Switch to (dark|light) theme$/ }));
    await user.tab();
    expect(document.activeElement?.textContent).toContain('Ready');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Requests');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Endpoints');
    // In a browser, Configuration is a button at the end of the top bar (the desktop app has it in its Server menu).
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Configuration' }));
    // The search, the endpoint list's fold button at the end of its row (Ctrl/⌘ + [), the method filters, the tree.
    await user.tab();
    expect(document.activeElement).toBe(within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fold the endpoint list' }));
    await user.tab();
    expect(document.activeElement?.textContent).toBe('GET');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('DELETE');
    await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('/v1');
    await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('/v1/greeting');
    await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('GET /v1/greeting, scenario default');
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { level: 2, name: /\/v1\/greeting/ });
    screen.getByRole('link', { name: 'View response 200 (fr)' }).focus();
    await user.keyboard('{Enter}');
    const preview = await screen.findByLabelText('Body preview (text)');
    expect(preview.tabIndex).toBe(0);
  });

  it('folds the endpoint list with Ctrl + [', async () => {
    const { user } = renderApp();
    await ready();
    await user.click(within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }));
    await user.keyboard('{Control>}[[{/Control}');
    const show = screen.getByRole('button', { name: 'Show the endpoint list' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('searchbox', { name: 'Filter endpoints' })).toBeNull();
    await user.click(show);
    expect(screen.getByRole('searchbox', { name: 'Filter endpoints' })).toBeDefined();
  });

  it('offers no mutation controls', async () => {
    const { user } = renderApp();
    await ready();
    await openEndpoint(user, '/v1/products');
    await user.click(screen.getByRole('link', { name: 'View response 200' }));
    await screen.findByRole('heading', { name: 'Response 200' });
    // The only buttons open and close inventory folders or filter it by method, and the
    // only input searches it.
    expect(
      screen
        .queryAllByRole('button')
        .filter((button) => !button.hasAttribute('aria-expanded') && !button.hasAttribute('aria-pressed'))
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([expect.stringMatching(/^Switch to (dark|light) theme$/), 'Configuration', 'Copy body']);
    // The theme switch, the logo, changes only this browser's display; Configuration opens the read-only settings;
    // Copy body copies the response to the clipboard.
    expect(document.querySelector('form, textarea, main select, input:not([type="search"])')).toBeNull();
    const names = screen.getAllByRole('link').map((link) => link.textContent.toLowerCase());
    for (const verb of ['edit', 'delete ', 'upload', 'promote', 'capture', 'record', 'save']) {
      expect(names.some((name) => name.includes(verb))).toBe(false);
    }
  });
});

/** Every row of every settings group, as "group: row text". */
function settingRows(): string[] {
  return screen.getAllByRole('table', { name: /^Effective settings: / }).flatMap((table) => {
    const group = (table.getAttribute('aria-label') ?? table.querySelector('caption')?.textContent ?? '').replace(
      'Effective settings: ',
      '',
    );
    return within(table)
      .getAllByRole('row')
      .map((row) => `${group}: ${row.textContent}`);
  });
}

describe('configuration', () => {
  it('shows the abbreviated digest, with the full value for assistive technology', async () => {
    renderApp();
    await ready();
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByText('cfg_01234567…').getAttribute('aria-hidden')).toBe('true');
    expect(within(details).getByText(DIGEST).className).toContain('sr-only');
  });

  it('says "Not reported" for an older server, without failing', async () => {
    const fake = new FakeAtlas();
    fake.config = null;
    renderApp(fake);
    await ready();
    expect(screen.getByRole('complementary', { name: 'Details' }).textContent).toContain('ConfigNot reported');
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: /startup warning/ })).toBeNull();
  });

  it('shows no warnings control when there are none', async () => {
    renderApp();
    await ready();
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: /startup warning/ })).toBeNull();
  });

  it('opens the list of startup warnings from the count, by keyboard', async () => {
    const fake = new FakeAtlas();
    fake.warnings = [
      { code: 'redundant-content-type', source: 'fixtures', message: 'Content-Type repeats the file name' },
      { code: 'non-loopback-bind', source: 'cli', message: 'Janus binds to a non-loopback address' },
    ];
    const { user } = renderApp(fake);
    await ready();
    const toggle = within(screen.getByRole('banner')).getByRole('button', { name: '2 startup warnings' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Startup warnings' })).toBeNull();

    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('region', { name: 'Startup warnings' });
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'redundant-content-type: Content-Type repeats the file name',
      'non-loopback-bind: Janus binds to a non-loopback address',
    ]);
    await user.keyboard(' ');
    expect(screen.queryByRole('region', { name: 'Startup warnings' })).toBeNull();
  });

  it('uses the singular for one warning', async () => {
    const fake = new FakeAtlas();
    fake.warnings = [{ code: 'config-similar-file-ignored', source: 'config', message: 'not loaded' }];
    renderApp(fake);
    await ready();
    expect(within(screen.getByRole('banner')).getByRole('button', { name: '1 startup warning' })).toBeDefined();
  });

  it('opens #/config as a dialog over Requests, listing every setting with a text source badge', async () => {
    const fake = new FakeAtlas();
    fake.config = {
      ...DEFAULT_CONFIG,
      configFile: true,
      settings: [
        { key: 'limits.maxBodyBytes', value: 1048576, source: 'default' },
        { key: 'onUnknownMethod', value: 404, source: 'file' },
        { key: 'server.strictTrailingSlash', value: false, source: 'cli' },
      ],
    };
    const { user } = renderApp(fake, '#/config');
    // No tab: the desktop app's Server menu opens it; old links still do.
    expect(within(screen.getByRole('banner')).queryByRole('link', { name: 'Configuration' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Configuration' });
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/requests\?(.*&)?config=1/);
    });
    // One collapsible group per key prefix; the visible key drops the prefix, the row header keeps it.
    expect(settingRows()).toEqual([
      'limits: SettingValueSource',
      'limits: limits.maxBodyBytes1048576default',
      'general: SettingValueSource',
      'general: onUnknownMethod404file',
      'server: SettingValueSource',
      'server: server.strictTrailingSlashfalsecli',
    ]);
    const general = screen.getByRole('table', { name: 'Effective settings: general' });
    expect(within(general).getByRole('rowheader', { name: 'onUnknownMethod' })).toBeDefined();
    const server = screen.getByRole('table', { name: 'Effective settings: server' });
    expect(within(server).getByRole('rowheader', { name: 'server.strictTrailingSlash' })).toBeDefined();

    await user.type(screen.getByRole('searchbox', { name: 'Filter settings' }), 'trailing');
    expect(settingRows()).toEqual(['server: SettingValueSource', 'server: server.strictTrailingSlashfalsecli']);
    await user.clear(screen.getByRole('searchbox', { name: 'Filter settings' }));
    await user.click(screen.getByRole('checkbox', { name: /Changed from default only/ }));
    expect(settingRows().filter((row) => !row.endsWith('SettingValueSource'))).toEqual([
      'general: onUnknownMethod404file',
      'server: server.strictTrailingSlashfalsecli',
    ]);
    expect(screen.queryByText(/Running on defaults/)).toBeNull();
    expect(screen.getByText(DIGEST, { selector: 'dd' })).toBeDefined();
    // The filter and the checkbox only narrow the view; nothing here changes the server.
    expect(
      within(dialog)
        .queryAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Close']);
    expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
    expect(dialog.querySelector('form, textarea, select')).toBeNull();
    // Closing drops it from the address, leaving Requests.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Configuration' })).toBeNull();
    expect(window.location.hash).not.toContain('config=1');
  });

  it('says it is running on defaults when no file was loaded', async () => {
    renderApp(new FakeAtlas(), '#/config');
    expect(await screen.findByText('Running on defaults.')).toBeDefined();
    expect(settingRows().filter((row) => !row.endsWith('SettingValueSource'))).toHaveLength(
      DEFAULT_CONFIG.settings.length,
    );
  });

  it('explains when the server does not report its configuration', async () => {
    const fake = new FakeAtlas();
    fake.config = null;
    renderApp(fake, '#/config');
    expect(await screen.findByRole('heading', { name: 'Configuration not reported' })).toBeDefined();
  });

  it('shows loading while the configuration is on its way', async () => {
    const fake = new FakeAtlas();
    fake.hold.add('/_janus/config');
    renderApp(fake, '#/config');
    expect(await screen.findByRole('progressbar', { name: 'Loading configuration' })).toBeDefined();
  });

  it('shows a retryable error, then recovers', async () => {
    const fake = new FakeAtlas();
    fake.config = { ...DEFAULT_CONFIG, settings: 'none' };
    const { user } = renderApp(fake, '#/config');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading').textContent).toBe('Could not load the configuration');
    fake.config = DEFAULT_CONFIG;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByRole('table', { name: /^Effective settings: / })).not.toHaveLength(0);
  });
});

describe('ConfigErrorPage', () => {
  it('explains an invalid configuration', () => {
    render(<ConfigErrorPage result={{ ok: false, message: 'Unknown configuration key: "atlasPrefix"' }} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading').textContent).toBe('Configuration error');
    expect(alert.textContent).toContain('"atlasPrefix"');
  });
});
