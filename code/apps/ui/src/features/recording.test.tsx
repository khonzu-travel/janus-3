import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { errorResponse, FakeAtlas, jsonResponse, V1 } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// Recording in the UI.

type Doc = Record<string, unknown>;

const RECORDING = {
  available: true,
  endpoints: [{ method: 'POST', path: '/v1/payments', upstream: 'https://staging.api.example.com' }],
  timeoutMs: 30000,
  maxResponseBytes: 10485760,
  maxConcurrent: 4,
};

const item = (exchange: string, extra: Doc = {}): Doc => ({
  id: `default/${exchange}`,
  scenario: 'default',
  exchange,
  at: `2026-10-03T14:20:${exchange.slice(-2)}.000Z`,
  method: 'POST',
  target: `/v1/payments?attempt=${exchange}`,
  registration: '/v1/payments',
  outcome: 'captured',
  status: 402,
  durationMs: 84,
  detailHref: `captures/default/${exchange}`,
  ...extra,
});

const DETAIL: Doc = {
  id: 'default/000001',
  request: {
    state: 'available',
    method: 'POST',
    target: '/v1/payments?attempt=000001',
    registration: { method: 'POST', path: '/v1/payments' },
    params: [],
    headers: [{ name: 'authorization', value: 'Bearer staging-token' }],
    body: { state: 'available', encoding: 'utf8', value: '{"amount":5}', byteLength: 12, truncated: false },
  },
  response: {
    state: 'available',
    status: 402,
    fileName: '402.json',
    headers: [{ name: 'set-cookie', value: 'sid=1' }],
    body: { state: 'available', encoding: 'utf8', value: '{"error":"declined"}', byteLength: 20, truncated: false },
    modified: true,
  },
  provenance: {
    state: 'available',
    format: 'janus.capture.v1',
    capturedAt: '2026-10-03T14:20:55.120Z',
    durationMs: 84,
    registration: { method: 'POST', path: '/v1/payments', upstream: 'https://staging.api.example.com' },
    removedHeaders: ['connection', 'date'],
    notes: [{ code: 'body-encoded', message: 'the body was encoded' }],
  },
};

/** A server with one registration, serving `items` as its capture list. */
function recordingAtlas(items: () => readonly Doc[], detail: Doc | null = DETAIL): FakeAtlas {
  const fake = new FakeAtlas();
  fake.capabilities = {
    resolve: true,
    reload: true,
    watch: false,
    events: true,
    recording: { available: true, endpoints: 1 },
  };
  fake.extra = (path, url) => {
    if (path === 'recording') return jsonResponse(200, { apiVersion: 'atlas.v1', ...RECORDING });
    if (path === 'captures') {
      const outcome = url.searchParams.get('outcome');
      const all = items().filter((entry) => outcome === null || entry['outcome'] === outcome);
      const before = url.searchParams.get('before');
      const start = before === null ? 0 : all.findIndex((entry) => entry['id'] === before) + 1;
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? (page.at(-1)?.['id'] as string) : null;
      return jsonResponse(200, { apiVersion: 'atlas.v1', items: page, next });
    }
    if (path === 'captures/default/000001' && detail !== null) {
      return jsonResponse(200, { apiVersion: 'atlas.v1', ...detail });
    }
    if (path.startsWith('captures/')) return errorResponse(404, 'atlas-resource-not-found', 'No capture');
    return null;
  };
  return fake;
}

function renderApp(fake: FakeAtlas, hash: string) {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  const events = fakeEventSources();
  render(
    <App
      client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })}
      eventSource={events.create}
    />,
  );
  return { fake, events, user: userEvent.setup() };
}

const table = () => screen.getByRole('table', { name: /Recorded exchanges/ });

