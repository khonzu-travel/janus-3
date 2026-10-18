import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, ENDPOINTS, FakeAtlas, GREETING, PRODUCT_BY_ID } from '../../test/fake-atlas.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// The UI for fixture variations.

function renderApp(fake = withVariations(), hash = '#/endpoints') {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
  return { fake, user: userEvent.setup() };
}

function withVariations(): FakeAtlas {
  const fake = new FakeAtlas();
  fake.endpoints = [...ENDPOINTS, PRODUCT_BY_ID];
  return fake;
}

const inventory = () => screen.getByRole('navigation', { name: 'Endpoints' });

async function ready(): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: 'Endpoints' }, { timeout: 5000 });
  await within(nav).findAllByRole('link');
  // The template sits below the second level, so its folder starts closed.
  fireEvent.click(within(nav).getByRole('button', { name: '/v1/products/{productId}, path parameter productId' }));
  return nav;
}
const TEMPLATE_LINK = 'GET /v1/products/{productId}, path parameter productId, scenario default';

async function openTemplate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await within(await ready()).findByRole('link', { name: TEMPLATE_LINK }));
  await screen.findByRole('heading', { level: 2, name: /\/v1\/products\/\{productId\}/ });
}

describe('fixture variations in the UI', () => {
  it('shows path templates in the inventory, with parameters set apart and announced', async () => {
    renderApp();
    const link = await within(await ready()).findByRole('link', { name: TEMPLATE_LINK });
    // The tree shows the last segment under its folders; the tooltip has the whole template.
    expect(link.textContent).toBe('GET{productId}');
    expect(link.getAttribute('title')).toBe('/v1/products/{productId}');
    const parameter = within(link).getByTitle('Path parameter');
    expect(parameter.textContent).toBe('{productId}');
    // Literal paths keep their names.
    expect(within(inventory()).getByRole('link', { name: 'GET /v1/greeting, scenario default' })).toBeDefined();
  });

  it('shows a representation matrix, the path parameters and the accepted media types', async () => {
    const { user } = renderApp();
    await openTemplate(user);
    const detail = screen.getByRole('region', { name: /\/v1\/products\/\{productId\}/ });
    expect(within(detail).getByText('Path parameters').nextElementSibling?.textContent).toBe('productId');
    // Accepted request bodies sit in the inspector beside the detail.
    const details = screen.getByRole('complementary', { name: 'Details' });
    const accepted = within(details).getByRole('list', { name: 'Accepted request media types' });
    expect(
      within(accepted)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['application/json']);
    expect(details.textContent).toContain('A body without Content-Type is refused with 415.');

    const table = within(detail).getByRole('table', { name: 'Configured responses for this endpoint' });
    const rows = within(table).getAllByRole('row');
    expect(
      within(rows[0] ?? table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Locale', 'Response', 'application/json', 'application/yaml']);
    expect(rows.slice(1).map((row) => row.textContent)).toEqual([
      'Any (neutral)200View response 25 B sent as text/plain; charset=utf-8View response 8 B',
      'fr200View response 13 B—Not offered',
    ]);
    expect(within(table).getByRole('link', { name: 'View response 200 (application/json)' })).toBeDefined();
    expect(within(table).getByRole('link', { name: 'View response 200 (application/yaml)' })).toBeDefined();
    // A group with one media type keeps the short name.
    expect(within(table).getByRole('link', { name: 'View response 200 (fr)' })).toBeDefined();
  });

  it('marks dropped headers and a Content-Type override in text', async () => {
    const { user } = renderApp();
    await openTemplate(user);
    await user.click(screen.getByRole('link', { name: 'View response 200 (application/json)' }));
    const heading = await screen.findByRole('heading', { level: 2, name: 'Response 200 (application/json)' });
    const fixture = heading.closest('section') ?? document.body;
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByText('Sent Content-Type').nextElementSibling?.textContent).toContain(
      'text/plain; charset=utf-8',
    );
    expect(details.textContent).toContain('Overridden by the header sidecar');
    await user.click(within(fixture).getByRole('tab', { name: /^Headers/ }));
    const headers = within(fixture).getByRole('table', { name: 'Response headers' });
    const dateRow = within(headers)
      .getAllByRole('row')
      .find((row) => row.textContent.startsWith('date'));
    expect(dateRow?.textContent).toContain('Computed by Janus: this value is not sent');
    const varyRow = within(headers)
      .getAllByRole('row')
      .find((row) => row.textContent.startsWith('vary'));
    expect(varyRow?.textContent).toBe('varyAccept');
  });

  it('highlights JSON and YAML previews without changing their text', async () => {
    const { user } = renderApp();
    await openTemplate(user);
    await user.click(screen.getByRole('link', { name: 'View response 200 (application/json)' }));
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    const preview = await screen.findByLabelText('Body preview (text)');
    await waitFor(
      () => {
        expect(preview.querySelector('span[style]')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(preview.textContent).toBe('{"id":"any","tags":["a"]}');
    expect(preview.querySelector('script, b, a')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'View response 200 (application/yaml)' }));
    await screen.findByRole('heading', { level: 2, name: 'Response 200 (application/yaml)' });
    const yaml = screen.getByLabelText('Body preview (text)');
    await waitFor(
      () => {
        expect(yaml.querySelector('span[style]')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(yaml.textContent).toBe('id: any\n');
  }, 20_000);

  it('opens a representation from the matrix by keyboard', async () => {
    const { user } = renderApp();
    await openTemplate(user);
    const link = screen.getByRole('link', { name: 'View response 200 (application/yaml)' });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Response 200 (application/yaml)' })).toBeDefined();
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('tolerates an older server that reports none of the new fields', async () => {
    const { user } = renderApp();
    await user.click(await within(await ready()).findByRole('link', { name: 'GET /v1/greeting, scenario default' }));
    const heading = await screen.findByRole('heading', { level: 2, name: /\/v1\/greeting/ });
    const detail = heading.closest('section') ?? document.body;
    expect(document.body.textContent).not.toContain('Accepted request bodies');
    expect(detail.textContent).not.toContain('Path parameters');
    const rows = within(within(detail).getByRole('table')).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'LocaleResponsetext/plain',
      'Any (neutral)200View response 2 B',
      'fr200View response 7 B',
    ]);
    await user.click(screen.getByRole('link', { name: 'View response 200 (fr)' }));
    await screen.findByRole('heading', { level: 2, name: 'Response 200 (fr)' });
    expect(document.body.textContent).not.toContain('Sent Content-Type');
    expect(GREETING.fixtures).toHaveLength(2);
  });

  it('shows list settings from the configuration', async () => {
    const fake = withVariations();
    fake.config = {
      ...DEFAULT_CONFIG,
      settings: [
        { key: 'negotiation.mediaTypePreference', value: ['application/yaml', 'application/json'], source: 'file' },
        { key: 'onUnknownMethod', value: 405, source: 'default' },
      ],
    };
    renderApp(fake, '#/config');
    const row = (await screen.findByRole('rowheader', { name: 'negotiation.mediaTypePreference' })).closest('tr');
    expect(row?.textContent).toContain('[application/yaml, application/json]');
  });
});
