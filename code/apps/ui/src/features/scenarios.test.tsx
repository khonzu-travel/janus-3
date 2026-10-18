import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FakeAtlas, V1, type ScenarioWorld } from '../../test/fake-atlas.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// Scenarios in the UI.

type Doc = Record<string, unknown>;

const EP = {
  defaultCart: 'ep_00000000000000a1',
  defaultWhen: 'ep_00000000000000a2',
  defaultOnly: 'ep_00000000000000a3',
  declinedCart: 'ep_00000000000000b1',
  declinedWhen: 'ep_00000000000000b2',
  lateCart: 'ep_00000000000000c1',
  lateWhen: 'ep_00000000000000c2',
};
const FX = {
  cartOk: 'fx_00000000000000a1',
  when: 'fx_00000000000000a2',
  only: 'fx_00000000000000a3',
  declined: 'fx_00000000000000b1',
};

interface File {
  readonly id: string;
  readonly status: number;
  readonly holder: string;
  readonly holderEndpoint: string;
  readonly body: string;
}

const FILES: Readonly<Record<string, File>> = {
  [FX.cartOk]: { id: FX.cartOk, status: 200, holder: 'default', holderEndpoint: EP.defaultCart, body: '{"ok":true}' },
  [FX.when]: { id: FX.when, status: 200, holder: 'default', holderEndpoint: EP.defaultWhen, body: '{"now":1}' },
  [FX.only]: { id: FX.only, status: 204, holder: 'default', holderEndpoint: EP.defaultOnly, body: '' },
  [FX.declined]: {
    id: FX.declined,
    status: 402,
    holder: 'declined',
    holderEndpoint: EP.declinedCart,
    body: '{"error":"declined"}',
  },
};

interface EndpointSpec {
  readonly id: string;
  readonly scenario: string;
  readonly path: string;
  readonly files: readonly string[];
}

const ENDPOINTS: readonly EndpointSpec[] = [
  { id: EP.defaultCart, scenario: 'default', path: '/v1/cart', files: [FX.cartOk] },
  { id: EP.defaultWhen, scenario: 'default', path: '/v1/when', files: [FX.when] },
  { id: EP.defaultOnly, scenario: 'default', path: '/v1/only', files: [FX.only] },
  { id: EP.declinedCart, scenario: 'declined', path: '/v1/cart', files: [FX.declined] },
  { id: EP.declinedWhen, scenario: 'declined', path: '/v1/when', files: [FX.when] },
  { id: EP.lateCart, scenario: 'declined-late', path: '/v1/cart', files: [FX.declined] },
  { id: EP.lateWhen, scenario: 'declined-late', path: '/v1/when', files: [FX.when] },
];

const href = (resource: string, id: string) => `${resource}/${id}?at=${V1}`;
const originOf = (endpoint: EndpointSpec): string => {
  const own = endpoint.files.filter((id) => FILES[id]?.holder === endpoint.scenario).length;
  return own === endpoint.files.length ? 'own' : own === 0 ? 'inherited' : 'mixed';
};

