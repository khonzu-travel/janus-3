import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FakeAtlas } from '../../test/fake-atlas.js';
import { App } from '../app/App.js';
import { createAtlasClient, type EndpointItem } from '../atlas/client.js';
import { decodeConfig } from '../config.js';
import { buildEndpointTree, flattenTree, layoutTree, pruneTree, treeRows } from './endpointTree.js';
import { filterEndpoints, filterFromSearch, filterToSearch, inventorySearch, methodsIn } from './inventoryFilter.js';
import { WINDOW_THRESHOLD } from './InventorySidebar.js';

// Inventory search, method filters and grouping.

function renderApp(fake = new FakeAtlas(), hash = '#/endpoints') {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
  return { fake, user: userEvent.setup() };
}

const inventory = () => screen.getByRole('navigation', { name: 'Endpoints' });
const links = () =>
  within(inventory())
    .queryAllByRole('link')
    .map((link) => link.getAttribute('aria-label'));
const count = () => within(inventory()).getByRole('status');
const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

async function ready() {
  const nav = await screen.findByRole('navigation', { name: 'Endpoints' });
  await within(nav).findAllByRole('link');
}

describe('inventory search and filters', () => {
  it('searches path templates and methods case-insensitively, with an accessible count', async () => {
    const { user } = renderApp();
    await ready();
    expect(count().textContent).toBe('5 endpoints');
    await user.type(within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }), 'PROD');
    expect(links()).toEqual(['GET /v1/products, scenario default', 'DELETE /v1/products/p-1, scenario default']);
    expect(count().textContent).toBe('Showing 2 of 5 endpoints');
    expect(count().getAttribute('aria-live')).toBe('polite');
    expect(hashParams().get('q')).toBe('PROD');

    await user.clear(within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }));
    await user.type(within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }), 'delete');
    expect(links()).toEqual(['DELETE /v1/products/p-1, scenario default']);
  });

  it('filters by method, one toggle per method present; none selected means all', async () => {
    const { user } = renderApp();
    await ready();
    const group = within(inventory()).getByRole('group', { name: 'Filter by method' });
    const toggles = within(group).getAllByRole('button');
    expect(toggles.map((toggle) => [toggle.textContent, toggle.getAttribute('aria-pressed')])).toEqual([
      ['GET', 'false'],
      ['DELETE', 'false'],
    ]);
    await user.click(within(group).getByRole('button', { name: 'DELETE' }));
    expect(links()).toEqual(['DELETE /v1/products/p-1, scenario default']);
    expect(hashParams().getAll('method')).toEqual(['DELETE']);
    await user.click(within(group).getByRole('button', { name: 'GET' }));
    expect(links()).toHaveLength(5);
    expect(hashParams().getAll('method')).toEqual(['DELETE', 'GET']);
    await user.click(within(group).getByRole('button', { name: 'DELETE' }));
    await user.click(within(group).getByRole('button', { name: 'GET' }));
    expect(hashParams().getAll('method')).toEqual([]);
    expect(links()).toHaveLength(4); // /v1/products/p-1 is collapsed again by default
  });

  it('restores the view from the hash after a reload of the page, and keeps it while navigating', async () => {
    const { user } = renderApp(new FakeAtlas(), '#/endpoints?q=products&method=DELETE');
    await ready();
    expect(links()).toEqual(['DELETE /v1/products/p-1, scenario default']);
    expect(within(inventory()).getByRole<HTMLInputElement>('searchbox', { name: 'Filter endpoints' }).value).toBe(
      'products',
    );
    expect(within(inventory()).getByRole('button', { name: 'DELETE' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(inventory()).getByRole('link', { name: 'DELETE /v1/products/p-1, scenario default' }));
    await screen.findByRole('heading', { level: 2, name: /\/v1\/products\/p-1/ });
    expect(window.location.hash).toMatch(/^#\/endpoints\/ep_0000000000000005\?/);
    expect(hashParams().get('q')).toBe('products');
    expect(hashParams().getAll('method')).toEqual(['DELETE']);
  });

  it('says which filters left nothing and offers to clear them', async () => {
    const { user } = renderApp(new FakeAtlas(), '#/endpoints?q=nothing&method=GET');
    const nav = await screen.findByRole('navigation', { name: 'Endpoints' });
    const empty = await within(nav).findByRole('heading', { name: 'No matching endpoints' });
    const panel = empty.closest('section');
    expect(panel?.textContent).toContain('No endpoint matches the search “nothing” and the method GET.');
    await user.click(within(inventory()).getByRole('button', { name: 'Clear filters' }));
    await ready();
    expect(links().length).toBeGreaterThan(0);
    expect(hashParams().get('q')).toBeNull();
    expect(hashParams().getAll('method')).toEqual([]);
  });

  it('keeps collapsed and expanded folders in the hash', async () => {
    const { user } = renderApp();
    await ready();
    await user.click(within(inventory()).getByRole('button', { name: '/v1/products/p-1' }));
    await user.click(within(inventory()).getByRole('button', { name: '/v1/greeting' }));
    expect(hashParams().getAll('expand')).toEqual(['/v1/products/p-1']);
    expect(hashParams().getAll('collapse')).toEqual(['/v1/greeting']);
    // Toggling back removes the entry rather than recording the default.
    await user.click(within(inventory()).getByRole('button', { name: '/v1/greeting' }));
    expect(hashParams().getAll('collapse')).toEqual([]);
  });

  it('opens every folder while filtering, so matches are never hidden', async () => {
    const { user } = renderApp();
    await ready();
    await user.type(within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }), 'p-1');
    expect(links()).toEqual(['DELETE /v1/products/p-1, scenario default']);
  });

  it('groups by the first segment with a count, and never collapses a group of one', async () => {
    const fake = new FakeAtlas();
    fake.endpoints = [...fake.endpoints, { id: 'ep_00000000000000aa', method: 'GET', path: '/health', fixtures: [] }];
    renderApp(fake);
    await ready();
    // `/health` holds one endpoint: shown open, with no toggle.
    expect(within(inventory()).queryByRole('button', { name: '/health' })).toBeNull();
    expect(within(inventory()).getByLabelText('/health').textContent).toContain('1');
    expect(links()).toContain('GET /health, scenario default');
    // The `/v1` group shows its total even while open.
    expect(within(inventory()).getByRole('button', { name: '/v1' }).textContent).toContain('5');
  });

  it('reaches every control by keyboard', async () => {
    const { user } = renderApp();
    await ready();
    within(inventory()).getByRole('searchbox', { name: 'Filter endpoints' }).focus();
    await user.keyboard('logo');
    expect(links()).toEqual(['GET /v1/logo, scenario default']);
    // The pane's fold button ends the search row.
    await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Fold the endpoint list');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('GET');
    await user.keyboard('{Enter}');
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
  });
});

