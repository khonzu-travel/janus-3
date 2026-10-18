import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultExplanation, FakeAtlas, jsonResponse, V1 } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeEvent } from '../atlas/events.js';
import { decodeRequestDocument, decodeRequestTree, type RequestDocument } from '../atlas/runner.js';
import { decodeConfig } from '../config.js';
import { entryOf, rowOf, summaryOf } from './requests/ExtractTable.js';
import { OPEN_TABS_KEY, resetTabState } from './requests/tabState.js';
import {
  nextOrdered,
  pathParamNames,
  resolve,
  slug,
  templateParts,
  variableNameFor,
  type Scopes,
} from './requests/variables.js';

// The Requests page.

type Doc = Record<string, unknown>;

const RUNNER = { available: true, collections: 1 };

const CREATE: RequestDocument = {
  name: 'Create cart',
  method: 'POST',
  url: '{{baseUrl}}/v1/carts',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: { type: 'json', text: '{}' },
};
const ADD: RequestDocument = { name: 'Add item', method: 'POST', url: '{{baseUrl}}/v1/carts/:cartId/items' };

const preview = (value: string) => ({
  state: 'available',
  encoding: 'utf8',
  value,
  byteLength: value.length,
  truncated: false,
});

/** A server with one collection, `checkout`, that keeps its request files in memory. */
class RunnerServer {
  readonly files = new Map<string, { digest: string; document: RequestDocument }>([
    ['checkout/010-create-cart', { digest: 'sha256:1', document: CREATE }],
    ['checkout/020-add-item', { digest: 'sha256:2', document: ADD }],
  ]);
  holdStarts = false;
  releaseStarts: (() => void)[] = [];
  reads: string[] = [];
  readonly runs: Doc[] = [];
  runSteps: Doc[] | null = null;
  readonly writes: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  revision = 10;
  /** Environments the tree lists after staging; each answers GET and PUT with a fixed body. */
  moreEnvironments: Doc[] = [];
  environment: Doc = {
    digest: 'sha256:env',
    document: { name: 'Staging', vars: { baseUrl: 'https://staging.example.com', token: 't0ken' } },
    local: null,
  };

  tree(): Doc {
    return {
      apiVersion: 'atlas.v1',
      version: 'v1',
      collections: [
        {
          kind: 'collection',
          id: 'checkout',
          name: 'Checkout',
          children: [...this.files].map(([id, file]) => ({
            kind: 'request',
            id,
            name: file.document.name,
            method: file.document.method,
          })),
        },
      ],
      environments: [
        {
          id: 'staging',
          name: 'Staging',
          ...((this.environment['document'] as Doc)['default'] === true ? { default: true } : {}),
        },
        ...this.moreEnvironments,
      ],
      problems: [],
    };
  }

  handle(method: string, path: string, headers: Record<string, string>, body: unknown): Response | null {
    if (path === 'requests' && method === 'GET') return jsonResponse(200, this.tree());
    const request = /^requests\/(.+)$/.exec(path)?.[1];
    if (request !== undefined) {
      const id = decodeURIComponent(request);
      const file = this.files.get(id);
      if (method === 'GET') {
        if (file === undefined)
          return jsonResponse(404, { error: { code: 'atlas-resource-not-found', message: 'No', requestId: null } });
        return jsonResponse(200, {
          apiVersion: 'atlas.v1',
          id,
          digest: file.digest,
          document: file.document,
          folders: [{ id: 'checkout', kind: 'collection', name: 'Checkout', document: { vars: { region: 'eu' } } }],
          environments: [{ id: 'staging', name: 'Staging', vars: { baseUrl: 'https://staging.example.com' } }],
        });
      }
      this.writes.push({ method, path, headers, body });
      if (method === 'PUT') {
        if (file !== undefined && headers['if-match'] !== file.digest) {
          return jsonResponse(412, {
            error: {
              code: 'request-changed',
              message: 'The request file changed since it was read',
              requestId: null,
              current: { digest: file.digest, document: file.document },
            },
          });
        }
        const digest = `sha256:${String(this.revision++)}`;
        this.files.set(id, { digest, document: body as RequestDocument });
        return jsonResponse(file === undefined ? 201 : 200, { apiVersion: 'atlas.v1', id, digest });
      }
    }
    if (path === 'folders/checkout' && method === 'GET') {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        id: 'checkout',
        kind: 'collection',
        digest: null,
        document: {},
      });
    }
    if (path === 'environments/staging' && method === 'GET') {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        id: 'staging',
        ...this.environment,
      });
    }
    if (path === 'environments/staging' && method === 'PUT') {
      if (headers['if-match'] !== this.environment['digest'])
        return jsonResponse(412, {
          error: {
            code: 'request-changed',
            message: 'Environment changed',
            requestId: null,
            current: this.environment,
          },
        });

      this.writes.push({ method, path, headers, body });
      this.environment = { ...(body as Doc), digest: 'sha256:env2' };
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        id: 'staging',
        digest: 'sha256:env2',
      });
    }
    const more = this.moreEnvironments.find((entry) => path === `environments/${String(entry['id'])}`);
    if (more !== undefined && method === 'GET') {
      const { id, ...document } = more;
      return jsonResponse(200, { apiVersion: 'atlas.v1', id, digest: 'sha256:more', document, local: null });
    }
    if (more !== undefined && method === 'PUT') {
      this.writes.push({ method, path, headers, body });
      const { document } = body as { document: Doc };
      this.moreEnvironments = this.moreEnvironments.map((entry) =>
        entry === more ? { ...document, id: more['id'] } : entry,
      );
      return jsonResponse(200, { apiVersion: 'atlas.v1', id: more['id'], digest: 'sha256:more2' });
    }
    const created = /^environments\/([^/]+)$/.exec(path)?.[1];
    if (created !== undefined && method === 'PUT') {
      // A new environment: listed after the others.
      this.writes.push({ method, path, headers, body });
      const { document } = body as { document: Doc };
      this.moreEnvironments = [...this.moreEnvironments, { ...document, id: created }];
      return jsonResponse(201, { apiVersion: 'atlas.v1', id: created, digest: 'sha256:new' });
    }
    if (path === 'runs' && method === 'POST') {
      this.writes.push({ method, path, headers, body });
      const id = `r-${String(this.runs.length + 1).padStart(6, '0')}`;
      const { target, mode } = body as { target: { id: string }; mode: string };
      const name = this.files.get(target.id)?.document.name ?? target.id;
      this.runs.push({
        id,
        target: {
          kind: target.id === 'checkout' ? 'collection' : 'request',
          id: target.id,
          unsaved: target.id !== 'checkout',
        },
        environment: 'staging',
        mode,
        scenario: 'default',
        startedAt: '2026-10-10T10:00:00.000Z',
        finishedAt: '2026-10-10T10:00:00.050Z',
        state: 'finished',
        outcome: 'passed',
        stepCount: 1,
        passed: 1,
        failed: 0,
        vars: { cartId: 'c-91' },
        steps: [
          {
            step: 1,
            requestId: target.id,
            name,
            outcome: 'passed',
            request: { method: 'POST', url: 'https://staging.example.com/v1/carts', headers: [], body: preview('{}') },
            response: {
              status: 201,
              headers: [
                { name: 'content-type', value: 'application/json' },
                { name: 'etag', value: '"v1"' },
              ],
              body: preview('{"id":"c-91","total":{"amount":5}}'),
              timeMs: 12,
            },
            tests: [{ name: 'created', passed: true }],
            console: [{ level: 'log', text: 'hello' }],
            variables: { cartId: 'c-91' },
            janusRequestId: 'req-1',
          },
        ],
        ...(this.runSteps === null
          ? {}
          : { steps: this.runSteps, stepCount: this.runSteps.length, passed: this.runSteps.length }),
      });
      return jsonResponse(202, { apiVersion: 'atlas.v1', id });
    }
    const run = /^runs\/(r-\d+)$/.exec(path)?.[1];
    if (run !== undefined && method === 'GET') {
      const found = this.runs.find((entry) => entry['id'] === run);
      return found === undefined ? null : jsonResponse(200, { apiVersion: 'atlas.v1', ...found });
    }
    if (path === 'runs' && method === 'GET') return jsonResponse(200, { apiVersion: 'atlas.v1', runs: this.runs });
    return null;
  }
}