describe('capture review page', () => {
  it('is reached from a Captures tab only when endpoints are registered', async () => {
    const { user } = renderApp(
      recordingAtlas(() => [item('000001')]),
      '',
    );
    const tab = await screen.findByRole('link', { name: 'Captures' });
    await user.click(tab);
    expect(await screen.findByRole('heading', { name: 'Captures', level: 2 })).toBeDefined();

    const plain = new FakeAtlas();
    window.location.hash = '';
    document.body.innerHTML = '';
    renderApp(plain, '');
    await screen.findByRole('link', { name: 'Requests' });
    expect(screen.queryByRole('link', { name: 'Captures' })).toBeNull();
  });

  it('lists exchanges with their outcome, says captures are not served, and offers no changes', async () => {
    const { user } = renderApp(
      recordingAtlas(() => [
        item('000002', { outcome: 'upstream-timeout', status: undefined, detailHref: undefined }),
        item('000001'),
      ]),
      '#/captures',
    );
    const rows = within(await waitFor(table)).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('Upstream timed out');
    expect(within(rows[1] as HTMLElement).queryByRole('link')).toBeNull();
    expect(within(rows[2] as HTMLElement).getByRole('link', { name: '/v1/payments?attempt=000001' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'About captures' }));
    expect(screen.getByRole('tooltip').textContent).toContain('Captures are not served.');
    // The only controls filter and page; nothing deletes, moves or promotes.
    const buttons = screen.queryAllByRole('button').map((button) => button.textContent);
    expect(buttons.filter((text) => /delete|remove|promote|move/i.test(text))).toEqual([]);
  });

  it('filters the page by text, and opens a capture from anywhere on its row', async () => {
    const { user } = renderApp(
      recordingAtlas(() => [
        item('000002', { outcome: 'upstream-timeout', status: undefined, detailHref: undefined }),
        item('000001'),
      ]),
      '#/captures',
    );
    await waitFor(table);
    await user.type(screen.getByRole('searchbox', { name: 'Filter captures' }), 'timed out');
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByRole('searchbox', { name: 'Filter captures' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter captures' }), 'nothing like this');
    expect(screen.getByText(/No capture on this page matches/)).toBeDefined();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter captures' }));
    const row = within(table())
      .getAllByRole('row')
      .find((entry) => entry.textContent.includes('Captured'));
    await user.click(within(row as HTMLElement).getByText('Recording'));
    expect(await screen.findByRole('region', { name: 'Request' })).toBeDefined();
    expect(window.location.hash).toMatch(/^#\/captures\/default\/000001/);
  });

  it('shows why an upstream could not be reached', async () => {
    renderApp(
      recordingAtlas(() => [
        item('000002', { outcome: 'upstream-failed', reason: 'refused', status: undefined, detailHref: undefined }),
        item('000001', {
          outcome: 'upstream-failed',
          reason: 'something-new',
          status: undefined,
          detailHref: undefined,
        }),
      ]),
      '#/captures',
    );
    const rows = within(await waitFor(table)).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('Upstream failed: connection refused');
    expect(rows[2]?.textContent).toContain('Upstream failed: something-new');
  });

  it('filters by outcome and pages with next', async () => {
    const { fake, user } = renderApp(
      recordingAtlas(() => [item('000003'), item('000002'), item('000001', { outcome: 'capture-failed' })]),
      '#/captures',
    );
    await waitFor(table);
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => {
      expect(within(table()).getAllByRole('row')).toHaveLength(2);
    });
    expect(fake.requests.some((request) => request.includes('before=default%2F000002'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Newest' }));
    await user.selectOptions(screen.getByLabelText('Outcome'), 'capture-failed');
    await waitFor(() => {
      expect(fake.requests.at(-1)).toContain('outcome=capture-failed');
    });
  });

  it('shows new captures as events arrive and announces them without moving focus', async () => {
    let items = [item('000001')];
    const { events } = renderApp(
      recordingAtlas(() => items),
      '#/captures',
    );
    await waitFor(table);
    const source = events.latest();
    if (source === undefined) throw new Error('no event source');
    const focused = document.activeElement;
    items = [item('000002'), ...items];
    act(() => {
      source.emit('state', { snapshotVersion: V1, lastReload: null });
      source.emit('capture', { id: 'default/000002', scenario: 'default', outcome: 'captured' });
    });
    await waitFor(() => {
      expect(within(table()).getAllByRole('row')).toHaveLength(3);
    });
    const live = screen
      .getAllByRole('status')
      .find((element) => element.textContent.includes('New capture default/000002'));
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(focused);
  });

  it('shows a capture as stored, with the modified note and provenance', async () => {
    renderApp(
      recordingAtlas(() => [item('000001')]),
      '#/captures/default/000001',
    );
    const request = await screen.findByRole('region', { name: 'Request' });
    expect(request.textContent).toContain('Bearer staging-token');
    const response = screen.getByRole('region', { name: 'Response' });
    expect(response.textContent).toContain('402.json');
    expect(response.textContent).toContain('set-cookie');
    expect(screen.getByRole('note').textContent).toContain('Modified since capture');
    const provenance = screen.getByRole('region', { name: 'Provenance' });
    expect(provenance.textContent).toContain('https://staging.api.example.com');
    expect(provenance.textContent).toContain('connection, date');
    expect(provenance.textContent).toContain('relayed as sent but not stored');
    expect(screen.queryByText('Captures are not served.')).toBeNull();
  });

  it('marks unreadable parts and answers an unknown capture plainly', async () => {
    renderApp(
      recordingAtlas(() => [], { ...DETAIL, response: { state: 'unreadable' }, provenance: { state: 'unreadable' } }),
      '#/captures/default/000001',
    );
    const response = await screen.findByRole('region', { name: 'Response' });
    expect(response.textContent).toContain('Unreadable');
    document.body.innerHTML = '';
    renderApp(
      recordingAtlas(() => []),
      '#/captures/default/000009',
    );
    expect(await screen.findByRole('heading', { name: 'No such capture' })).toBeDefined();
  });
});

describe('recording settings', () => {
  it('lists each registration as a sentence with the limits', async () => {
    renderApp(
      recordingAtlas(() => []),
      '#/config',
    );
    const section = await screen.findByRole('region', { name: 'Recording' });
    await waitFor(() => {
      expect(section.textContent).toContain('POST /v1/payments is forwarded to https://staging.api.example.com');
    });
    expect(section.textContent).toContain('30000 ms');
    expect(section.textContent).toContain('at most 4');
  });

  it('says recording is off without registrations', async () => {
    renderApp(new FakeAtlas(), '#/config');
    const section = await screen.findByRole('region', { name: 'Recording' });
    expect(section.textContent).toContain('Recording is off');
  });
});

describe('the explorer recording step', () => {
  it('accepts X-Mock-Record and explains what would be forwarded, saying nothing was sent', async () => {
    const fake = recordingAtlas(() => []);
    fake.resolver = () => ({
      snapshotVersion: V1,
      response: null,
      trace: {
        snapshotVersion: V1,
        scenario: 'default',
        normalizedPath: '/v1/payments',
        outcome: {
          kind: 'would-record',
          registration: { method: 'POST', path: '/v1/payments' },
          upstream: 'https://staging.api.example.com/v1/payments',
          forwardedHeaders: ['authorization', 'accept-encoding'],
        },
      },
      fixture: null,
      notes: ['nothing was sent: a simulation never contacts the upstream or writes a capture'],
    });
    const { user } = renderApp(fake, '#/explorer');
    const editor = await screen.findByRole('form', { name: 'Request to simulate' });
    await user.clear(within(editor).getByLabelText('Target (path and query)'));
    await user.type(within(editor).getByLabelText('Target (path and query)'), '/v1/payments');
    await user.click(within(editor).getByRole('button', { name: 'Add header' }));
    await user.type(within(editor).getByLabelText('Header 1 name'), 'X-Mock-Record');
    await user.type(within(editor).getByLabelText('Header 1 value'), 'true');
    await user.click(within(editor).getByRole('button', { name: 'Explain' }));

    const region = await screen.findByRole('region', { name: 'Simulated response' });
    expect(fake.envelopes.at(-1)?.['headers']).toEqual({ 'x-mock-record': ['true'] });
    expect(within(region).getByRole('heading', { name: 'Would record' })).toBeDefined();
    expect(region.textContent).toContain('https://staging.api.example.com/v1/payments');
    const decisions = within(region).getByRole('list', { name: 'Decisions' });
    expect(decisions.textContent).toContain('POST /v1/payments');
    expect(decisions.textContent).toContain('authorization');
    expect(decisions.textContent).toContain('Nothing was sent');
    expect(within(region).queryByRole('tab', { name: /Body/ })).toBeNull();
  });
});

describe('capture events beyond the retained history', () => {
  it('keeps refreshing and announcing captures after twenty events', async () => {
    let items = [item('000001')];
    const { events } = renderApp(
      recordingAtlas(() => items),
      '#/captures',
    );
    await waitFor(table);
    const source = events.latest();
    if (source === undefined) throw new Error('no event source');
    act(() => {
      for (let i = 1; i <= 20; i++) {
        source.emit('capture', {
          id: `default/${String(i).padStart(6, '0')}`,
          scenario: 'default',
          outcome: 'captured',
        });
      }
    });
    await waitFor(() => {
      expect(
        screen.getAllByRole('status').some((element) => element.textContent.includes('New capture default/000020')),
      ).toBe(true);
    });
    items = [item('000021'), ...items];
    act(() => {
      source.emit('capture', { id: 'default/000021', scenario: 'default', outcome: 'captured' });
    });
    expect(await screen.findByRole('link', { name: '/v1/payments?attempt=000021' })).toBeDefined();
    expect(
      screen.getAllByRole('status').some((element) => element.textContent.includes('New capture default/000021')),
    ).toBe(true);
  });

  it('counts new captures on an older page after twenty events without refetching that page', async () => {
    let items = [item('000003'), item('000002'), item('000001')];
    const { events, fake, user } = renderApp(
      recordingAtlas(() => items),
      '#/captures',
    );
    await waitFor(table);
    const source = events.latest();
    if (source === undefined) throw new Error('no event source');
    act(() => {
      for (let i = 1; i <= 20; i++) {
        source.emit('capture', {
          id: `default/${String(i).padStart(6, '0')}`,
          scenario: 'default',
          outcome: 'captured',
        });
      }
    });
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => {
      expect(within(table()).getAllByRole('row')).toHaveLength(2);
    });
    const requests = fake.requests.filter((request) => request.startsWith('/_janus/captures')).length;
    items = [item('000022'), item('000021'), ...items];
    act(() => {
      source.emit('capture', { id: 'default/000021', scenario: 'default', outcome: 'captured' });
      source.emit('capture', { id: 'default/000022', scenario: 'default', outcome: 'captured' });
    });
    expect(screen.getByRole('button', { name: 'Newest · 2 new' })).toBeDefined();
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
    expect(fake.requests.filter((request) => request.startsWith('/_janus/captures')).length).toBe(requests);
    await user.click(screen.getByRole('button', { name: 'Newest · 2 new' }));
    expect(await screen.findByRole('link', { name: '/v1/payments?attempt=000022' })).toBeDefined();
  });
});
