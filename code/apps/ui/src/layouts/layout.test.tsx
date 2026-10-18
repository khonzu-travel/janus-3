import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeAtlas } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';
import themeScript from '../../public/theme.js?raw';
import { folderPathsTo } from './endpointTree.js';

// Layout, themes and focus.

/** A controllable `matchMedia`: the viewport width and the system colour scheme. */
function mediaQueries(width: number, prefersDark = false) {
  const listeners = new Set<() => void>();
  const state = { width, prefersDark };
  const matches = (query: string): boolean => {
    const min = /min-width: (\d+)px/.exec(query);
    if (min !== null) return state.width >= Number(min[1]);
    if (query.includes('prefers-color-scheme: dark')) return state.prefersDark;
    return false;
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return matches(query);
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })),
  );
  return {
    set(next: Partial<typeof state>) {
      Object.assign(state, next);
      for (const listener of [...listeners]) listener();
    },
  };
}

function renderApp(hash = '#/endpoints') {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  const fake = new FakeAtlas();
  render(
    <App
      client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })}
      eventSource={fakeEventSources().create}
    />,
  );
  return { fake, user: userEvent.setup() };
}

const ready = () => screen.findAllByRole('link', { name: /scenario default/ });

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('responsive layout', () => {
  it('shows the inventory beside the details from 1024 px', async () => {
    mediaQueries(1280);
    renderApp();
    await ready();
    const nav = screen.getByRole('navigation', { name: 'Endpoints' });
    expect(screen.getByRole('main').contains(nav)).toBe(false);
    expect(screen.queryByRole('button', { name: /^Endpoints/ })).toBeNull();
  });

  it('keeps the foldable endpoint list from 769 to 1023 px, with no count button on any view', async () => {
    mediaQueries(800);
    const { user } = renderApp();
    await ready();
    const nav = screen.getByRole('navigation', { name: 'Endpoints' });
    expect(screen.getByRole('main').contains(nav)).toBe(false);
    expect(screen.queryByRole('button', { name: /^Endpoints \(/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Fold the endpoint list' }));
    expect(screen.getByRole('button', { name: 'Show the endpoint list' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Show the endpoint list' }));
    expect(screen.getByRole('button', { name: 'Fold the endpoint list' })).toBeDefined();

    // Other views show no endpoint list and no back link.
    await user.click(within(screen.getByRole('navigation', { name: 'Views' })).getByRole('link', { name: 'Requests' }));
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Endpoints' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /^Endpoints \(/ })).toBeNull();
  });

  it('makes the inventory its own view up to 768 px, with a back link from details', async () => {
    mediaQueries(320);
    const { user } = renderApp('#/endpoints?q=prod');
    await ready();
    const main = screen.getByRole('main');
    const nav = within(main).getByRole('navigation', { name: 'Endpoints' });
    expect(within(nav).getByRole('searchbox').getAttribute('value')).toBe('prod');
    await user.click(within(nav).getByRole('link', { name: 'GET /v1/products, scenario default' }));
    await screen.findByRole('heading', { level: 2, name: /\/v1\/products/ });
    expect(screen.queryByRole('navigation', { name: 'Endpoints' })).toBeNull();

    // The back link keeps the filter.
    const back = screen.getByRole('link', { name: '← All endpoints' });
    expect(back.getAttribute('href')).toBe('#/endpoints?q=prod');
    await user.click(back);
    expect(await screen.findByRole('navigation', { name: 'Endpoints' })).toBeDefined();
  });

  it('follows the viewport as it changes', async () => {
    const media = mediaQueries(1280);
    renderApp();
    await ready();
    media.set({ width: 700 });
    // At 768 px and below the list is the Endpoints view itself, inside <main>.
    await waitFor(() => {
      expect(screen.getByRole('main').contains(screen.getByRole('navigation', { name: 'Endpoints' }))).toBe(true);
    });
  });
});

describe('panes', () => {
  const treeHandle = () => screen.getByRole('separator', { name: 'Resize endpoint tree' });

  beforeEach(() => {
    // jsdom has no pointer capture.
    Element.prototype.setPointerCapture = () => undefined;
  });

  it('resizes a pane by dragging its handle', async () => {
    mediaQueries(1280);
    renderApp();
    await ready();
    const handle = treeHandle();
    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
    fireEvent.pointerUp(handle, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
  });

  it('puts the inspector beside the details from 1280 px, and below them from 1024 px', async () => {
    const media = mediaQueries(1280);
    renderApp();
    await ready();
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(screen.getByRole('main').contains(details)).toBe(false);
    expect(within(details).getByText('Server')).toBeDefined();
    expect(screen.getAllByRole('separator').map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'Resize endpoint tree',
      'Resize details panel',
    ]);
    media.set({ width: 1100 });
    await waitFor(() => {
      expect(screen.getAllByRole('separator')).toHaveLength(1);
    });
    expect(screen.getByRole('complementary', { name: 'Details' })).toBeDefined();
  });

  it('puts each fold button in its pane’s first row: the search row and the first inspector section', async () => {
    const media = mediaQueries(1280);
    const { user } = renderApp('#/endpoints/ep_0000000000000001');
    await ready();
    // The endpoint header: Try it is an icon after the endpoint ID; the response count heads the matrix.
    const tryIt = await screen.findByRole('link', { name: /^Try it: simulate GET / });
    expect(tryIt.getAttribute('title')).toBe('Try it in Explore');
    expect(tryIt.closest('dd')?.textContent).toContain('ep_0000000000000001');
    expect(screen.getByRole('heading', { level: 3, name: /^Responses \d+$/ })).toBeDefined();
    const element = (node: Element | null | undefined): HTMLElement => {
      if (!(node instanceof HTMLElement)) throw new Error('missing element');
      return node;
    };
    const searchRow = element(
      within(screen.getByRole('navigation', { name: 'Endpoints' })).getByRole('searchbox').parentElement,
    );
    expect(within(searchRow).getByRole('button', { name: 'Fold the endpoint list' })).toBeDefined();
    const firstSection = () =>
      element(screen.getByRole('complementary', { name: 'Details' }).querySelector('details')?.parentElement);
    // Beside the summary, not inside it, so it never toggles the section.
    const fold = within(firstSection()).getByRole('button', { name: 'Fold the details' });
    expect(fold.closest('summary')).toBeNull();
    expect(fold.parentElement?.nextElementSibling).toBe(
      screen.getByRole('complementary', { name: 'Details' }).querySelector('details'),
    );
    // Below the details, too.
    media.set({ width: 1100 });
    await waitFor(() => {
      expect(screen.getAllByRole('separator')).toHaveLength(1);
    });
    await user.click(within(firstSection()).getByRole('button', { name: 'Fold the details' }));
    expect(screen.getByRole('button', { name: 'Show the details' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('gives Requests, and the Configuration dialog over it, the whole width, without the tree or the inspector', async () => {
    mediaQueries(1280);
    renderApp('#/config');
    await screen.findByRole('dialog', { name: 'Configuration' });
    expect(screen.queryByRole('navigation', { name: 'Endpoints' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize endpoint tree' })).toBeNull();
  });

  it('resizes a pane by keyboard within its limits, and resets it with Home', async () => {
    mediaQueries(1280);
    const { user } = renderApp();
    await ready();
    const handle = treeHandle();
    const nav = screen.getByRole('navigation', { name: 'Endpoints' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(handle.getAttribute('aria-valuemin')).toBe('160');
    expect(handle.getAttribute('aria-valuemax')).toBe('480');
    handle.focus();
    await user.keyboard('{ArrowRight}');
    expect(handle.getAttribute('aria-valuenow')).toBe('336');
    expect(nav.style.width).toBe('336px');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    for (let step = 0; step < 4; step += 1) await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(handle.getAttribute('aria-valuenow')).toBe('480');
    for (let step = 0; step < 8; step += 1) await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(handle.getAttribute('aria-valuenow')).toBe('160');
    await user.keyboard('{Home}');
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
  });

  it('moves the inspector handle the other way, since it sizes the pane on its right', async () => {
    mediaQueries(1280);
    const { user } = renderApp();
    await ready();
    const handle = screen.getByRole('separator', { name: 'Resize details panel' });
    handle.focus();
    await user.keyboard('{ArrowLeft}');
    expect(handle.getAttribute('aria-valuenow')).toBe('296');
  });

  it('remembers widths in this browser, and resets on double-click', async () => {
    mediaQueries(1280);
    const first = renderApp();
    await ready();
    treeHandle().focus();
    await first.user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(window.localStorage.getItem('janus-atlas-pane-tree')).toBe('384');
    cleanup();

    const { user } = renderApp();
    await ready();
    expect(treeHandle().getAttribute('aria-valuenow')).toBe('384');
    await user.dblClick(treeHandle());
    expect(treeHandle().getAttribute('aria-valuenow')).toBe('320');
    expect(window.localStorage.getItem('janus-atlas-pane-tree')).toBe('320');
  });

  it('ignores a stored width outside the limits', async () => {
    mediaQueries(1280);
    window.localStorage.setItem('janus-atlas-pane-tree', '9000');
    window.localStorage.setItem('janus-atlas-pane-inspector', 'wide');
    renderApp();
    await ready();
    expect(treeHandle().getAttribute('aria-valuenow')).toBe('480');
    expect(screen.getByRole('separator', { name: 'Resize details panel' }).getAttribute('aria-valuenow')).toBe('280');
  });
});

describe('themes', () => {
  it('follows the system by default and changes with it', async () => {
    const media = mediaQueries(1280, true);
    renderApp();
    await ready();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    media.set({ prefersDark: false });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  it('switches theme from the logo and stores the choice', async () => {
    const media = mediaQueries(1280, false);
    const { user } = renderApp();
    await ready();
    expect(window.localStorage.getItem('janus-atlas-theme')).toBeNull();
    // Until the first click the UI follows the system, and the logo names the other theme.
    media.set({ prefersDark: true });
    const logo = await screen.findByRole('button', { name: 'Switch to light theme' });
    await user.click(logo);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('janus-atlas-theme')).toBe('light');
    expect(logo.getAttribute('aria-label')).toBe('Switch to dark theme');
    // A stored choice no longer follows the system.
    media.set({ prefersDark: false });
    media.set({ prefersDark: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    logo.focus();
    await user.keyboard('{Enter}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('janus-atlas-theme')).toBe('dark');
  });

  it('applies the stored choice before the application starts (public/theme.js)', () => {
    const run = () => {
      document.documentElement.removeAttribute('data-theme');
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped bootstrap as the page would
      (new Function(themeScript) as () => void)();
      return document.documentElement.getAttribute('data-theme');
    };
    mediaQueries(1280, false);
    expect(run()).toBe('light');
    window.localStorage.setItem('janus-atlas-theme', 'dark');
    expect(run()).toBe('dark');
    mediaQueries(1280, true);
    window.localStorage.setItem('janus-atlas-theme', 'light');
    expect(run()).toBe('light');
    window.localStorage.removeItem('janus-atlas-theme');
    expect(run()).toBe('dark');
  });

  it('keeps the stored choice across a reload of the page', async () => {
    mediaQueries(1280, false);
    window.localStorage.setItem('janus-atlas-theme', 'dark');
    renderApp();
    await ready();
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeDefined();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('focus', () => {
  it('offers a skip link first that moves focus to the main heading without changing the route', async () => {
    mediaQueries(1280);
    const { user } = renderApp('#/requests');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Untitled-1' });
    const route = window.location.hash;
    (document.activeElement as HTMLElement | null)?.blur();
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(document.activeElement).toBe(skip);
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(heading);
    expect(window.location.hash).toBe(route);
  });

  it('moves focus to the new view heading after navigation', async () => {
    mediaQueries(1280);
    const { user } = renderApp();
    await ready();
    const nav = screen.getByRole('navigation', { name: 'Endpoints' });
    for (const folder of folderPathsTo('/v1/greeting')) {
      const toggle = within(nav).getByRole('button', { name: folder });
      if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
    }
    await user.click(within(nav).getByRole('link', { name: 'GET /v1/greeting, scenario default' }));
    const heading = await screen.findByRole('heading', { level: 2, name: /\/v1\/greeting/ });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    await user.click(screen.getByRole('link', { name: 'Requests' }));
    const request = await screen.findByRole('heading', { level: 2, name: 'Untitled-1' });
    await waitFor(() => {
      expect(document.activeElement).toBe(request);
    });
  });
});