function renderApp(hash: string, runner: Doc = RUNNER) {
  window.location.hash = hash;
  const fake = new FakeAtlas();
  fake.capabilities = { resolve: true, reload: true, watch: false, events: true, runner };
  const server = new RunnerServer();
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^\/_janus\//, '');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if ((init?.method ?? 'GET') === 'GET') server.reads.push(path);
    const answer = server.handle(init?.method ?? 'GET', path, headers, body);
    if (path === 'runs' && init?.method === 'POST' && server.holdStarts && answer !== null) {
      return new Promise<Response>((resolve) => {
        server.releaseStarts.push(() => {
          resolve(answer);
        });
      });
    }
    return answer === null ? fake.fetch(input, init) : Promise.resolve(answer);
  };
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  const events = fakeEventSources();
  render(<App client={createAtlasClient(config.config, { fetch, timeoutMs: 2000 })} eventSource={events.create} />);
  return { server, events, user: userEvent.setup() };
}

afterEach(() => {
  resetTabState();
});

/** The editor tab in front; the others stay mounted but hidden. */
function front() {
  const runner = screen.getByRole('region', { name: 'Request runner' });
  const shown = [...runner.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset['editor'] !== undefined && !child.hidden,
  );
  if (shown === undefined) throw new Error('No editor tab is in front');
  return within(shown);
}
const hotbar = () => within(screen.getByRole('toolbar', { name: 'Panel actions' }));

