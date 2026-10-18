import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FakeAtlas } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { connectionContext, DEPLOYMENT_DOCS_URL } from '../components/states/connection.js';
import { decodeConfig } from '../config.js';

// Connection diagnostics.

const PAGE = window.location.href;
const SAME_ORIGIN = new URL('/', PAGE).href;

function renderApp(serverUrl: string, fake: FakeAtlas, hash = '#/endpoints') {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl }, PAGE);
  if (!config.ok) throw new Error(config.message);
  render(
    <App
      client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })}
      eventSource={fakeEventSources().create}
    />,
  );
  return { user: userEvent.setup() };
}

describe('connectionContext', () => {
  it('compares the Atlas origin with the page origin', () => {
    expect(connectionContext(new URL('http://page.test/mock/_janus/'), 'http://page.test/mock/_janus/ui/')).toEqual({
      pageOrigin: 'http://page.test',
      crossOrigin: false,
    });
    expect(connectionContext(new URL('http://127.0.0.1:4010/_janus/'), 'http://localhost:5173/')).toEqual({
      pageOrigin: 'http://localhost:5173',
      crossOrigin: true,
    });
  });
});

describe('the unavailable state', () => {
  it('says a cross-origin server may be down or may not list the page origin, with the origin and docs', async () => {
    const fake = new FakeAtlas('http://janus.test/_janus/');
    fake.down = true;
    renderApp('http://janus.test', fake);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("It may be down, or it may not list this page's origin in cors.origins.");
    expect(within(alert).getByText(window.location.origin).tagName).toBe('CODE');
    expect(within(alert).getByRole('link', { name: 'read how to deploy the Atlas UI' }).getAttribute('href')).toBe(
      DEPLOYMENT_DOCS_URL,
    );
    expect(alert.textContent).toContain('http://janus.test/_janus/');
    expect(within(alert).getByRole('button', { name: 'Retry connection' })).toBeDefined();
  });

  it('says a same-origin server is unreachable, without CORS advice', async () => {
    const fake = new FakeAtlas(`${SAME_ORIGIN}_janus/`);
    fake.down = true;
    renderApp(SAME_ORIGIN, fake);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The server is unreachable.');
    expect(alert.textContent).not.toContain('cors.origins');
    expect(within(alert).queryByRole('link')).toBeNull();
    expect(within(alert).getByRole('button', { name: 'Retry connection' })).toBeDefined();
  });
});

describe('a refused simulation', () => {
  async function explain(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    const form = await screen.findByRole('form', { name: 'Request to simulate' });
    await user.type(within(form).getByLabelText('Target (path and query)'), '/v1/products');
    await user.click(within(form).getByRole('button', { name: 'Explain' }));
    return screen.findByRole('alert');
  }

  it('shows the readable 403 atlas-origin-forbidden with the page origin and the fixes', async () => {
    const fake = new FakeAtlas(`${SAME_ORIGIN}_janus/`);
    fake.resolver = () =>
      new Response(
        JSON.stringify({ error: { code: 'atlas-origin-forbidden', message: 'forbidden', requestId: 'r-1' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    const { user } = renderApp(SAME_ORIGIN, fake, '#/explorer');
    const alert = await explain(user);
    expect(alert.textContent).toContain(
      `This page's origin (${window.location.origin}) is not allowed to change this server.`,
    );
    expect(alert.textContent).toContain("pass the client's Host header through");
    expect(alert.textContent).toContain('cors.origins');
    expect(alert.textContent).toContain('atlas-origin-forbidden');
  });

  it('diagnoses an unreadable cross-origin failure after a good start', async () => {
    const fake = new FakeAtlas('http://janus.test/_janus/');
    const { user } = renderApp('http://janus.test', fake, '#/explorer');
    await screen.findByRole('form', { name: 'Request to simulate' });
    fake.down = true;
    const alert = await explain(user);
    expect(alert.textContent).toContain(
      `The server may be down, or it may no longer list this page's origin (${window.location.origin}) in cors.origins.`,
    );
  });
});