function world(configuredDefault = 'default'): ScenarioWorld {
  const summary = (endpoint: EndpointSpec, id: string): Doc => {
    const file = FILES[id] as File;
    return {
      id,
      status: file.status,
      mediaType: file.body === '' ? null : 'application/json',
      wireContentType: file.body === '' ? null : 'application/json',
      locale: null,
      byteLength: file.body.length,
      headers: [],
      scenario: file.holder,
      origin: file.holder === endpoint.scenario ? 'own' : 'inherited',
    };
  };
  const matrixOf = (path: string): Doc => {
    const rows = ENDPOINTS.filter((entry) => entry.path === path).sort((a, b) => (a.scenario < b.scenario ? -1 : 1));
    const statuses = [...new Set(rows.flatMap((row) => row.files.map((id) => FILES[id]?.status ?? 0)))].sort();
    return {
      identities: statuses.map((status) => ({ status })),
      rows: rows.map((row) => ({
        scenario: row.scenario,
        endpointId: row.id,
        detailHref: href('endpoints', row.id),
        cells: statuses.map((status) => {
          const files = row.files.filter((id) => FILES[id]?.status === status);
          return files.length === 0
            ? null
            : {
                representations: files.map((id) => ({
                  fixtureId: id,
                  locale: null,
                  mediaType: 'application/json',
                  origin: FILES[id]?.holder === row.scenario ? 'own' : 'inherited',
                  scenario: FILES[id]?.holder,
                  detailHref: href('fixtures', id),
                })),
              };
        }),
      })),
    };
  };
  const endpoints: Record<string, Doc> = {};
  for (const endpoint of ENDPOINTS) {
    const fixtures = endpoint.files.map((id) => ({ ...summary(endpoint, id), detailHref: href('fixtures', id) }));
    endpoints[endpoint.id] = {
      snapshotVersion: V1,
      id: endpoint.id,
      scenario: endpoint.scenario,
      method: 'GET',
      path: endpoint.path,
      pathParameters: [],
      origin: originOf(endpoint),
      fixtures,
      representationGroups: fixtures.map((fixture, index) => ({
        status: FILES[endpoint.files[index] ?? '']?.status,
        locale: null,
        representations: [fixture],
      })),
      accepts: null,
      matrix: matrixOf(endpoint.path),
    };
  }
  const fixtures: Record<string, Doc> = {};
  for (const file of Object.values(FILES)) {
    const holder = ENDPOINTS.find((entry) => entry.id === file.holderEndpoint) as EndpointSpec;
    fixtures[file.id] = {
      snapshotVersion: V1,
      ...summary(holder, file.id),
      endpointId: holder.id,
      method: 'GET',
      path: holder.path,
      pathParameters: [],
      preview:
        file.body === ''
          ? { state: 'unavailable', reason: 'bodyless' }
          : { state: 'available', encoding: 'utf8', value: file.body, byteLength: file.body.length, truncated: false },
      dynamic: false,
      tokens: [],
    };
  }
  const inventory = (scenario: string): Doc => ({
    snapshotVersion: V1,
    scenario,
    items: ENDPOINTS.filter((entry) => entry.scenario === scenario).map((entry) => ({
      id: entry.id,
      scenario,
      method: 'GET',
      path: entry.path,
      pathParameters: [],
      origin: originOf(entry),
      detailHref: href('endpoints', entry.id),
    })),
  });
  const scenario = (name: string, parent: string | null, extra: Doc): Doc => {
    const own = ENDPOINTS.filter((entry) => entry.scenario === name);
    const ownCount = own.filter((entry) => originOf(entry) !== 'inherited').length;
    return {
      name,
      description: null,
      extends: parent,
      ids: [],
      overrides: [],
      removes: [],
      endpoints: { own: ownCount, inherited: own.length - ownCount, total: own.length },
      endpointsHref: `endpoints?scenario=${name}&at=${V1}`,
      ...extra,
    };
  };
  return {
    configuredDefault,
    scenarios: {
      snapshotVersion: V1,
      configuredDefault,
      items: [
        scenario('declined', 'default', {
          description: 'The card is declined',
          chain: ['declined', 'default'],
          overrides: ['/v1/cart/GET'],
          removes: ['/v1/only/GET'],
          ids: [{ name: 'paymentId', value: 'pay_declined', from: 'declined' }],
        }),
        scenario('declined-late', 'declined', { chain: ['declined-late', 'declined', 'default'] }),
        scenario('default', null, { chain: ['default'] }),
      ],
    },
    inventories: Object.fromEntries(['default', 'declined', 'declined-late'].map((name) => [name, inventory(name)])),
    endpoints,
    fixtures,
  };
}

function renderApp(hash = '#/endpoints', configuredDefault = 'default') {
  window.location.hash = hash;
  const fake = new FakeAtlas();
  fake.world = world(configuredDefault);
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
  return { fake, user: userEvent.setup() };
}

const nav = () => screen.findByRole('navigation', { name: 'Endpoints' }, { timeout: 5000 });
const selector = () => screen.findByRole('button', { name: /^Scenario / }, { timeout: 5000 });
const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await selector());
  await user.click(screen.getByRole('option', { name }));
};
const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

