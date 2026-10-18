import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DYNAMIC_ORDER, ENDPOINTS, FakeAtlas } from '../../test/fake-atlas.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// Dynamic values in the UI.

function renderApp(fake = withDynamic()) {
  window.location.hash = '#/endpoints';
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
  return { fake, user: userEvent.setup() };
}

function withDynamic(): FakeAtlas {
  const fake = new FakeAtlas();
  fake.endpoints = [...ENDPOINTS, DYNAMIC_ORDER];
  return fake;
}

async function openOrder(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: 'Endpoints' }, { timeout: 5000 });
  // Third-level folders start collapsed in the path tree.
  await user.click(await within(nav).findByRole('button', { name: '/v1/orders/{orderId}, path parameter orderId' }));
  await user.click(await within(nav).findByRole('link', { name: /GET \/v1\/orders\/\{orderId\}/ }));
  await user.click(await screen.findByRole('link', { name: 'View response 200' }));
  return screen.findByRole('region', { name: 'Response 200' });
}

describe('the connection header clock', () => {
  it('shows the server clock, timezone and seed', async () => {
    renderApp();
    const banner = screen.getByRole('banner');
    await waitFor(() => {
      expect(within(banner).getByText('Clock').nextElementSibling?.textContent).toBe(
        'frozen at 2026-01-01T00:00:00Z, UTC',
      );
    });
    // The seed sits in the inspector's Server section.
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByText('Seed').nextElementSibling?.textContent).toBe('42 (cli)');
  });

  it('says "live" for the wall clock, and "Not reported" for an older server', async () => {
    const fake = withDynamic();
    fake.clock = { ...(fake.clock ?? {}), mode: 'live', source: 'wall-clock', timezone: 'Europe/Paris' };
    renderApp(fake);
    const banner = screen.getByRole('banner');
    await waitFor(() => {
      expect(within(banner).getByText('Clock').nextElementSibling?.textContent).toBe('live, Europe/Paris');
    });
  });

  it('tolerates a server without the clock resource', async () => {
    const fake = withDynamic();
    fake.clock = null;
    renderApp(fake);
    const banner = screen.getByRole('banner');
    await waitFor(() => {
      expect(within(banner).getByText('Clock').nextElementSibling?.textContent).toBe('Not reported');
    });
    expect(within(screen.getByRole('complementary', { name: 'Details' })).queryByText('Seed')).toBeNull();
  });
});

describe('fixture detail', () => {
  it('highlights tokens in the raw body and lists them with their kind, stating :unique in text', async () => {
    const { user } = renderApp();
    const detail = await openOrder(user);
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByText('Dynamic values').nextElementSibling?.textContent).toBe(
      '3 tokens, rendered when served',
    );
    const toggle = within(detail).getByRole('group', { name: 'Body view' });
    expect(within(toggle).getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    const marks = within(detail).getByLabelText('Body preview (text)').querySelectorAll('mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual([
      '{{$path.orderId}}',
      '{{$tomorrow}}',
      '{{$uuid:unique}}',
    ]);
    await user.click(within(detail).getByRole('tab', { name: /^Tokens/ }));
    const rows = within(within(detail).getByRole('table', { name: 'Tokens' })).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'WhereTokenKindNotes',
      'body /id{{$path.orderId}}Request value—',
      'body /due{{$tomorrow}}Clock—',
      'body /ref{{$uuid:unique}}GeneratedUnique: differs on every request',
    ]);
  });

  it('shows no toggle for a response without dynamic values', async () => {
    const { user } = renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Endpoints' }, { timeout: 5000 });
    await user.click(await within(nav).findByRole('link', { name: 'GET /v1/greeting, scenario default' }));
    await user.click(await screen.findByRole('link', { name: 'View response 200' }));
    await screen.findByLabelText('Body preview (text)');
    expect(screen.queryByRole('group', { name: 'Body view' })).toBeNull();
  });

  it('renders on the server, shows the instant, seed and unresolved values, and re-renders with inputs', async () => {
    const { user, fake } = renderApp();
    const detail = await openOrder(user);
    await user.click(within(detail).getByRole('button', { name: 'Rendered' }));
    expect(within(detail).getByRole('button', { name: 'Rendered' }).getAttribute('aria-pressed')).toBe('true');

    await within(detail).findByText('2026-01-01T00:00:00Z');
    expect(within(detail).getByText('Instant').nextElementSibling?.textContent).toBe(
      '2026-01-01T00:00:00Z (server default)',
    );
    expect(within(detail).getByText('Seed').nextElementSibling?.textContent).toBe('42');
    expect(within(detail).getByText('Reproducible').nextElementSibling?.textContent).toMatch(/^No:/);
    expect(within(detail).getByText(/they render as null/).textContent).toContain('{{$path.orderId}}');
    expect(fake.requests.some((request) => request.endsWith('&view=rendered'))).toBe(true);

    await user.type(within(detail).getByLabelText('Render at'), '2026-03-04T00:00:00Z');
    await user.type(within(detail).getByLabelText('Path parameter {orderId}'), 'o-9');
    await user.click(within(detail).getByRole('button', { name: 'Render' }));
    await waitFor(() => {
      expect(within(detail).getByText('Instant').nextElementSibling?.textContent).toBe(
        '2026-03-04T00:00:00Z (set here)',
      );
    });
    const body = within(detail).getByLabelText('Body preview (text)');
    expect(body.textContent).toBe('{"id":"o-9","due":"2026-03-05","ref":"00000000-0000-4000-8000-000000000001"}');
    expect([...body.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      '"o-9"',
      '2026-03-05',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(fake.requests.at(-1)).toContain('now=2026-03-04T00%3A00%3A00Z');
    expect(fake.requests.at(-1)).toContain('param.orderId=o-9');
  });

  it('reports a rejected instant as an alert, and works from the keyboard', async () => {
    const { user } = renderApp();
    const detail = await openOrder(user);
    within(detail).getByRole('button', { name: 'Rendered' }).focus();
    await user.keyboard('{Enter}');
    const instant = await within(detail).findByLabelText('Render at');
    await user.click(instant);
    await user.keyboard('soon{Enter}');
    const alert = await within(detail).findByRole('alert');
    expect(alert.textContent).toContain('Could not render');
    expect(alert.textContent).toContain('"now" must be an RFC 3339 instant');
    within(detail).getByRole('button', { name: 'Raw' }).focus();
    await user.keyboard(' ');
    expect(within(detail).getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
  });
});