/** A synthetic inventory: `count` endpoints spread over groups and folders. */
function bigInventory(count: number): EndpointItem[] {
  const methods = ['GET', 'POST', 'PUT', 'DELETE'];
  return Array.from({ length: count }, (_, index) => ({
    id: `ep_${index.toString(16).padStart(16, '0')}`,
    scenario: 'default',
    method: methods[index % methods.length] ?? 'GET',
    path: `/v${String(index % 3)}/group-${String(index % 40)}/item-${String(index)}`,
    pathParameters: [],
    origin: 'own' as const,
    review: null,
    hasFaults: false,
    detailUrl: `http://janus.test/_janus/endpoints/x?at=aaaaaaaaaaaaaaaa`,
  }));
}

describe('a large inventory', () => {
  it('filters, groups and flattens 2 000 endpoints within one frame', () => {
    const items = bigInventory(2000);
    const filter = filterFromSearch(new URLSearchParams('q=item-1&method=GET'));
    // Warm up once, then measure the work a keystroke triggers.
    flattenTree(buildEndpointTree(filterEndpoints(items, filter)), () => true);
    const started = performance.now();
    const visible = filterEndpoints(items, filter);
    const rows = flattenTree(buildEndpointTree(visible), () => true);
    const elapsed = performance.now() - started;
    expect(visible.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(visible.length);
    expect(elapsed).toBeLessThan(16);
  });

  it('prunes the full tree to what building from the matches gives', () => {
    // The Atlas sorts the inventory path segment by segment, then by method.
    const key = (item: EndpointItem) => `${item.path.split('/').join('\u0000')}\u0001${item.method}`;
    const items = bigInventory(500).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const tree = buildEndpointTree(items);
    for (const query of ['v1', 'group-1', 'item-4', 'post', 'nothing']) {
      const visible = filterEndpoints(items, filterFromSearch(new URLSearchParams(`q=${query}`)));
      expect(pruneTree(tree, visible)).toEqual(buildEndpointTree(visible));
    }
  });

  it('prunes an unsorted inventory as building from the matches does', () => {
    const items = bigInventory(500).reverse();
    const tree = buildEndpointTree(items);
    for (const query of ['v1', 'group-1', 'item-4', 'post']) {
      const visible = filterEndpoints(items, filterFromSearch(new URLSearchParams(`q=${query}`)));
      expect(pruneTree(tree, visible)).toEqual(buildEndpointTree(visible));
    }
  });

  it('builds any window of rows as a slice of the whole flattened tree', () => {
    const tree = buildEndpointTree(bigInventory(300));
    const expanded = (node: { readonly depth: number; readonly path: string }) =>
      node.depth <= 2 || node.path.endsWith('7');
    const all = flattenTree(tree, expanded);
    const layout = layoutTree(tree, expanded);
    expect(layout.total).toBe(all.length);
    for (const [first, last] of [
      [0, 20],
      [37, 81],
      [all.length - 5, all.length + 10],
      [all.length + 3, all.length + 9],
    ] as const) {
      expect(treeRows(tree, layout, first, last)).toEqual(all.slice(first, last));
    }
  });

  it('narrows from the last result as the search grows, and widens again', () => {
    const items = bigInventory(2000);
    const search = (query: string, method?: string) =>
      filterEndpoints(
        items,
        filterFromSearch(new URLSearchParams({ q: query, ...(method === undefined ? {} : { method }) })),
      );
    const direct = (query: string, method?: string) =>
      items.filter(
        (item) =>
          (method === undefined || item.method === method) &&
          (item.path.toLowerCase().includes(query) || item.method.toLowerCase().includes(query)),
      );
    for (const [query, method] of [
      ['v', undefined],
      ['v1', undefined],
      ['v1/group-1', undefined],
      ['v1/group-1', 'GET'],
      ['v1/group-12', 'GET'],
      ['v1/group-1', undefined],
      ['ge', undefined],
      ['get', undefined],
      ['item-19', 'PUT'],
    ] as const) {
      expect(search(query, method)).toEqual(direct(query, method));
    }
  });

  it('renders only the rows near the viewport', async () => {
    const fake = new FakeAtlas();
    fake.endpoints = bigInventory(2000).map((item) => ({
      id: item.id,
      method: item.method,
      path: item.path,
      fixtures: [],
    }));
    renderApp(fake, '#/endpoints?q=item');
    await screen.findByRole('navigation', { name: 'Endpoints' });
    await waitFor(() => {
      expect(count().textContent).toBe('Showing 2000 of 2000 endpoints');
    });
    const rendered = within(inventory()).getAllByRole('listitem').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(WINDOW_THRESHOLD);
  });
});

describe('inventory filter helpers', () => {
  it('round-trips through the hash without touching other entries', () => {
    const search = filterToSearch(
      {
        query: 'a b',
        methods: ['GET', 'POST'],
        collapsed: ['/x'],
        expanded: ['/y/z'],
        scenario: null,
        ownOnly: false,
      },
      new URLSearchParams('m=GET&t=/x'),
    );
    expect(search.get('m')).toBe('GET');
    expect(filterFromSearch(search)).toEqual({
      query: 'a b',
      methods: ['GET', 'POST'],
      collapsed: ['/x'],
      expanded: ['/y/z'],
      scenario: null,
      ownOnly: false,
    });
    expect(inventorySearch(search)).toBe('?q=a+b&method=GET&method=POST&collapse=%2Fx&expand=%2Fy%2Fz');
  });

  it('orders methods conventionally', () => {
    expect(
      methodsIn(
        bigInventory(8).map((item, index) => ({
          ...item,
          method: ['PURGE', 'DELETE', 'GET', 'POST'][index % 4] ?? '',
        })),
      ),
    ).toEqual(['GET', 'POST', 'DELETE', 'PURGE']);
  });
});