describe('the scenario selector', () => {
  it('starts at the configured default, lists every scenario, and keeps the choice in the hash', async () => {
    const { fake, user } = renderApp();
    const select = await selector();
    expect(select.textContent).toBe('default');
    await user.click(select);
    expect(
      within(screen.getByRole('listbox', { name: 'Scenarios' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['default', 'declinedextends default', 'declined-lateextends declined']);
    await user.click(screen.getByRole('option', { name: 'declined' }));
    expect(hashParams().get('scenario')).toBe('declined');
    expect(screen.getByText('The card is declined')).toBeDefined();
    await within(await nav()).findByRole('link', { name: 'GET /v1/cart, scenario declined' });
    expect(fake.requests).toContain('/_janus/endpoints?scenario=declined');
    expect(within(await nav()).getByRole('link', { name: 'GET /v1/when, scenario declined, inherited' })).toBeDefined();
  });

  it('opens the scenario a link names', async () => {
    renderApp('#/endpoints?scenario=declined-late');
    expect((await selector()).textContent).toBe('declined-late');
    await within(await nav()).findByRole('link', { name: 'GET /v1/cart, scenario declined-late, inherited' });
  });

  it('keeps the endpoint when the new scenario has it, and says so when it does not', async () => {
    const { user } = renderApp(`#/endpoints/${EP.defaultCart}`);
    await screen.findByRole('heading', { level: 2, name: /\/v1\/cart/ });
    await pick(user, 'declined');
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/endpoints/${EP.declinedCart}?scenario=declined`);
    });
    const detail = await screen.findByRole('region', { name: /\/v1\/cart/ });
    await within(detail).findByText('declined', { selector: 'dd *, dd' });

    await pick(user, 'default');
    await screen.findByRole('heading', { level: 2, name: /\/v1\/cart/ });
    await user.click(await within(await nav()).findByRole('link', { name: 'GET /v1/only, scenario default' }));
    await screen.findByRole('heading', { level: 2, name: /\/v1\/only/ });
    await pick(user, 'declined');
    const missing = await screen.findByRole('heading', { level: 2, name: 'Not in this scenario' });
    const alert = missing.closest('section') as HTMLElement;
    expect(alert.textContent).toContain('does not exist in scenario declined');
    expect(within(alert).getByRole('link', { name: 'Back' }).getAttribute('href')).toBe(
      '#/endpoints?scenario=declined',
    );
  });
});

describe('origins and the matrix', () => {
  it('filters to the scenario’s own endpoints', async () => {
    const { user } = renderApp('#/endpoints?scenario=declined');
    const inventory = await nav();
    await within(inventory).findByRole('link', { name: /\/v1\/when/ });
    await user.click(within(inventory).getByRole('button', { name: 'Own only' }));
    expect(hashParams().get('own')).toBe('1');
    await waitFor(() => {
      expect(within(inventory).queryByRole('link', { name: /\/v1\/when/ })).toBeNull();
    });
    expect(within(inventory).getByRole('link', { name: /\/v1\/cart/ })).toBeDefined();
    expect(within(inventory).getByRole('button', { name: 'Own only' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows every scenario’s responses and opens one in its own scenario', async () => {
    const { user } = renderApp(`#/endpoints/${EP.declinedCart}?scenario=declined`);
    const table = await screen.findByRole('table', { name: 'Responses of this endpoint in each scenario' });
    const rows = within(table).getAllByRole('row');
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Scenario', '200', '402']);
    expect(rows.slice(1).map((row) => row.textContent)).toEqual([
      'declined(selected)—Not in this scenarioapplication/jsonown',
      'declined-late—Not in this scenarioapplication/jsonfrom declined',
      'defaultapplication/jsonown—Not in this scenario',
    ]);
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');
    await user.click(within(table).getByRole('link', { name: 'declined-late: 402 application/json, from declined' }));
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/endpoints/${EP.lateCart}/fixtures/${FX.declined}?scenario=declined-late`);
    });
    await screen.findByRole('region', { name: /Response 402/ });
    // The response's facts are in the inspector.
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect((await within(details).findByText('File held by')).nextElementSibling?.textContent).toBe(
      'scenario declined',
    );
    expect((await selector()).textContent).toBe('declined-late');
  });
});

describe('the scenario view', () => {
  it('shows the inheritance tree and the selected scenario’s details', async () => {
    renderApp('#/scenarios?scenario=declined');
    const tree = await screen.findByRole('tree', { name: 'Scenario inheritance' }, { timeout: 5000 });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((item) => [item.getAttribute('aria-level'), item.firstElementChild?.textContent])).toEqual([
      ['1', 'default'],
      ['2', 'declined'],
      ['3', 'declined-late'],
    ]);
    expect(items[1]?.getAttribute('aria-selected')).toBe('true');
    const details = screen.getByRole('region', { name: 'declined' });
    expect(details.textContent).toContain('The card is declined');
    expect(details.textContent).toContain('/v1/cart/GET');
    expect(details.textContent).toContain('pay_declined');
    expect(within(details).getByRole('link', { name: '1 own' }).getAttribute('href')).toBe(
      '#/endpoints?scenario=declined&own=1',
    );
    expect(within(details).getByRole('link', { name: '2 in all' }).getAttribute('href')).toBe(
      '#/endpoints?scenario=declined',
    );
  });

  it('moves, opens, closes and selects with the keyboard', async () => {
    const { user } = renderApp('#/scenarios');
    const tree = await screen.findByRole('tree', { name: 'Scenario inheritance' }, { timeout: 5000 });
    const item = (name: string) =>
      within(tree)
        .getAllByRole('treeitem')
        .find((entry) => entry.firstElementChild?.textContent.endsWith(name) === true) as HTMLElement;
    // One tab stop: the selected scenario.
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .filter((entry) => entry.tabIndex === 0),
    ).toEqual([item('default')]);
    item('default').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('declined'));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('declined-late'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('declined'));
    await user.keyboard('{ArrowLeft}');
    expect(item('declined').getAttribute('aria-expanded')).toBe('false');
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
    await user.keyboard('{ArrowRight}');
    expect(item('declined').getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(item('declined-late'));
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(hashParams().get('scenario')).toBe('declined-late');
    });
    expect(item('declined-late').getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(item('default'));
  });
});

describe('the explorer with scenarios', () => {
  it('simulates in the scenario selected in the header, and explains the selection and hidden files', async () => {
    const { fake, user } = renderApp('#/explorer?scenario=declined-late');
    fake.resolver = () => ({
      snapshotVersion: V1,
      response: {
        status: 402,
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: { state: 'available', encoding: 'utf8', value: '{}', byteLength: 2, truncated: false },
      },
      trace: {
        snapshotVersion: V1,
        scenario: 'declined-late',
        selection: { source: 'caller', chain: ['declined-late', 'declined', 'default'] },
        resolvedFrom: 'declined',
        shadowed: [{ scenario: 'default', fixtureId: FX.cartOk, by: 'overrides' }],
        session: { id: 'team-a', source: 'header', exists: false },
        normalizedPath: '/v1/cart',
        outcome: { kind: 'matched' },
        route: { template: '/v1/cart', params: {}, considered: [] },
        headers: { identity: FX.declined, dropped: [], contentTypeOverride: null },
      },
      fixture: { endpointId: EP.declinedCart, fixtureId: FX.declined, detailHref: href('fixtures', FX.declined) },
      shadowed: [{ endpointId: EP.defaultCart, fixtureId: FX.cartOk, detailHref: href('fixtures', FX.cartOk) }],
      notes: [],
    });
    await user.clear(await screen.findByLabelText('Target (path and query)', {}, { timeout: 5000 }));
    await user.type(screen.getByLabelText('Target (path and query)'), '/v1/cart');
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    const decisions = await screen.findByRole('list', { name: 'Decisions' });
    expect(fake.envelopes.at(-1)).toMatchObject({ scenario: 'declined-late', target: '/v1/cart' });
    expect(decisions.textContent).toContain('Session team-a, from X-Mock-Session. It names no session');
    expect(decisions.textContent).toContain(
      'Selected declined-late because the top bar picked it, and the request names none.',
    );
    expect(decisions.textContent).toContain('Inherits: declined, default.');
    expect(decisions.textContent).toContain('The file is inherited from declined');
    const hidden = within(decisions).getByRole('link', { name: FX.cartOk });
    expect(hidden.getAttribute('href')).toBe(`#/endpoints/${EP.defaultCart}/fixtures/${FX.cartOk}?scenario=default`);
    expect(decisions.textContent).toContain('in default, taken out by overrides');
    expect(screen.getByRole('link', { name: 'Open the fixture that answered' }).getAttribute('href')).toBe(
      `#/endpoints/${EP.declinedCart}/fixtures/${FX.declined}?scenario=declined`,
    );
  });

  it('explains an unknown scenario without falling back', async () => {
    const { fake, user } = renderApp('#/explorer');
    fake.resolver = () => ({
      snapshotVersion: V1,
      response: {
        status: 400,
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: { state: 'available', encoding: 'utf8', value: '{}', byteLength: 2, truncated: false },
      },
      trace: {
        snapshotVersion: V1,
        normalizedPath: '/v1/cart',
        session: { id: null, source: 'default', exists: false },
        outcome: { kind: 'unknown-scenario', source: 'request-header', known: ['declined', 'default'] },
      },
      fixture: null,
      notes: [],
    });
    await user.click(await screen.findByRole('button', { name: 'Explain' }, { timeout: 5000 }));
    const decisions = await screen.findByRole('list', { name: 'Decisions' });
    expect(decisions.textContent).toContain('No such scenario, named by X-Mock-Scenario');
    expect(decisions.textContent).toContain('Known scenarios: declined, default.');
  });
});

describe('a server without scenarios', () => {
  it('shows no selector and no scenario view', async () => {
    window.location.hash = '#/endpoints';
    const fake = new FakeAtlas();
    const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
    if (!config.ok) throw new Error(config.message);
    render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
    await within(await nav()).findAllByRole('link');
    expect(screen.queryByRole('button', { name: /^Scenario / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New scenario' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Scenarios' })).toBeNull();
    expect(fake.requests.some((request) => request.includes('scenario'))).toBe(false);
  });
});
