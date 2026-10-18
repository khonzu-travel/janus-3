import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, FakeAtlas, PRODUCTS, V2 } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import type { WireTrace } from '../atlas/wire.js';
import { decodeConfig } from '../config.js';
import { explain } from './explorer/Explanation.js';
import { draftFromSearch, draftToSearch, EMPTY_DRAFT, envelopeOf, headerRow } from './explorer/requestState.js';

// The resolution explorer: the Requests tab's unsaved request in Explore mode.

function renderApp(fake = new FakeAtlas(), hash = '#/explorer') {
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

const form = () => screen.findByRole('form', { name: 'Request to simulate' });
const result = () => screen.findByRole('region', { name: 'Simulated response' });
const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

describe('the explorer', () => {
  it('is reachable from the navigation and always states that it only simulates', async () => {
    const { user } = renderApp(new FakeAtlas(), '');
    await user.click(await within(await screen.findByRole('banner')).findByRole('link', { name: 'Requests' }));
    const editor = await form();
    expect(within(editor).getByText('Simulation only — nothing is served, stored or sent.')).toBeDefined();
    expect(within(editor).getByRole('button', { name: 'Explain' }).getAttribute('aria-describedby')).toBe(
      within(editor).getByText(/Simulation only/).id,
    );
  });

  it('sends the request, shows the response and explains every decision', async () => {
    const { fake, user } = renderApp();
    const editor = await form();
    await user.clear(within(editor).getByLabelText('Target (path and query)'));
    await user.type(within(editor).getByLabelText('Target (path and query)'), '/v1/products');
    await user.click(within(editor).getByRole('button', { name: 'Add header' }));
    await user.type(within(editor).getByLabelText('Header 1 name'), 'Accept');
    await user.type(within(editor).getByLabelText('Header 1 value'), 'application/json');
    await user.click(within(editor).getByRole('button', { name: 'Explain' }));

    const region = await result();
    expect(fake.envelopes).toEqual([
      { method: 'GET', target: '/v1/products', headers: { accept: ['application/json'] } },
    ]);
    expect(within(region).getByRole('heading', { name: 'Status 200' })).toBeDefined();
    expect(within(region).getByText(/transport limits \(413, 414, 431\) are not simulated/)).toBeDefined();

    // The decisions tab opens first, one line per step: number, title, result, detail.
    const steps = within(region).getByRole('list', { name: 'Decisions' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((item) =>
          [...item.children]
            .slice(0, 3)
            .map((cell) => cell.textContent)
            .join(''),
        ),
    ).toEqual([
      '1.RouteDecided',
      '2.Path parametersNoted',
      '3.MethodDecided',
      '4.Request media typeDecided',
      '5.LanguageNoted',
      '6.Media typeDecided',
      '7.Header policyDecided',
      '8.OutcomeDecided',
    ]);
    expect(within(steps).getAllByRole('heading')[0]?.textContent).toBe('Route');
    expect(steps.textContent).toContain('Templates considered and abandoned: /v1/products/p-1.');
    expect(steps.textContent).toContain('Fixture fx_0000000000000011 answered');

    // Header values are shown as served.
    await user.click(within(region).getByRole('tab', { name: /^Headers/ }));
    const headers = within(region).getByRole('table', { name: 'Response headers' });
    expect(within(headers).getByText('session=example')).toBeDefined();
    await user.click(within(region).getByRole('tab', { name: 'Body' }));
    await user.click(within(region).getByRole('button', { name: 'Text' }));
    expect(within(region).getByLabelText('Body preview (text)').textContent).toBe('[{"id":"p-1"}]');

    // The fixture that answered is a link to its Atlas detail.
    await user.click(within(region).getByRole('link', { name: 'Open the fixture that answered' }));
    expect(await screen.findByRole('heading', { level: 2, name: /\/v1\/products/ })).toBeDefined();
    expect(window.location.hash).toContain(`/endpoints/${PRODUCTS.id}/fixtures/fx_0000000000000011`);
  });

  it('explains a miss with the abandoned prefixes, and links no fixture', async () => {
    renderApp(new FakeAtlas(), '#/explorer?m=GET&t=/v1/nowhere');
    const region = await result();
    expect(within(region).getByRole('heading', { name: 'Status 404' })).toBeDefined();
    expect(region.textContent).toContain('Janus generated this response; no fixture answered.');
    expect(within(region).getByRole('list', { name: 'Decisions' }).textContent).toContain(
      'Templates considered and abandoned: /v1.',
    );
    expect(within(region).queryByRole('link', { name: 'Open the fixture that answered' })).toBeNull();
  });

  it('sends a body, its Content-Type and an instant', async () => {
    const { fake, user } = renderApp();
    const editor = await form();
    await user.clear(within(editor).getByLabelText('Method'));
    await user.type(within(editor).getByLabelText('Method'), 'POST');
    await user.click(within(editor).getByLabelText('Send a body'));
    await user.type(within(editor).getByLabelText('Body Content-Type'), 'application/json');
    await user.click(within(editor).getByLabelText('Base64'));
    await user.type(within(editor).getByLabelText('Body (base64)'), 'e30=');
    await user.type(screen.getByLabelText('Render at'), '2026-01-01T00:00:00Z');
    await user.click(within(editor).getByRole('button', { name: 'Explain' }));
    await result();
    expect(fake.envelopes).toEqual([
      {
        method: 'POST',
        target: '/',
        headers: { 'content-type': ['application/json'] },
        body: { encoding: 'base64', data: 'e30=' },
        nowMs: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('keeps method, target and every header in the hash, but never the body', async () => {
    const { user } = renderApp();
    const editor = await form();
    await user.clear(within(editor).getByLabelText('Target (path and query)'));
    await user.type(within(editor).getByLabelText('Target (path and query)'), '/v1/products?x=1');
    await user.click(within(editor).getByRole('button', { name: 'Add header' }));
    await user.type(within(editor).getByLabelText('Header 1 name'), 'Accept');
    await user.type(within(editor).getByLabelText('Header 1 value'), 'text/plain');
    await user.click(within(editor).getByRole('button', { name: 'Add header' }));
    await user.type(within(editor).getByLabelText('Header 2 name'), 'Authorization');
    await user.type(within(editor).getByLabelText('Header 2 value'), 'Bearer example-token');
    await user.click(within(editor).getByLabelText('Send a body'));
    await user.type(within(editor).getByLabelText('Body (text)'), 'body-secret');
    await user.click(within(editor).getByRole('button', { name: 'Explain' }));
    await result();

    const params = hashParams();
    expect(params.get('m')).toBe('GET');
    expect(params.get('t')).toBe('/v1/products?x=1');
    expect(params.getAll('h')).toEqual(['Accept: text/plain', 'Authorization: Bearer example-token']);
    expect(window.location.href).not.toContain('body-secret');
    expect(screen.getByText(/The body is never part of it/)).toBeDefined();
  });

  it('restores a shared link, header values included, and runs it', async () => {
    const { fake } = renderApp(
      new FakeAtlas(),
      '#/explorer?m=GET&t=%2Fv1%2Fproducts&h=Accept%3A+application%2Fjson&h=Cookie%3A+c%3D1',
    );
    const editor = await form();
    expect(within(editor).getByLabelText<HTMLInputElement>('Header 1 name').value).toBe('Accept');
    expect(within(editor).getByLabelText<HTMLInputElement>('Header 2 name').value).toBe('Cookie');
    expect(within(editor).getByLabelText<HTMLInputElement>('Header 2 value').value).toBe('c=1');
    await result();
    expect(fake.envelopes).toEqual([
      {
        method: 'GET',
        target: '/v1/products',
        headers: { accept: ['application/json'], cookie: ['c=1'] },
      },
    ]);
  });

  it.each([
    { configured: 'default', requested: null, sent: undefined },
    { configured: 'declined', requested: null, sent: undefined },
    { configured: 'default', requested: 'declined', sent: 'declined' },
  ])('fills in the top bar’s scenario ($requested on $configured)', async ({ configured, requested, sent }) => {
    const fake = new FakeAtlas();
    fake.capabilities = { resolve: true, reload: true, watch: false, events: true, scenarios: true };
    fake.healthOverride = { configuredDefaultScenario: configured };
    const search = new URLSearchParams({ mode: 'explore', m: 'GET', t: '/v1/products' });
    search.append('h', 'X-Mock-Session: pinned');
    if (requested !== null) search.set('scenario', requested);
    const { user } = renderApp(fake, `#/requests?${search.toString()}`);
    await result();
    // A picked scenario fills in; the configured default leaves it to Janus (a session pin, else the default).
    expect(fake.envelopes.at(-1)?.scenario).toBe(sent);
    if (requested === null) expect(hashParams().has('scenario')).toBe(false);
    // Picking another scenario in the top bar (the hash's `scenario`) applies to the next Explain.
    const editor = await form();
    const picked = requested === 'declined' ? 'default' : 'declined';
    const next = hashParams();
    if (picked === configured) next.delete('scenario');
    else next.set('scenario', picked);
    act(() => {
      window.location.hash = `#/requests?${next.toString()}`;
    });
    // The top bar shows it once the page has the new address.
    await waitFor(() => {
      expect(within(screen.getByRole('banner')).getByRole('button', { name: /^Scenario / }).textContent).toContain(
        picked,
      );
    });
    await user.click(within(editor).getByRole('button', { name: 'Explain' }));
    await waitFor(() => {
      expect(fake.envelopes).toHaveLength(2);
    });
    expect(fake.envelopes.at(-1)?.scenario).toBe(picked === configured ? undefined : picked);
    expect(fake.envelopes.at(-1)?.headers).toEqual({ 'x-mock-session': ['pinned'] });
  });

  it('removes header rows, one at a time or all at once', async () => {
    const { user } = renderApp(new FakeAtlas(), '#/explorer?m=GET&t=/&h=A%3A+1&h=B%3A+2&h=C%3A+3');
    const editor = await form();
    await user.click(within(editor).getByRole('button', { name: 'Remove header 1 (A)' }));
    expect(within(editor).getByLabelText<HTMLInputElement>('Header 1 name').value).toBe('B');
    await user.click(within(editor).getByRole('button', { name: 'Clear all headers' }));
    expect(within(editor).queryByLabelText('Header 1 name')).toBeNull();
    expect(within(editor).getByText('No headers.')).toBeDefined();
    expect(within(editor).queryByRole('button', { name: 'Clear all headers' })).toBeNull();
  });

  it('refuses an X-Mock-Scenario header and offers the scenario list instead', async () => {
    const fake = new FakeAtlas();
    fake.capabilities = { resolve: true, reload: true, watch: false, events: true, scenarios: true };
    const { user } = renderApp(fake, '#/explorer?m=GET&t=%2Fv1%2Fproducts&h=A%3A+1&h=X-Mock-Scenario%3A+declined');
    const editor = await form();
    // A link carrying the header is not simulated.
    const name = await within(editor).findByLabelText('Header 2 name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const error = document.getElementById(name.getAttribute('aria-describedby') ?? '');
    expect(error?.textContent).toBe('The scenario is not set with a header here. Pick “declined” in the scenario list');
    const send = within(editor).getByRole<HTMLInputElement>('checkbox', { name: 'Send header 2 (X-Mock-Scenario)' });
    expect(send.checked).toBe(false);
    expect(send.disabled).toBe(true);
    const explain = within(editor).getByRole<HTMLButtonElement>('button', { name: 'Explain' });
    expect(explain.disabled).toBe(true);
    await user.type(within(editor).getByLabelText('Target (path and query)'), '{Control>}{Enter}{/Control}');
    expect(fake.envelopes).toEqual([]);

    await user.click(within(editor).getByRole('button', { name: 'Pick “declined” in the scenario list' }));
    expect(hashParams().get('scenario')).toBe('declined');
    expect(within(editor).queryByLabelText('Header 2 name')).toBeNull();
    expect(within(editor).getByLabelText<HTMLInputElement>('Header 1 name').value).toBe('A');
    expect(explain.disabled).toBe(false);
    await user.click(explain);
    await waitFor(() => {
      expect(fake.envelopes).toHaveLength(1);
    });
    expect(fake.envelopes[0]).toMatchObject({ scenario: 'declined', headers: { a: ['1'] } });
  });

  it('removes an X-Mock-Scenario row with no value, leaving the scenario as it is', async () => {
    const { user } = renderApp(new FakeAtlas(), '#/explorer?m=GET&t=/');
    const editor = await form();
    await user.click(within(editor).getByRole('button', { name: 'Add header' }));
    await user.type(within(editor).getByLabelText('Header 1 name'), 'x-mock-scenario');
    await user.click(within(editor).getByRole('button', { name: 'Pick one in the scenario list' }));
    expect(within(editor).queryByLabelText('Header 1 name')).toBeNull();
    expect(hashParams().has('scenario')).toBe(false);
  });

  it('keeps an unchecked header in the form and the link, but does not send it', async () => {
    const fake = new FakeAtlas();
    const { user } = renderApp(fake, '#/explorer?m=GET&t=%2Fv1%2Fproducts&h=A%3A+1&h=%23B%3A+2');
    const editor = await form();
    await result();
    expect(within(editor).getByRole<HTMLInputElement>('checkbox', { name: 'Send header 2 (B)' }).checked).toBe(false);
    expect(fake.envelopes.at(-1)?.headers).toEqual({ a: ['1'] });

    await user.click(within(editor).getByRole('checkbox', { name: 'Send header 1 (A)' }));
    await user.click(within(editor).getByRole('checkbox', { name: 'Send header 2 (B)' }));
    await user.click(within(editor).getByRole('button', { name: 'Explain' }));
    await waitFor(() => {
      expect(fake.envelopes.at(-1)?.headers).toEqual({ b: ['2'] });
    });
    expect(within(editor).getByLabelText<HTMLInputElement>('Header 1 name').value).toBe('A');
    expect(new URLSearchParams(window.location.hash.split('?')[1]).getAll('h')).toEqual(['#A: 1', 'B: 2']);
  });

  it('pre-fills from "Try it", with the first parameter placeholder selected', async () => {
    const fake = new FakeAtlas();
    fake.endpoints = [
      ...fake.endpoints,
      {
        id: 'ep_0000000000000009',
        method: 'GET',
        path: '/v1/orders/{orderId}/lines/{lineId}',
        variations: { pathParameters: ['orderId', 'lineId'], accepts: null },
        fixtures: [],
      },
    ];
    const { user } = renderApp(fake, '#/endpoints/ep_0000000000000009');
    await user.click(await screen.findByRole('link', { name: /^Try it/ }));
    const editor = await form();
    const target = within(editor).getByLabelText<HTMLInputElement>('Target (path and query)');
    expect(target.value).toBe('/v1/orders/{orderId}/lines/{lineId}');
    await waitFor(() => {
      expect(document.activeElement).toBe(target);
    });
    expect(target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0)).toBe('{orderId}');
    // Nothing ran yet: the placeholder needs a value first.
    expect(fake.envelopes).toEqual([]);
  });

  it('shows the disabled state when the server does not offer it', async () => {
    const fake = new FakeAtlas();
    fake.capabilities = { resolve: false, reload: true, watch: false, events: true };
    renderApp(fake);
    expect(await screen.findByRole('heading', { name: 'Explore is off' })).toBeDefined();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('treats a server without capabilities as having no explorer', async () => {
    const fake = new FakeAtlas();
    fake.capabilities = null;
    renderApp(fake);
    expect(await screen.findByRole('heading', { name: 'Explore is off' })).toBeDefined();
  });

  it('reports a rejected request with its code', async () => {
    const fake = new FakeAtlas();
    fake.resolver = () =>
      new Response(
        JSON.stringify({
          error: { code: 'atlas-invalid-request', message: 'Invalid Atlas request: "nowMs" must be…' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const { user } = renderApp(fake);
    await user.click(within(await form()).getByRole('button', { name: 'Explain' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not simulate the request');
    expect(alert.textContent).toContain('atlas-invalid-request');
  });

  it("explains a failed render with the server's own reason (review B2)", async () => {
    const fake = new FakeAtlas();
    // The trace exactly as core sends it: fixture, token and reason, nothing else.
    fake.resolver = () => ({
      snapshotVersion: fake.version,
      response: {
        status: 500,
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: { state: 'available', encoding: 'utf8', value: '{}', byteLength: 2, truncated: false },
      },
      trace: {
        snapshotVersion: fake.version,
        normalizedPath: '/v1/products',
        outcome: {
          kind: 'render-failed',
          fixture: { path: 'default/v1/products/GET/200_{application-json}.json' },
          token: 'query.q',
          reason: 'the request has no value for it and dynamic.strictRefs is true',
        },
        route: { template: '/v1/products', params: {}, considered: [] },
      },
      fixture: null,
      notes: [],
    });
    const { user } = renderApp(fake);
    await user.click(within(await form()).getByRole('button', { name: 'Explain' }));
    const decisions = within(await result()).getByRole('list', { name: 'Decisions' });
    expect(decisions.textContent).toContain(
      'Rendering failed at {{$query.q}}: the request has no value for it and dynamic.strictRefs is true.',
    );
    expect(decisions.textContent).not.toContain('no instant available');
  });

  it('names the configured idempotency.header, in the explorer and on the endpoint (review C3)', async () => {
    const fake = new FakeAtlas();
    fake.config = {
      ...DEFAULT_CONFIG,
      settings: [...DEFAULT_CONFIG.settings, { key: 'idempotency.header', value: 'x-retry-token', source: 'file' }],
    };
    fake.endpoints = [
      {
        ...PRODUCTS,
        controls: { rules: null, pages: null, sequence: null, expect: null, idempotent: true },
      },
    ];
    const { user } = renderApp(fake);
    const editor = await form();
    await waitFor(() => {
      expect(fake.requests.some((request) => request.includes('/_janus/config'))).toBe(true);
    });
    await user.click(await within(editor).findByRole('button', { name: 'Add idempotency key' }));
    await waitFor(() => {
      expect(within(editor).getByLabelText<HTMLInputElement>('Header 1 name').value).toBe('X-Retry-Token');
    });
    expect(within(editor).queryByRole('button', { name: 'Add idempotency key' })).toBeNull();

    window.location.hash = `#/endpoints/${PRODUCTS.id}`;
    const panel = await screen.findByRole('region', { name: 'Controls' });
    expect(panel.textContent).toContain('Retried requests with the same X-Retry-Token are replayed.');
  });

  it('labels a result from an older snapshot as stale and re-runs it', async () => {
    const { fake, events, user } = renderApp(new FakeAtlas(), '#/explorer?m=GET&t=/v1/products');
    const region = await result();
    expect(within(region).queryByText('Stale result')).toBeNull();
    act(() => {
      events.latest()?.emit('snapshot', { snapshotVersion: V2, previousVersion: fake.version });
    });
    expect(await within(await result()).findByText('Stale result')).toBeDefined();
    fake.version = V2;
    await user.click(within(await result()).getByRole('button', { name: 'Re-run' }));
    await waitFor(() => {
      expect(fake.envelopes).toHaveLength(2);
    });
    await waitFor(async () => {
      expect(within(await result()).queryByText('Stale result')).toBeNull();
    });
  });

  it('does not re-run when only the inventory part of the hash changes', async () => {
    const { fake } = renderApp(new FakeAtlas(), '#/explorer?m=GET&t=/v1/products');
    await result();
    // The explorer shows no tree, but the hash still carries the inventory's search.
    const next = hashParams();
    next.set('q', 'pro');
    await act(async () => {
      window.location.hash = `#/requests?${next.toString()}`;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(fake.envelopes).toHaveLength(1);
    expect(hashParams().get('q')).toBe('pro');
    expect(hashParams().get('t')).toBe('/v1/products');
  });
});

describe('request state', () => {
  it('round-trips the shareable fields, every header value included, but not the body', () => {
    const draft = {
      ...EMPTY_DRAFT,
      method: 'PATCH',
      target: '/a?b=c',
      headers: [headerRow('X-A', '1'), headerRow('Cookie', 'c=1', false), headerRow('', 'ignored')],
      includeBody: true,
      body: 'body text',
    };
    const search = draftToSearch(draft, new URLSearchParams('q=prod&method=GET'));
    expect(search.toString()).not.toContain('body');
    expect(search.get('q')).toBe('prod');
    const back = draftFromSearch(search);
    expect(back?.method).toBe('PATCH');
    expect(back?.target).toBe('/a?b=c');
    expect(back?.headers.map(({ name, value, enabled }) => [name, value, enabled])).toEqual([
      ['X-A', '1', true],
      ['Cookie', 'c=1', false],
    ]);
    expect(back?.includeBody).toBe(false);
  });

  it('builds the envelope, adding the body Content-Type unless a header sets one', () => {
    const base = { ...EMPTY_DRAFT, includeBody: true, body: '{}', bodyContentType: 'application/json' };
    expect(envelopeOf(base).headers).toEqual({ 'content-type': ['application/json'] });
    expect(envelopeOf({ ...base, headers: [headerRow('Content-Type', 'text/plain')] }).headers).toEqual({
      'content-type': ['text/plain'],
    });
    expect(envelopeOf({ ...base, headers: [headerRow('X', '1'), headerRow('x', '2')] }).headers).toEqual({
      x: ['1', '2'],
      'content-type': ['application/json'],
    });
  });
});

describe('explanation steps', () => {
  const trace = (patch: Partial<WireTrace>): WireTrace => ({
    snapshotVersion: 'aaaaaaaaaaaaaaaa',
    normalizedPath: '/p',
    scenario: null,
    selection: null,
    resolvedFrom: null,
    shadowed: [],
    shadowedCount: null,
    session: null,
    outcome: {
      kind: 'matched',
      allowed: null,
      axis: null,
      available: null,
      accepted: null,
      reason: null,
      token: null,
      source: null,
      known: null,
      failed: null,
      registration: null,
      upstream: null,
      forwardedHeaders: null,
      fault: null,
    },
    route: { template: '/p', params: {}, considered: [] },
    negotiation: null,
    headers: null,
    render: null,
    choice: null,
    expect: null,
    sequence: null,
    replay: null,
    transport: null,
    ...patch,
  });
  const outcome = (kind: string, extra: Partial<WireTrace['outcome']> = {}): WireTrace['outcome'] => ({
    kind,
    allowed: null,
    axis: null,
    available: null,
    accepted: null,
    reason: null,
    token: null,
    source: null,
    known: null,
    failed: null,
    registration: null,
    upstream: null,
    forwardedHeaders: null,
    fault: null,
    ...extra,
  });
  const titles = (steps: ReturnType<typeof explain>) => steps.map((step) => `${step.title}:${step.state}`);

  it('stops at the method for method-not-allowed', () => {
    expect(titles(explain(trace({ outcome: outcome('method-not-allowed', { allowed: ['GET'] }) }), 405))).toEqual([
      'Route:passed',
      'Path parameters:info',
      'Method:failed',
      'Outcome:failed',
    ]);
  });

  it('stops at the request media type for unsupported-media-type', () => {
    expect(
      titles(explain(trace({ outcome: outcome('unsupported-media-type', { accepted: ['application/json'] }) }), 415)),
    ).toEqual(['Route:passed', 'Path parameters:info', 'Method:passed', 'Request media type:failed', 'Outcome:failed']);
  });

  it('stops at the language for a language miss', () => {
    expect(
      titles(explain(trace({ outcome: outcome('not-acceptable', { axis: 'language', available: ['fr'] }) }), 406)),
    ).toContain('Language:failed');
  });

  it('reports rendering, and a failed render', () => {
    const rendered = explain(
      trace({ render: { instant: '2026-01-01T00:00:00Z', clockSource: 'caller', tokens: 2, nondeterministic: true } }),
      200,
    );
    expect(titles(rendered)).toContain('Rendering:passed');
    expect(
      titles(explain(trace({ outcome: outcome('render-failed', { token: 'now', reason: 'no clock' }) }), 500)),
    ).toContain('Rendering:failed');
    // An older server sends no reason; the step then guesses none.
    const step = explain(trace({ outcome: outcome('render-failed', { token: 'now' }) }), 500).find(
      (item) => item.title === 'Rendering',
    );
    render(<>{step?.detail}</>);
    expect(document.body.textContent).toContain('Rendering failed at {{$now}}.');
  });

  it('stops before routing for a malformed request', () => {
    expect(
      titles(explain(trace({ route: null, outcome: outcome('invalid-request', { reason: 'bad' }) }), 400)),
    ).toEqual(['Request:failed', 'Outcome:failed']);
  });
});

describe('Explore editor tabs', () => {
  it.each(['utf8', 'base64'] as const)('keeps the %s body when switching editor tabs', async (encoding) => {
    const { fake, user } = renderApp(new FakeAtlas(), '#/requests?mode=explore');
    const editor = await form();
    await user.click(within(editor).getByLabelText('Send a body'));
    await user.type(within(editor).getByLabelText('Body Content-Type'), 'application/json');
    if (encoding === 'base64') await user.click(within(editor).getByLabelText('Base64'));
    const label = encoding === 'base64' ? 'Body (base64)' : 'Body (text)';
    const payload = encoding === 'base64' ? 'e30=' : 'request-payload';
    await user.type(within(editor).getByLabelText(label), payload);
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Panel actions' })).getByRole('button', { name: 'New request' }),
    );
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    await user.click(within(tabs).getByRole('link', { name: /Untitled-1/ }));
    const reopened = await form();
    expect(within(reopened).getByLabelText('Send a body')).toHaveProperty('checked', true);
    expect(within(reopened).getByLabelText(label)).toHaveProperty('value', payload);
    expect(within(reopened).getByLabelText('Body Content-Type')).toHaveProperty('value', 'application/json');
    expect(window.location.hash).not.toContain(payload);
    await result();
    expect(fake.envelopes.at(-1)?.body).toEqual({ encoding, data: payload });
    await user.click(within(reopened).getByRole('button', { name: 'Explain' }));
    await result();
  });
  it('copies headers into a new Explore tab', async () => {
    const { user } = renderApp(new FakeAtlas(), '#/requests?mode=explore');
    const editor = await form();
    await user.click(within(editor).getByRole('button', { name: 'Add header' }));
    await user.type(within(editor).getByLabelText('Header 1 name'), 'X-Trace');
    await user.type(within(editor).getByLabelText('Header 1 value'), 'keep-me');
    await user.click(within(editor).getByLabelText('Send header 1 (X-Trace)'));
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Panel actions' })).getByRole('button', { name: 'New request' }),
    );
    const next = await form();
    expect(within(next).getByLabelText('Header 1 value')).toHaveProperty('value', 'keep-me');
    expect(within(next).getByLabelText('Send header 1 (X-Trace)')).toHaveProperty('checked', false);
  });
});

it('handles prototype-property header names in shared requests', () => {
  const search = new URLSearchParams('m=GET&t=/&h=__proto__%3A+x');
  const draft = draftFromSearch(search);
  if (draft === null) throw new Error('Missing request');
  expect(envelopeOf(draft).headers?.['__proto__']).toEqual(['x']);
});
