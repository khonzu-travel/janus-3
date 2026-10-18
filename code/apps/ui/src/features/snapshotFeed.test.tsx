import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeAtlas, V1, V2 } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// Snapshot changes in the UI.

function renderApp(fake = new FakeAtlas()) {
  window.location.hash = '#/endpoints';
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

const banner = () => screen.getByRole('banner');
const header = () => within(banner()).getByRole('status');

async function connected(events: ReturnType<typeof fakeEventSources>) {
  await waitFor(() => {
    expect(events.sources).toHaveLength(1);
  });
  const source = events.latest();
  if (source === undefined) throw new Error('no source');
  return source;
}

const FAILED = {
  apiVersion: 'atlas.v1',
  outcome: 'failed',
  triggers: ['watch'],
  finishedAt: '2026-09-29T10:14:03Z',
  activeSnapshotVersion: V1,
  candidateSnapshotVersion: null,
  errors: [
    {
      code: 'invalid-json',
      scenario: 'default',
      endpoint: { method: 'GET', path: '/v1/products/{productId}' },
      file: '200_{application-json}.json',
      line: 3,
      column: 15,
      message: 'invalid JSON: unexpected "}"',
    },
  ],
  warnings: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('snapshot events', () => {
  it('opens the stream after health loads, at the Atlas events URL', async () => {
    const { events } = renderApp();
    const source = await connected(events);
    expect(source.url).toBe('http://janus.test/_janus/events');
  });

  it('does not open a stream when the server does not offer one', async () => {
    const fake = new FakeAtlas();
    fake.capabilities = { resolve: true, reload: true, watch: false, events: false };
    const { events } = renderApp(fake);
    await waitFor(() => {
      expect(header().textContent).toContain('Ready');
    });
    expect(events.sources).toEqual([]);
  });

  it('shows a banner with Refresh on a new snapshot, keeping the view until refreshed', async () => {
    const { fake, events, user } = renderApp();
    const source = await connected(events);
    act(() => {
      source.emit('state', { snapshotVersion: V1, lastReload: null });
    });
    expect(screen.queryByText('The fixtures changed.')).toBeNull();

    act(() => {
      source.emit('snapshot', { snapshotVersion: V2, previousVersion: V1 });
    });
    const notice = await screen.findByText('The fixtures changed.');
    // A polite live region, so it is announced without interrupting.
    const region = notice.closest('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(header().textContent).toContain('Snapshot changed');
    // The current view is still there, labelled stale.
    expect(within(screen.getByRole('navigation', { name: 'Endpoints' })).getAllByRole('link').length).toBeGreaterThan(
      0,
    );

    fake.version = V2;
    await user.click(screen.getByRole('button', { name: 'Refresh view' }));
    await waitFor(() => {
      expect(screen.queryByText('The fixtures changed.')).toBeNull();
    });
    await waitFor(() => {
      expect(header().textContent).toContain('Ready');
    });
    // The stream outlives the refresh.
    expect(events.sources).toHaveLength(1);
  });

  it('catches a change made between loading health and connecting, from the opening state', async () => {
    const { fake, events } = renderApp();
    const source = await connected(events);
    fake.version = V2;
    act(() => {
      source.emit('state', { snapshotVersion: V2, lastReload: null });
    });
    expect(await screen.findByText('The fixtures changed.')).toBeDefined();
  });

  it('reconciles a reconnect: the new state repairs what was missed while disconnected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { events } = renderApp();
    const source = await connected(events);
    act(() => {
      source.emit('state', { snapshotVersion: V1, lastReload: null });
    });
    act(() => {
      source.fail(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(events.sources).toHaveLength(2);
    expect(source.closed).toBe(true);
    act(() => {
      events.latest()?.emit('state', {
        snapshotVersion: V2,
        lastReload: { outcome: 'failed', errorCount: 2, finishedAt: '2026-09-29T10:14:03Z' },
      });
    });
    expect(await screen.findByText('The fixtures changed.')).toBeDefined();
    expect(within(banner()).getByRole('button', { name: 'Reload failed (2 errors)' })).toBeDefined();
  });

  it('leaves ordinary drops to the native retry', async () => {
    const { events } = renderApp();
    const source = await connected(events);
    act(() => {
      source.fail(false);
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(events.sources).toHaveLength(1);
  });

  it('shows "Reload failed" and lists each error with its endpoint, file, line and message', async () => {
    const fake = new FakeAtlas();
    fake.reloadResult = FAILED;
    const { events, user } = renderApp(fake);
    const source = await connected(events);
    act(() => {
      source.emit('reload-failed', { errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' });
    });
    const button = await within(banner()).findByRole('button', { name: 'Reload failed (1 error)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await user.click(button);
    const panel = await screen.findByRole('region', { name: 'Reload errors' });
    await within(panel).findByText('invalid JSON: unexpected "}"');
    expect(panel.textContent).toContain('GET /v1/products/{productId} — 200_{application-json}.json line 3, column 15');
    expect(panel.textContent).toContain('invalid-json');
    expect(fake.requests).toContain('/_janus/reload');
    // A later successful reload clears the status.
    act(() => {
      source.emit('snapshot', { snapshotVersion: V2, previousVersion: V1 });
    });
    await waitFor(() => {
      expect(within(banner()).queryByRole('button', { name: /Reload failed/ })).toBeNull();
    });
  });

  it('names the scenario of each reload error', async () => {
    const fake = new FakeAtlas();
    const [error] = FAILED.errors;
    fake.reloadResult = {
      ...FAILED,
      errors: [
        { ...error, scenario: 'checkout-error', endpoint: { method: 'GET', path: '/v1/cart' }, file: '200.json' },
      ],
    };
    const { events, user } = renderApp(fake);
    const source = await connected(events);
    act(() => {
      source.emit('reload-failed', { errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' });
    });
    await user.click(await within(banner()).findByRole('button', { name: 'Reload failed (1 error)' }));
    const panel = await screen.findByRole('region', { name: 'Reload errors' });
    await within(panel).findByText('invalid JSON: unexpected "}"');
    expect(panel.textContent).toContain('checkout-error: GET /v1/cart — 200.json line 3, column 15');
  });

  it('shows a failure health already reported, without any event', async () => {
    const fake = new FakeAtlas();
    fake.capabilities = { resolve: true, reload: true, watch: true, events: false };
    fake.lastReload = { outcome: 'failed', errorCount: 3, finishedAt: '2026-09-29T10:14:03Z' };
    renderApp(fake);
    expect(await within(banner()).findByRole('button', { name: 'Reload failed (3 errors)' })).toBeDefined();
  });

  it('renders a newer result that won the fetch race instead of mixing it with the old count', async () => {
    const fake = new FakeAtlas();
    fake.reloadResult = { ...FAILED, outcome: 'swapped', errors: [], finishedAt: '2026-09-29T10:15:00Z' };
    const { events, user } = renderApp(fake);
    const source = await connected(events);
    act(() => {
      source.emit('reload-failed', { errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' });
    });
    await user.click(await within(banner()).findByRole('button', { name: 'Reload failed (1 error)' }));
    const panel = await screen.findByRole('region', { name: 'Reload errors' });
    expect(await within(panel).findByText(/the earlier failure no longer applies/)).toBeDefined();
    expect(panel.textContent).not.toContain('invalid JSON');
  });

  it('clears a failure when a later reload changed nothing', async () => {
    const { events } = renderApp();
    const source = await connected(events);
    act(() => {
      source.emit('reload-failed', { errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' });
    });
    await within(banner()).findByRole('button', { name: 'Reload failed (1 error)' });
    act(() => {
      source.emit('state', {
        snapshotVersion: V1,
        lastReload: { outcome: 'unchanged', errorCount: 0, finishedAt: '2026-09-29T10:16:00Z' },
      });
    });
    await waitFor(() => {
      expect(within(banner()).queryByRole('button', { name: /Reload failed/ })).toBeNull();
    });
  });

  it('ignores duplicate notifications', async () => {
    const { events } = renderApp();
    const source = await connected(events);
    act(() => {
      source.emit('snapshot', { snapshotVersion: V2, previousVersion: V1 });
      source.emit('snapshot', { snapshotVersion: V2, previousVersion: V1 });
      source.emit('reload-failed', { errorCount: 1, finishedAt: 't' });
      source.emit('reload-failed', { errorCount: 1, finishedAt: 't' });
    });
    expect(await screen.findAllByText('The fixtures changed.')).toHaveLength(1);
    expect(within(banner()).getAllByRole('button', { name: /Reload failed/ })).toHaveLength(1);
  });
});