describe('Requests page', () => {
  it('is always in the header, and without the runner explains why and keeps only Explore', async () => {
    renderApp('');
    expect(await screen.findByRole('link', { name: 'Requests' })).toBeDefined();
    // The runner also shows the Captures tab, where its captures are reviewed.
    expect(screen.getByRole('link', { name: 'Captures' })).toBeDefined();

    cleanup();
    resetTabState();
    renderApp('#/requests', { available: false, reason: 'non-loopback', collections: 0 });
    expect(await screen.findByText(/Saved requests need the request runner/)).toBeDefined();
    expect(screen.getByText(/runner.allowNonLoopback/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Requests' })).toBeDefined();
    // The unsaved request still simulates; Live needs the runner.
    expect(await screen.findByRole('heading', { name: 'Untitled-1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Explore' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Live' })).toHaveProperty('disabled', true);
  });

  it('lists the tree, filters it, and opens a request in the editor', async () => {
    const { user } = renderApp('#/requests');
    const tree = await screen.findByRole('navigation', { name: 'Requests' });
    expect(within(tree).getByRole('link', { name: /Create cart/ })).toBeDefined();
    await user.type(within(tree).getByLabelText('Filter requests'), 'add');
    expect(within(tree).queryByRole('link', { name: /Create cart/ })).toBeNull();
    await user.click(within(tree).getByRole('link', { name: /Add item/ }));
    await waitFor(() => {
      expect(front().getByLabelText('URL')).toHaveProperty('value', '{{baseUrl}}/v1/carts/:cartId/items');
    });
    // It takes the place of the untitled tab the page opened with, which was left untouched.
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    expect(within(tabs).queryByRole('link', { name: /Untitled-1/ })).toBeNull();
    expect(
      within(tabs)
        .getByRole('link', { name: /Add item/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    // Path parameters come from the URL's :name segments.
    expect(front().getByRole('table', { name: 'Path parameters' })).toBeDefined();
    expect(front().getByText('cartId', { selector: 'code' })).toBeDefined();
  });

  it('keeps a changed untitled tab, and reopens the open requests at startup', async () => {
    const { user } = renderApp('#/requests');
    const tree = await screen.findByRole('navigation', { name: 'Requests' });
    await user.type(await screen.findByLabelText('URL'), '/v1/ping');
    await user.click(within(tree).getByRole('link', { name: /Add item/ }));
    await user.click(within(tree).getByRole('link', { name: /Create cart/ }));
    await user.click(within(tree).getByRole('link', { name: /Add item/ }));
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    expect(within(tabs).getByRole('link', { name: /Untitled-1/ })).toBeDefined();
    const stored = window.localStorage.getItem(OPEN_TABS_KEY);
    expect(JSON.parse(stored ?? 'null')).toEqual({
      tabs: [
        { kind: 'node', id: 'checkout/020-add-item' },
        { kind: 'node', id: 'checkout/010-create-cart' },
      ],
      front: 'n:checkout/020-add-item',
    });

    // A new start: the saved requests come back, Add item in front; the untitled one does not.
    cleanup();
    resetTabState();
    window.localStorage.setItem(OPEN_TABS_KEY, stored ?? '');
    renderApp('#/requests');
    await waitFor(() => {
      expect(front().getByLabelText('URL')).toHaveProperty('value', '{{baseUrl}}/v1/carts/:cartId/items');
    });
    const reopened = screen.getByRole('navigation', { name: 'Open editors' });
    expect(
      within(reopened)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([expect.stringContaining('Add item'), expect.stringContaining('Create cart')]);
  });

  it('marks unsaved changes, highlights variables with their scope, and saves with the digest it read', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    const url = await screen.findByLabelText('URL');
    const used = screen.getAllByRole('list', { name: 'Variables used' })[0];
    expect(within(used as HTMLElement).getAllByText(/environment Staging/)[0]).toBeDefined();
    await user.clear(url);
    await user.type(url, '{{{{missing}}/v1/carts');
    expect(screen.getByTitle('Unsaved changes')).toBeDefined();
    expect(screen.getAllByText(/undefined in every scope/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const write = server.writes.find((entry) => entry.method === 'PUT');
    expect(write?.headers['if-match']).toBe('sha256:1');
    expect((write?.body as RequestDocument).url).toBe('{{missing}}/v1/carts');
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
  });

  it('shows the last tab again when the Requests link is followed from Requests', async () => {
    const { user } = renderApp('#/requests');
    const tabs = await screen.findByRole('navigation', { name: 'Open editors' });
    await waitFor(() => {
      expect(
        within(tabs)
          .getByRole('link', { name: /Untitled-1/ })
          .getAttribute('aria-current'),
      ).toBe('page');
    });
    await user.click(within(screen.getByRole('navigation', { name: 'Views' })).getByRole('link', { name: 'Requests' }));
    await waitFor(() => {
      expect(window.location.hash).toContain('tab=untitled-1');
    });
    expect(screen.queryByRole('progressbar', { name: 'Opening' })).toBeNull();
    expect(front().getByLabelText('URL')).toBeDefined();
    // A blank untitled request lets the page close without asking; one with a URL asks.
    const unload = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await user.type(front().getByLabelText('URL'), 'https://example.test/');
    expect(unload()).toBe(true);
  });

  it('turns No body into JSON when the method becomes POST, and lists JSON and GraphQL first', async () => {
    const { user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.click(hotbar().getByRole('button', { name: 'New request' }));
    await waitFor(() => {
      expect(front().getByLabelText('URL')).toHaveProperty('value', '');
    });
    await user.click(front().getByRole('tab', { name: /Body/ }));
    const type = front().getByLabelText<HTMLSelectElement>('Body type');
    expect(type.value).toBe('none');
    expect([...type.options].map((option) => option.textContent)).toEqual([
      'No body',
      'JSON',
      'GraphQL',
      'Text',
      'XML',
      'Form (URL-encoded)',
      'Multipart form',
      'File',
    ]);
    await user.selectOptions(front().getByLabelText('Method'), 'POST');
    expect(front().getByLabelText<HTMLSelectElement>('Body type').value).toBe('json');
    // A body already chosen stays as it is.
    await user.selectOptions(front().getByLabelText('Body type'), 'xml');
    await user.selectOptions(front().getByLabelText('Method'), 'PUT');
    await user.selectOptions(front().getByLabelText('Method'), 'POST');
    expect(front().getByLabelText<HTMLSelectElement>('Body type').value).toBe('xml');
  });

  it('opens New request as a blank Untitled tab with the previous tab’s headers, and saves it to a collection', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.click(hotbar().getByRole('button', { name: 'New request' }));
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    await waitFor(() => {
      expect(
        within(tabs)
          .getByRole('link', { name: /Untitled-1/ })
          .getAttribute('aria-current'),
      ).toBe('page');
    });
    expect(front().getByLabelText('URL')).toHaveProperty('value', '');
    expect(within(tabs).getByRole('link', { name: /Untitled-1, unsaved changes/ })).toBeDefined();
    await user.click(front().getByRole('tab', { name: /Headers/ }));
    expect(front().getByLabelText<HTMLInputElement>('Headers name 1').value).toBe('Content-Type');
    await user.type(front().getByLabelText('URL'), '{{{{baseUrl}}/v1/carts/1');

    await user.click(front().getByRole('button', { name: 'Save to collection' }));
    const dialog = screen.getByRole('dialog', { name: 'Save to collection' });
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveProperty('value', 'Untitled-1');
    await user.clear(name);
    await user.type(name, 'Get cart');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Save to').value).toBe('checkout');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const write = server.writes.find((entry) => entry.method === 'PUT');
    expect(write?.path).toBe('requests/checkout/030-get-cart');
    expect(write?.headers['if-none-match']).toBe('*');
    expect(write?.body).toEqual({
      name: 'Get cart',
      method: 'GET',
      url: '{{baseUrl}}/v1/carts/1',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
    });
    // The saved request takes the untitled tab's place.
    await waitFor(() => {
      expect(within(tabs).queryByRole('link', { name: /Untitled-1/ })).toBeNull();
    });
  });

  it('closes a collection or environment tab for good, and opens it again when picked', async () => {
    const { user } = renderApp('#/requests?id=checkout');
    const tabs = await screen.findByRole('navigation', { name: 'Open editors' });
    await within(tabs).findByRole('link', { name: /Checkout/ });
    await user.click(screen.getByRole('button', { name: 'Environments' }));
    const list = screen.getByRole('navigation', { name: 'Environments' });
    await user.click(within(list).getByRole('button', { name: /^Staging/ }));
    await within(tabs).findByRole('link', { name: /Staging/ });

    await user.click(within(tabs).getByRole('button', { name: 'Close Staging' }));
    await waitFor(() => {
      expect(
        within(tabs)
          .getByRole('link', { name: /Checkout/ })
          .getAttribute('aria-current'),
      ).toBe('page');
    });
    expect(within(tabs).queryByRole('link', { name: /Staging/ })).toBeNull();
    await user.click(within(tabs).getByRole('button', { name: 'Close Checkout' }));
    await waitFor(() => {
      expect(within(tabs).queryByRole('link', { name: /Checkout/ })).toBeNull();
    });

    await user.click(within(list).getByRole('button', { name: /^Staging/ }));
    expect(await within(tabs).findByRole('link', { name: /Staging/ })).toBeDefined();
  });

  it('folds the side panel with Ctrl + [ and the inspector with Ctrl + ], even from a field', async () => {
    const { user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    const url = await screen.findByLabelText('URL');
    await user.click(url);
    await user.keyboard('{Control>}]{/Control}');
    expect(screen.getByRole('button', { name: 'Show the inspector' })).toBeDefined();
    expect(screen.queryByText(/to see the response and why/)).toBeNull();
    await user.keyboard('{Control>}[[{/Control}');
    expect(screen.getByRole('button', { name: 'Show the side panel' })).toBeDefined();
    // A bracket on its own is typed.
    await user.keyboard('[[');
    expect((url as HTMLInputElement).value.endsWith('[')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Show the inspector' }));
    expect(screen.getByRole('button', { name: 'Fold the inspector' })).toBeDefined();
  });

  it('saves an explored link to a collection', async () => {
    const { server, user } = renderApp('#/requests?mode=explore&m=POST&t=%2Fv1%2Fcarts&h=X-Trace%3A+1');
    const editor = await screen.findByRole('form', { name: 'Request to simulate' });
    await user.click(within(editor).getByRole('button', { name: 'Save to collection' }));
    const dialog = screen.getByRole('dialog', { name: 'Save to collection' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Make cart');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const puts = server.writes.filter((entry) => entry.method === 'PUT');
    expect(puts[0]?.body).toEqual({
      name: 'Make cart',
      method: 'POST',
      url: '{{baseUrl}}/v1/carts',
      headers: [{ name: 'X-Trace', value: '1' }],
    });
  });

  it('shows the file beside the edit when a save conflicts, and keeps either', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    // Someone else saves the file.
    server.files.set('checkout/010-create-cart', { digest: 'sha256:9', document: { ...CREATE, name: 'Make a cart' } });
    // The request is renamed on its tab: a double-click edits the name, Enter keeps it.
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    await user.dblClick(within(tabs).getByRole('link', { name: /Create cart/ }));
    const name = within(tabs).getByRole('textbox', { name: 'Request name' });
    await user.clear(name);
    await user.type(name, 'New cart{Enter}');
    expect(within(tabs).getByRole('link', { name: /New cart/ })).toBeDefined();
    expect(screen.getByTitle('Unsaved changes')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const conflict = await screen.findByRole('region', { name: 'The file changed since you opened it' });
    expect(within(conflict).getByText(/"name": "Make a cart"/)).toBeDefined();
    await user.click(within(conflict).getByRole('button', { name: 'Keep my edit' }));
    await screen.findByText('Saved.');
    expect(server.writes.at(-1)?.headers['if-match']).toBe('sha256:9');
    expect(server.files.get('checkout/010-create-cart')?.document.name).toBe('New cart');
  });

  it('renames a request from its tab menu, and Escape keeps the old name', async () => {
    const { user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    expect(screen.queryByLabelText('Name')).toBeNull();
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    const tab = within(tabs).getByRole('link', { name: /Create cart/ });
    await user.pointer({ keys: '[MouseRight]', target: tab });
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    await user.type(within(tabs).getByRole('textbox', { name: 'Request name' }), ' 2{Escape}');
    expect(within(tabs).getByRole('link', { name: /Create cart/ })).toBeDefined();
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
    // F2 on the tab renames too.
    within(tabs)
      .getByRole('link', { name: /Create cart/ })
      .focus();
    await user.keyboard('{F2}');
    await user.type(
      within(tabs).getByRole('textbox', { name: 'Request name' }),
      '{Control>}a{/Control}Make cart{Enter}',
    );
    expect(within(tabs).getByRole('link', { name: /Make cart/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Make cart/ })).toBeDefined();
  });

  it('refuses an X-Mock-Scenario header, picking its value in the scenario list instead', async () => {
    const { user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.click(screen.getByRole('tab', { name: /Headers/ }));
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    await user.type(screen.getByLabelText('Headers name 2'), 'x-mock-scenario');
    await user.type(screen.getByLabelText('Headers value 2'), 'sold-out');
    const name = screen.getByLabelText('Headers name 2');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'The scenario is not set with a header here. Pick “sold-out” in the scenario list',
    );
    const send = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Send x-mock-scenario' });
    expect(send.checked).toBe(false);
    expect(send.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Pick “sold-out” in the scenario list' }));
    await waitFor(() => {
      expect(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('scenario')).toBe('sold-out');
    });
    expect(screen.queryByLabelText('Headers name 2')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Headers name 1').value).toBe('Content-Type');
  });

  it('clears every header, and every variable, at once', async () => {
    const { user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.click(screen.getByRole('tab', { name: /Headers/ }));
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    expect(screen.getAllByLabelText(/^Headers name/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Clear all headers' }));
    expect(screen.queryByRole('table', { name: 'Headers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all headers' })).toBeNull();
    expect(screen.getByTitle('Unsaved changes')).toBeDefined();

    await user.click(screen.getByRole('tab', { name: /Variables/ }));
    expect(screen.queryByRole('button', { name: 'Clear all variables' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByLabelText('Request variables name 1'), 'a');
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByLabelText('Request variables name 2'), 'b');
    await user.click(screen.getByRole('button', { name: 'Clear all variables' }));
    expect(screen.queryByRole('table', { name: 'Request variables' })).toBeNull();
  });

  it('sends without saving, shows the response, saves a value as a variable, and carries run variables', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    // A new browser tab opens in Live, sending to Upstream.
    expect(screen.getByRole('button', { name: 'Live' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText<HTMLSelectElement>('Send to').value).toBe('upstream');
    await user.selectOptions(screen.getByLabelText('Send to'), 'mock');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const result = await screen.findByRole('region', { name: 'Result of Create cart' });
    expect(within(result).getByText('Passed')).toBeDefined();
    expect(within(result).getByText('201')).toBeDefined();
    const sent = server.writes.find((entry) => entry.path === 'runs')?.body as Doc;
    expect((sent['target'] as Doc)['request']).toEqual(CREATE);
    expect(sent['vars']).toEqual({});
    expect(server.writes.some((entry) => entry.method === 'PUT')).toBe(false);

    // Tests, console and variables each have a tab.
    await user.click(within(result).getByRole('tab', { name: /Tests/ }));
    expect(within(result).getByText('created')).toBeDefined();
    await user.click(within(result).getByRole('tab', { name: /Console/ }));
    expect(within(result).getByText('hello')).toBeDefined();
    // The inspector beside it says why; this mock reported no decisions.
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('Why this response')).toBeDefined();
    expect(within(inspector).getByText('Mock')).toBeDefined();
    expect(within(inspector).getByText('Janus reported no decisions for this response.')).toBeDefined();

    // Save as variable on a header, then on a JSON value.
    await user.click(within(result).getByRole('tab', { name: /Headers/ }));
    await user.click(within(result).getByRole('button', { name: 'Save etag as variable' }));
    await user.click(within(result).getByRole('tab', { name: /Body/ }));
    // The JSON body is a tree: collapse and expand an object, and switch to the raw text and back.
    const tree = within(result).getByRole('list', { name: 'Response body (JSON tree)' });
    const total = within(tree).getByRole('button', { name: 'Collapse $.total' });
    expect(total.getAttribute('aria-expanded')).toBe('true');
    await user.click(total);
    expect(within(tree).getByText('1 key')).toBeDefined();
    expect(within(tree).queryByRole('button', { name: 'Save $.total.amount as variable' })).toBeNull();
    await user.click(within(tree).getByRole('button', { name: 'Expand $.total' }));
    await user.click(within(result).getByRole('button', { name: 'Text' }));
    expect(within(result).getByLabelText('Body preview (text)').textContent).toBe('{"id":"c-91","total":{"amount":5}}');
    await user.click(within(result).getByRole('button', { name: 'Tree' }));
    await user.click(within(result).getByRole('button', { name: 'Save $.total.amount as variable' }));
    await user.click(screen.getByRole('tab', { name: /Extract/ }));
    // Rows start collapsed, each a summary with its own Remove; Expand all opens every one.
    const extracts = screen.getByRole('list', { name: 'Extract' });
    expect(within(extracts).getByRole('button', { name: /amount body \$\.total\.amount/ })).toHaveProperty(
      'ariaExpanded',
      'false',
    );
    expect(within(extracts).getByRole('button', { name: 'Remove etag' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Expand all extracts' }));
    expect(screen.getByLabelText('Variable name, etag')).toBeDefined();
    expect(screen.getByLabelText('Path or name, amount')).toHaveProperty('value', '$.total.amount');
    await user.click(screen.getByRole('button', { name: 'Collapse all extracts' }));
    expect(within(extracts).getByRole('button', { name: /^etag / })).toHaveProperty('ariaExpanded', 'false');
    // A row added with + opens at once.
    await user.click(screen.getByRole('button', { name: 'Add extract' }));
    expect(screen.getByLabelText('Variable name, row 3')).toBeDefined();

    // The variables the send ended with go with the next send; Reset clears them.
    expect(screen.getByRole('button', { name: 'Variables, 1 carried' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(server.writes.filter((entry) => entry.path === 'runs')).toHaveLength(2);
    });
    expect((server.writes.filter((entry) => entry.path === 'runs')[1]?.body as Doc)['vars']).toEqual({
      cartId: 'c-91',
    });
    // The popup edits a value in place; Reset clears them.
    await user.click(screen.getByRole('button', { name: 'Variables, 1 carried' }));
    const popup = await screen.findByRole('region', { name: 'Run variables' });
    expect(within(popup).getByLabelText('cartId')).toHaveProperty('value', 'c-91');
    await user.click(within(popup).getByRole('button', { name: 'Reset variables' }));
    expect(screen.queryByRole('button', { name: /^Variables,/ })).toBeNull();
  });

  it('sends upstream with the backend noted, and explains in Explore', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.selectOptions(screen.getByLabelText('Send to'), 'upstream');
    expect(screen.getByText(/Sends to/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('region', { name: 'Result of Create cart' });
    const runs = () => server.writes.filter((entry) => entry.path === 'runs').map((entry) => entry.body as Doc);
    expect(runs()[0]?.['mode']).toBe('upstream');
    // With the top bar on the configured default, no scenario is sent: Janus decides.
    expect(runs()[0]).not.toHaveProperty('scenario');
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('Backend')).toBeDefined();
    const decisions = within(inspector).getByRole('list', { name: 'Decisions' });
    expect(within(decisions).getByText('Proxied')).toBeDefined();
    expect(within(decisions).getByText('JSON')).toBeDefined();
    expect(within(decisions).getByText('Verbatim')).toBeDefined();

    // The response can move into the right pane, sharing it with the explanation as two tabs.
    const move = within(inspector).getByRole('button', { name: 'Show the response in this pane' });
    await user.click(move);
    expect(move.getAttribute('aria-pressed')).toBe('true');
    const result = within(inspector).getByRole('tablist', { name: 'Response and explanation' });
    expect(within(inspector).getByRole('region', { name: 'Result of Create cart' })).toBeDefined();
    await user.click(within(result).getByRole('tab', { name: 'Explanation' }));
    expect(within(inspector).getByRole('list', { name: 'Decisions' })).toBeDefined();
    expect(within(inspector).queryByRole('region', { name: 'Result of Create cart' })).toBeNull();
    await user.click(move);
    expect(within(inspector).queryByRole('tablist', { name: 'Response and explanation' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Result of Create cart' })).toBeDefined();

    // Record still says where the request goes, and no longer names a scenario.
    await user.selectOptions(screen.getByLabelText('Send to'), 'record');
    expect(screen.getByText(/Sends to/)).toBeDefined();
    expect(screen.queryByText(/Records into/)).toBeNull();

    // Explore explains instead, at the bar's instant; there is no Send to.
    await user.click(screen.getByRole('button', { name: 'Explore' }));
    expect(screen.queryByLabelText('Send to')).toBeNull();
    await user.type(screen.getByLabelText('Render at'), '2026-01-01T00:00:00Z');
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    await waitFor(() => {
      expect(runs()).toHaveLength(2);
    });
    expect(runs()[1]?.['mode']).toBe('explain');
    expect(runs()[1]?.['now']).toBe('2026-01-01T00:00:00Z');
    expect(await within(inspector).findByText('Simulated')).toBeDefined();
  });

  it('shows a run with its steps, from the run view', async () => {
    const { server, events, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(await screen.findByRole('link', { name: 'Open run r-000001' }));
    const run = await screen.findByRole('region', { name: 'Run r-000001' }, { timeout: 5000 });
    expect(within(run).getByText('1 passed, 0 failed of 1')).toBeDefined();
    expect(within(within(run).getByRole('list', { name: 'Steps' })).getByText('Create cart')).toBeDefined();
    expect(server.runs).toHaveLength(1);
    await act(async () => {
      events.latest()?.emit('run', { id: 'r-000001', state: 'finished', outcome: 'passed' });
      await Promise.resolve();
    });
    await user.click(within(run).getByRole('link', { name: 'All runs' }));
    expect(await screen.findByRole('table', { name: /Runs, newest first/ })).toBeDefined();
  });

  it.each([
    { mode: 'mock', label: 'Mock' },
    { mode: 'upstream', label: 'Upstream' },
    { mode: 'record', label: 'Record' },
    { mode: 'explain', label: 'Explore' },
  ])('labels $mode runs in the detail and list', async ({ mode, label }) => {
    const { user } = renderApp(
      `#/requests?id=checkout%2F010-create-cart&mode=${mode === 'explain' ? 'explore' : 'live'}`,
    );
    await screen.findByLabelText('URL');
    if (mode !== 'explain') await user.selectOptions(screen.getByLabelText('Send to'), mode);
    await user.click(screen.getByRole('button', { name: mode === 'explain' ? 'Explain' : 'Send' }));
    // Explore omits the Run section in the editor, but its run is still in the list.
    await screen.findByRole('region', { name: 'Result of Create cart' });
    await user.click(hotbar().getByRole('button', { name: 'Runs' }));
    const table = await screen.findByRole('table', { name: /Runs, newest first/ });
    expect(within(table).getByRole('cell', { name: label })).toBeDefined();
    await user.click(within(table).getByRole('link', { name: 'r-000001' }));
    const run = await screen.findByRole('region', { name: 'Run r-000001' });
    expect(run.textContent).toContain(` · ${label} · `);
  });

  it('shows each collection step’s explanation in the run inspector', async () => {
    const { server, user } = renderApp('#/requests?id=checkout&mode=explore');
    const targets = ['/v1/products', '/v1/nowhere'];
    server.runSteps = [...server.files].map(([requestId, file], index) => {
      const explanation = defaultExplanation(V1, { method: 'GET', target: targets[index] });
      return {
        step: index + 1,
        requestId,
        name: file.document.name,
        outcome: 'passed',
        explanation,
        response: { ...(explanation['response'] as Doc), timeMs: 0 },
        tests: [],
        console: [],
        variables: {},
      };
    });
    // Collections run from their menu: right-click, or the row's More button.
    const tree = await screen.findByRole('navigation', { name: 'Requests' });
    await user.click(await within(tree).findByRole('button', { name: 'More for Checkout' }));
    await user.click(screen.getByRole('menuitem', { name: /Explain collection/ }));
    const run = await screen.findByRole('region', { name: 'Run r-000001' });
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('Simulated')).toBeDefined();
    expect(within(inspector).getByRole('list', { name: 'Decisions' }).textContent).toContain(
      'No template matches path /v1/nowhere',
    );
    const steps = within(run).getByRole('list', { name: 'Steps' });
    await user.click(within(steps).getByRole('button', { name: /Create cart/ }));
    expect(within(inspector).getByRole('list', { name: 'Decisions' }).textContent).toContain('/v1/products');
    expect(within(inspector).getByRole('link', { name: 'fx_0000000000000011' })).toBeDefined();
    expect(within(inspector).queryByText(/No template matches path/)).toBeNull();
  });

  it('starts the side panel at the endpoint tree’s width and resizes it, sharing the width', async () => {
    window.localStorage.removeItem('janus-atlas-pane-tree');
    const { user } = renderApp('#/requests?id=checkout');
    const handle = await screen.findByRole('separator', { name: 'Resize side panel' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    handle.focus();
    await user.keyboard('{ArrowRight}');
    expect(handle.getAttribute('aria-valuenow')).toBe('336');
    expect(window.localStorage.getItem('janus-atlas-pane-tree')).toBe('336');
  });

  it('edits a shared environment in its tab, marks a value sensitive and turns one off', async () => {
    const { server, user } = renderApp('#/requests?id=checkout');
    await user.click(await screen.findByRole('button', { name: 'Environments' }));
    const list = screen.getByRole('navigation', { name: 'Environments' });
    // With the environments showing, the hotbar holds New environment and Import only.
    expect(
      hotbar()
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['New environment', 'Import']);
    expect(screen.queryByText(/Shared by every collection/)).toBeNull();
    await user.click(within(list).getByRole('button', { name: /^Staging/ }));
    const sensitive = await front().findByRole('button', { name: 'Sensitive, token' });
    expect(sensitive.getAttribute('aria-pressed')).toBe('false');
    await user.click(sensitive);
    expect(sensitive.getAttribute('aria-pressed')).toBe('true');
    // A sensitive value is masked.
    expect(front().getByLabelText('Value, token')).toHaveProperty('type', 'password');
    await user.click(front().getByRole('checkbox', { name: 'Use baseUrl' }));
    await user.click(front().getByRole('button', { name: 'Save environment' }));
    await front().findByText('Saved.');
    const write = server.writes.find((entry) => entry.path === 'environments/staging');
    expect(write?.headers['if-match']).toBe('sha256:env');
    expect(write?.body).toEqual({
      document: { name: 'Staging', vars: { baseUrl: 'https://staging.example.com' }, disabled: ['baseUrl'] },
      local: { vars: { token: 't0ken' } },
    });
  });

  it('renames an environment on its tab or from the list, and duplicates one', async () => {
    const { server, user } = renderApp('#/requests?id=checkout');
    await user.click(await screen.findByRole('button', { name: 'Environments' }));
    const list = screen.getByRole('navigation', { name: 'Environments' });
    await user.click(within(list).getByRole('button', { name: /^Staging/ }));
    await front().findByRole('button', { name: 'Save environment' });
    // Double-click the tab: the new name is an unsaved change until saved.
    const tabs = screen.getByRole('navigation', { name: 'Open editors' });
    await user.dblClick(within(tabs).getByRole('link', { name: /Staging/ }));
    await user.clear(within(tabs).getByRole('textbox', { name: 'Request name' }));
    await user.type(within(tabs).getByRole('textbox', { name: 'Request name' }), 'Stage{Enter}');
    expect(within(tabs).getByRole('link', { name: /Stage, unsaved changes/ })).toBeDefined();
    await user.click(front().getByRole('button', { name: 'Save environment' }));
    await front().findByText('Saved.');
    expect(server.writes.find((entry) => entry.path === 'environments/staging')?.body).toMatchObject({
      document: { name: 'Stage' },
    });
    // The list's menu renames too: it starts editing the tab's name.
    await user.pointer({ keys: '[MouseRight]', target: within(list).getByRole('button', { name: /^Stag/ }) });
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(within(tabs).getByRole('textbox', { name: 'Request name' })).toBeDefined();
    await user.keyboard('{Escape}');
    // Duplicate copies it, sensitive values included, and opens the copy.
    await user.click(front().getByRole('button', { name: 'Duplicate environment' }));
    await waitFor(() => {
      expect(server.writes.map((entry) => entry.path)).toContain('environments/staging-copy');
    });
    const copy = server.writes.find((entry) => entry.path === 'environments/staging-copy');
    expect(copy?.headers['if-none-match']).toBe('*');
    expect(copy?.body).toMatchObject({ document: { name: 'Stage copy' } });
    expect(await within(tabs).findByRole('link', { name: /Stage copy/ })).toBeDefined();
  });

  it('picks the default environment, and the star on a tab makes another the default', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    server.moreEnvironments = [{ id: 'dev', name: 'Dev', default: true }];
    await screen.findByLabelText('URL');
    const bar = screen.getByLabelText<HTMLSelectElement>('Environment');
    await waitFor(() => {
      expect(bar.value).toBe('dev');
    });
    expect(within(bar).getByRole('option', { name: 'Dev (default)' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Environments' }));
    const list = screen.getByRole('navigation', { name: 'Environments' });
    expect(within(list).getByRole('button', { name: /^Dev/ }).textContent).toContain('Default');
    await user.click(within(list).getByRole('button', { name: /^Staging/ }));
    const star = await front().findByRole('button', { name: 'Default environment' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    await user.click(star);
    await front().findByText('Now the default environment.');
    const writes = server.writes.filter((entry) => entry.path.startsWith('environments/'));
    // The new default is marked first, then the old one unmarked; the rest of each file is kept.
    expect(writes.map((entry) => entry.path)).toEqual(['environments/staging', 'environments/dev']);
    expect(writes[0]?.body).toEqual({
      document: {
        name: 'Staging',
        vars: { baseUrl: 'https://staging.example.com', token: 't0ken' },
        default: true,
      },
      local: null,
    });
    expect(writes[1]?.body).toEqual({ document: { name: 'Dev' }, local: null });
    await waitFor(() => {
      expect(star.getAttribute('aria-pressed')).toBe('true');
    });
    expect(within(list).getByRole('button', { name: /^Staging/ }).textContent).toContain('Default');
  });
});

describe('runner helpers', () => {
  it('reads and writes extract entries in both forms', () => {
    const short = rowOf('cartId', '{{$response.body.$.id}}');
    expect(short).toMatchObject({ source: 'response.body', argument: '$.id', optional: false });
    expect(entryOf(short)).toBe('{{$response.body.$.id}}');
    const long = rowOf('sid', { value: '{{$response.header.set-cookie}}', match: 'sid=([^;]+)', default: 'none' });
    expect(long).toMatchObject({ source: 'response.header', argument: 'set-cookie', optional: true });
    expect(entryOf(long)).toEqual({ value: '{{$response.header.set-cookie}}', match: 'sid=([^;]+)', default: 'none' });
    expect(entryOf(rowOf('status', '{{$response.status}}'))).toBe('{{$response.status}}');
    const custom = rowOf('auth', 'Bearer {{$response.body.$.token}}');
    expect(custom.source).toBe('template');
    expect(entryOf(custom)).toBe('Bearer {{$response.body.$.token}}');
    expect(entryOf({ ...short, optional: true })).toEqual({ value: '{{$response.body.$.id}}', optional: true });
    expect(summaryOf(long)).toEqual(['header set-cookie', 'match sid=([^;]+)', 'default "none"']);
    expect(summaryOf({ ...short, optional: true })).toEqual(['body $.id', 'optional']);
    expect(summaryOf(rowOf('status', '{{$response.status}}'))).toEqual(['status']);
  });

  it('finds variables and resolves them in scope order', () => {
    expect(templateParts('{{ baseUrl }}/x/{{$uuid}}')).toEqual([
      { kind: 'variable', text: '{{ baseUrl }}', name: 'baseUrl' },
      { kind: 'text', text: '/x/' },
      { kind: 'token', text: '{{$uuid}}' },
    ]);
    const scopes: Scopes = {
      run: { a: 1 },
      request: { a: 'request', b: 'request' },
      environment: { name: 'Staging', vars: { b: 'env', c: 'env' } },
      folders: [
        { name: 'Carts', vars: { c: 'folder', d: 'folder' } },
        { name: 'Checkout', vars: { d: 'collection', e: 'collection' } },
      ],
      extracted: [],
    };
    expect(resolve('a', scopes)).toEqual({ defined: true, value: '1', scope: 'run variable' });
    expect(resolve('b', scopes)).toMatchObject({ scope: 'request variable' });
    expect(resolve('c', scopes)).toMatchObject({ scope: 'environment Staging' });
    expect(resolve('d', scopes)).toMatchObject({ value: 'folder', scope: 'folder Carts' });
    expect(resolve('e', scopes)).toMatchObject({ scope: 'folder Checkout' });
    expect(resolve('f', scopes)).toEqual({ defined: false });
  });

  it('names new files and variables', () => {
    expect(pathParamNames('{{baseUrl}}/v1/carts/:cartId/items/:itemId?x=:no')).toEqual(['cartId', 'itemId']);
    expect(slug('Create cart!')).toBe('create-cart');
    expect(nextOrdered(['c/010-a', 'c/020-b'], 'c')).toBe('030-c');
    expect(nextOrdered([], 'first')).toBe('010-first');
    expect(variableNameFor('$.items[0].sku_code')).toBe('skuCode');
    expect(variableNameFor('x-request-id')).toBe('xRequestId');
  });

  it('decodes the tree and request documents, and runner events', () => {
    const tree = decodeRequestTree(new RunnerServer().tree(), '');
    expect(tree.collections[0]?.children).toHaveLength(2);
    expect(() => decodeRequestDocument({ name: 'x', method: 'GET', url: 1 }, '')).toThrow();
    expect(() => decodeRequestDocument({ name: 'x', method: 'GET', url: '/', body: { type: 'soap' } }, '')).toThrow();
    expect(decodeEvent('requests', '{"changed":["a/b"]}')).toEqual({ type: 'requests', changed: ['a/b'] });
    expect(decodeEvent('requests', '{"changed":[1]}')).toBeNull();
    expect(decodeEvent('run', '{"id":"r-000001","state":"step","step":2,"outcome":"passed"}')).toEqual({
      type: 'run',
      id: 'r-000001',
      state: 'step',
      step: 2,
      outcome: 'passed',
    });
    expect(decodeEvent('run', '{"id":"../x","state":"step"}')).toBeNull();
  });
});

describe('request state and pending sends', () => {
  it('starts only one run while the start request is pending', async () => {
    const { server, user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    server.holdStarts = true;
    await user.dblClick(screen.getByRole('button', { name: 'Send' }));
    try {
      expect(server.writes.filter((entry) => entry.path === 'runs')).toHaveLength(1);
    } finally {
      await act(async () => {
        server.releaseStarts.forEach((release) => {
          release();
        });
        await Promise.resolve();
      });
    }
  });
  it('keeps unsaved edits when visiting another main view', async () => {
    const { user } = renderApp('#/requests?id=checkout%2F010-create-cart');
    const url = await screen.findByLabelText('URL');
    await user.clear(url);
    await user.type(url, 'https://new.example.test/changed');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Views' })).getByRole('link', { name: 'Endpoints' }),
    );
    await user.click(within(screen.getByRole('navigation', { name: 'Views' })).getByRole('link', { name: 'Requests' }));
    expect(await screen.findByLabelText('URL')).toHaveProperty('value', 'https://new.example.test/changed');
  });
  it('does not reread a finished run on an unrelated run event', async () => {
    const { server, user, events } = renderApp('#/requests?id=checkout%2F010-create-cart');
    await screen.findByLabelText('URL');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('region', { name: 'Result of Create cart' });
    const before = server.reads.filter((path) => path === 'runs/r-000001').length;
    await act(async () => {
      events.latest()?.emit('run', { id: 'r-999999', state: 'step', step: 1, outcome: 'passed' });
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.reads.filter((path) => path === 'runs/r-000001')).toHaveLength(before);
  });
});

it('blocks saving a base64 Explore body instead of dropping it', async () => {
  const { server, user } = renderApp('#/requests?mode=explore&m=POST&t=/v1/carts');
  const editor = await screen.findByRole('form', { name: 'Request to simulate' });
  await user.click(within(editor).getByLabelText('Send a body'));
  await user.click(within(editor).getByLabelText('Base64'));
  await user.type(within(editor).getByLabelText('Body (base64)'), 'e30=');
  const save = within(editor).getByRole('button', { name: 'Save to collection' });
  expect(save).toHaveProperty('disabled', true);
  expect(within(editor).getByText(/Base64 bodies cannot be saved to a collection/)).toBeDefined();
  await user.click(save);
  expect(server.writes.filter((entry) => entry.method === 'PUT')).toHaveLength(0);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('requires explicit resolution of a concurrent environment edit', async () => {
  const { server, user } = renderApp('#/requests?env=staging');
  const field = await screen.findByLabelText('Value, baseUrl');
  await user.clear(field);
  await user.type(field, 'https://mine.test');
  server.environment = {
    ...server.environment,
    digest: 'sha256:env-new',
    document: { name: 'Staging', vars: { baseUrl: 'https://staging.example.com', token: 'rotated-by-other-user' } },
  };
  await user.click(screen.getByRole('button', { name: 'Save environment' }));
  await screen.findByRole('heading', { name: 'The environment changed on disk' });
  expect(screen.getByRole('button', { name: 'Save environment' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: 'Use file' }));
  expect(screen.getByLabelText('Value, token')).toHaveProperty('value', 'rotated-by-other-user');
  expect(screen.getByLabelText('Value, baseUrl')).toHaveProperty('value', 'https://staging.example.com');
  expect((server.environment['document'] as { vars: Record<string, string> }).vars.token).toBe('rotated-by-other-user');
});

it('allows an explicit environment replacement using the refreshed digest', async () => {
  const { server, user } = renderApp('#/requests?env=staging');
  const field = await screen.findByLabelText('Value, baseUrl');
  await user.clear(field);
  await user.type(field, 'https://mine.test');
  server.environment = { ...server.environment, digest: 'sha256:env-new' };
  await user.click(screen.getByRole('button', { name: 'Save environment' }));
  const keep = await screen.findByRole('button', { name: 'Keep my edit' });
  await waitFor(() => {
    expect(keep).toHaveProperty('disabled', false);
  });
  await user.click(keep);
  await screen.findByText('Saved.');
  expect(server.writes.at(-1)?.headers['if-match']).toBe('sha256:env-new');
  expect((server.environment['document'] as { vars: Record<string, string> }).vars.baseUrl).toBe('https://mine.test');
});

it('still refreshes a run when its own event arrives', async () => {
  const { server, user, events } = renderApp('#/requests?id=checkout%2F010-create-cart');
  await screen.findByLabelText('URL');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('region', { name: 'Result of Create cart' });
  const before = server.reads.filter((path) => path === 'runs/r-000001').length;
  await act(async () => {
    events.latest()?.emit('run', { id: 'r-000001', state: 'finished', outcome: 'passed' });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(server.reads.filter((path) => path === 'runs/r-000001')).toHaveLength(before + 1);
  });
});
