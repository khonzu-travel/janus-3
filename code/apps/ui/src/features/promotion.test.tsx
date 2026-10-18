import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { errorResponse, FakeAtlas, jsonResponse, V1 } from '../../test/fake-atlas.js';
import { fakeEventSources } from '../../test/fake-events.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// Promotion in the UI.

type Doc = Record<string, unknown>;

const EP = 'ep_00000000000000aa';
const FX = 'fx_00000000000000aa';
const HAND = 'fx_00000000000000bb';
const DIGEST_SHOWN = `sha256:${'a'.repeat(64)}`;
const HAND_DIGEST = `sha256:${'b'.repeat(64)}`;
const SIDECAR_DIGEST = `sha256:${'c'.repeat(64)}`;

const PROMOTION: Doc = {
  file: '/v1/payments/POST/402.json',
  capture: 'default/000001',
  promotedAt: '2026-10-05T09:12:40Z',
  review: 'pending',
  reviewedAt: null,
  modified: false,
  rewrites: [{ id: 'paymentId', tier: 'exact', pointer: '/id' }],
  suggestions: [{ id: 'paymentId', pointer: '/note' }],
  refusals: [{ id: 'amount', code: 'id-not-string', pointer: '/amount' }],
  notes: [],
};

const PREVIEW = '{"id":"{{$scenario.ids.paymentId}}","status":"declined"}';

const summary: Doc = {
  id: FX,
  status: 402,
  mediaType: 'application/json',
  wireContentType: 'application/json',
  locale: null,
  byteLength: PREVIEW.length,
  headers: [],
  digest: DIGEST_SHOWN,
  provenance: PROMOTION,
  sidecar: {
    digest: SIDECAR_DIGEST,
    provenance: {
      ...PROMOTION,
      file: '/v1/payments/POST/402.headers.json',
      rewrites: [],
      suggestions: [],
      refusals: [],
    },
  },
  detailHref: `fixtures/${FX}?at=${V1}`,
};

const CAPTURE: Doc = {
  id: 'default/000001',
  request: {
    state: 'available',
    method: 'POST',
    target: '/v1/payments',
    registration: { method: 'POST', path: '/v1/payments' },
    params: [],
    headers: [],
    body: { state: 'available', encoding: 'utf8', value: '{}', byteLength: 2, truncated: false },
  },
  response: {
    state: 'available',
    status: 402,
    fileName: '402.json',
    headers: [],
    body: {
      state: 'available',
      encoding: 'utf8',
      value: '{"id":"pay_8f2e91c0","status":"declined"}',
      byteLength: 41,
      truncated: false,
    },
    modified: false,
  },
  provenance: {
    state: 'available',
    capturedAt: null,
    durationMs: 1,
    registration: null,
    removedHeaders: [],
    notes: [],
  },
  promotedTo: [],
};

function plan(dryRun: boolean, conflicts: readonly Doc[] = []): Doc {
  return {
    apiVersion: 'atlas.v1',
    outcome: dryRun ? 'planned' : 'promoted',
    capture: 'default/000001',
    scenario: 'default',
    endpoint: { method: 'POST', path: '/v1/payments' },
    files: [
      {
        file: '/v1/payments/POST/402.json',
        role: 'response',
        action: 'create',
        digest: DIGEST_SHOWN,
        ...(dryRun
          ? { preview: { state: 'available', encoding: 'utf8', value: PREVIEW, byteLength: 56, truncated: false } }
          : {}),
      },
      { file: '/v1/payments/POST/402.meta.json', role: 'provenance', action: 'create', digest: DIGEST_SHOWN },
    ],
    bindings: [{ id: 'paymentId', value: 'pay_8f2e91c0', tier: 'inferred', source: 'response' }],
    rewrites: [{ id: 'paymentId', tier: 'inferred', pointer: '/id', file: '/v1/payments/POST/402.json' }],
    suggestions: [],
    refusals: [],
    notes: [],
    warnings: [],
    ...(dryRun ? { applicable: conflicts.length === 0, conflicts } : {}),
  };
}

/** A server that records and promotes, with one promoted response pending review. */
function promotingAtlas(sidecarConflict = false): { fake: FakeAtlas; posts: { path: string; body: Doc }[] } {
  const fake = new FakeAtlas();
  const posts: { path: string; body: Doc }[] = [];
  fake.capabilities = {
    resolve: true,
    reload: true,
    watch: false,
    events: true,
    recording: { available: true, endpoints: 1 },
    promotion: { available: true, mode: 'staged', pending: 2 },
  };
  fake.extra = (path) => {
    if (path === 'endpoints') {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        scenario: 'default',
        items: [
          {
            id: EP,
            scenario: 'default',
            method: 'POST',
            path: '/v1/payments',
            pathParameters: [],
            origin: 'own',
            review: 'pending',
            detailHref: `endpoints/${EP}?at=${V1}`,
          },
        ],
      });
    }
    if (path === `endpoints/${EP}`) {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        id: EP,
        scenario: 'default',
        method: 'POST',
        path: '/v1/payments',
        pathParameters: [],
        fixtures: [summary],
        representationGroups: [{ status: 402, locale: null, representations: [summary] }],
        accepts: null,
      });
    }
    if (path === `fixtures/${FX}`) {
      const { detailHref: _detail, ...rest } = summary;
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        ...rest,
        endpointId: EP,
        scenario: 'default',
        method: 'POST',
        path: '/v1/payments',
        pathParameters: [],
        preview: { state: 'available', encoding: 'utf8', value: PREVIEW, byteLength: PREVIEW.length, truncated: false },
      });
    }
    if (path === `fixtures/${HAND}`) {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        id: HAND,
        status: 402,
        mediaType: 'application/json',
        wireContentType: 'application/json',
        locale: null,
        byteLength: 15,
        headers: [],
        digest: HAND_DIGEST,
        sidecar: {
          digest: SIDECAR_DIGEST,
          provenance: null,
          preview: {
            state: 'available',
            encoding: 'utf8',
            value: '{"location":"/hand-written"}',
            byteLength: 28,
            truncated: false,
          },
        },
        endpointId: EP,
        scenario: 'default',
        method: 'POST',
        path: '/v1/payments',
        pathParameters: [],
        preview: { state: 'available', encoding: 'utf8', value: '{"hand":"made"}', byteLength: 15, truncated: false },
      });
    }
    if (path === 'promotions') {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        at: V1,
        items: [
          {
            scenario: 'default',
            file: '/v1/payments/POST/402.json',
            fixtureId: FX,
            endpointId: EP,
            capture: 'default/000001',
            promotedAt: '2026-10-05T09:12:40Z',
            review: 'pending',
            reviewedAt: null,
            modified: false,
            attention: { inferred: 0, suggestions: 1, refusals: 1, notes: 0 },
            detailHref: `fixtures/${FX}?at=${V1}`,
          },
          {
            scenario: 'default',
            file: '/v1/payments/POST/402.headers.json',
            capture: 'default/000001',
            promotedAt: '2026-10-05T09:12:40Z',
            review: 'pending',
            reviewedAt: null,
            modified: true,
            attention: { inferred: 0, suggestions: 0, refusals: 0, notes: 0 },
          },
        ],
        pending: 2,
      });
    }
    if (path === 'captures/default/000001') return jsonResponse(200, { apiVersion: 'atlas.v1', ...CAPTURE });
    if (path === 'recording') {
      return jsonResponse(200, {
        apiVersion: 'atlas.v1',
        available: true,
        endpoints: [{ method: 'POST', path: '/v1/payments', upstream: 'https://staging.example.test' }],
        timeoutMs: 30000,
        maxResponseBytes: 1024,
        maxConcurrent: 4,
      });
    }
    return null;
  };
  fake.extraPost = (path, body) => {
    posts.push({ path, body });
    if (path === 'promotions/review') return jsonResponse(200, { apiVersion: 'atlas.v1', items: [] });
    if (path !== 'promotions') return null;
    if (body['path'] === '/v1/{x}/y') {
      return jsonResponse(422, {
        error: {
          code: 'promotion-invalid-path',
          message: '"path" /v1/{x}/y has 3 segments, but the registration /v1/payments has 2',
          field: 'path',
        },
      });
    }
    if (body['scenario'] === 'ghost') return errorResponse(400, 'unknown-scenario', 'no scenario named "ghost"');
    const replace = body['replace'] as readonly Doc[] | undefined;
    const conflicts =
      replace?.some((entry) => entry['digest'] === (sidecarConflict ? SIDECAR_DIGEST : HAND_DIGEST)) === true
        ? []
        : [
            {
              file: sidecarConflict ? '/v1/payments/POST/402.headers.json' : '/v1/payments/POST/402.json',
              kind: 'hand-written',
              reason: 'hand-written',
              fixtureId: HAND,
              detailHref: `fixtures/${HAND}?at=${V1}`,
            },
          ];
    const result = plan(body['dryRun'] === true, conflicts);
    if (sidecarConflict)
      (result['files'] as Doc[]).push({
        file: '/v1/payments/POST/402.headers.json',
        role: 'headers',
        action: 'replace',
        digest: DIGEST_SHOWN,
      });
    return jsonResponse(body['dryRun'] === true ? 200 : 201, result);
  };
  return { fake, posts };
}

function renderApp(fake: FakeAtlas, hash: string) {
  window.location.hash = hash;
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(
    <App
      client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })}
      eventSource={fakeEventSources().create}
    />,
  );
  return userEvent.setup();
}

describe('the Promotions page', () => {
  it('is reached from a Promotions tab with the pending count, and lists promoted files', async () => {
    const { fake } = promotingAtlas();
    const user = renderApp(fake, '');
    const tab = await screen.findByRole('link', { name: /^Promotions/ });
    expect(tab.textContent).toContain('2');
    await user.click(tab);
    const table = await screen.findByRole('table', { name: /Promotions/ });
    // The response file and its header file came from one promotion, so they share a row.
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: '/v1/payments/POST/402.json' })).toBeDefined();
    expect(rows[1]?.textContent).toContain('/v1/payments/POST/402.headers.json');
    expect(rows[1]?.textContent).toContain('1 suggestion, 1 refusal');
    expect(rows[1]?.textContent).toContain('Pending review');
    expect(rows[1]?.textContent).toContain('Modified since promoted');
    expect(fake.requests).toContain('/_janus/promotions?review=pending');

    await user.type(screen.getByRole('searchbox', { name: 'Filter promotions' }), 'no such file');
    expect(screen.getByText('No promotion matches this filter.')).toBeDefined();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter promotions' }));
    // Clicking anywhere in the row opens the response the promotion wrote.
    await user.click(within(screen.getByRole('table', { name: /Promotions/ })).getByText('Pending review'));
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/endpoints\/[^/]+\/fixtures\//);
    });
  });

  it('is not offered when the server cannot promote', async () => {
    const fake = new FakeAtlas();
    renderApp(fake, '');
    await screen.findByRole('link', { name: 'Requests' });
    expect(screen.queryByRole('link', { name: /^Promotions/ })).toBeNull();
  });
});

describe('review state', () => {
  it('badges the endpoint, explains the provenance, and marks it reviewed with the digest shown', async () => {
    const { fake, posts } = promotingAtlas();
    const user = renderApp(fake, `#/endpoints/${EP}/fixtures/${FX}`);
    const panel = await screen.findByRole('region', { name: 'Promoted' });
    expect(within(panel).getByRole('link', { name: 'default/000001' })).toBeDefined();
    expect(panel.textContent).toContain('{{$scenario.ids.paymentId}} replaces the captured value at /id');
    expect(panel.textContent).toContain('also appears inside other text at /note');
    expect(panel.textContent).toContain('JSON number or boolean');
    expect(screen.getByRole('link', { name: /POST \/v1\/payments.*pending review/ })).toBeDefined();

    await user.click(within(panel).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => {
      expect(posts.map((post) => post.path)).toContain('promotions/review');
    });
    expect(posts.find((post) => post.path === 'promotions/review')?.body).toEqual({
      scenario: 'default',
      files: [
        { file: '/v1/payments/POST/402.json', digest: DIGEST_SHOWN },
        { file: '/v1/payments/POST/402.headers.json', digest: SIDECAR_DIGEST },
      ],
    });
  });
});

describe('the Promote dialog', () => {
  it('previews the files, confirms a hand-written file with the digest shown, promotes, and links back', async () => {
    const { fake, posts } = promotingAtlas();
    const user = renderApp(fake, '#/captures/default/000001');
    const open = await screen.findByRole('button', { name: 'Promote' });
    await user.click(open);
    const dialog = await screen.findByRole('dialog', { name: /Promote capture default\/000001/ });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Scenario'));

    // The dry run: the binding Janus found, its tier, the file with the rewrite marked.
    await within(dialog).findByText('pay_8f2e91c0');
    expect(within(dialog).getByText(/inferred, from the response/)).toBeDefined();
    expect(within(dialog).getAllByText('{{$scenario.ids.paymentId}}').length).toBeGreaterThan(0);
    const promote = within(dialog).getByRole('button', { name: 'Promote' });
    expect((promote as HTMLButtonElement).disabled).toBe(true);

    // The hand-written file is shown and must be ticked on its own.
    await waitFor(() => {
      expect(dialog.textContent).toContain('"hand": "made"');
    });
    await user.click(within(dialog).getByRole('checkbox', { name: /Replace \/v1\/payments\/POST\/402.json/ }));
    await waitFor(() => {
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Promote' }).disabled).toBe(false);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Promote' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const write = posts.filter((post) => post.path === 'promotions' && post.body['dryRun'] !== true).at(-1);
    expect(write?.body).toEqual({
      capture: 'default/000001',
      replace: [{ file: '/v1/payments/POST/402.json', digest: HAND_DIGEST }],
    });
    expect(await screen.findByText(/It is pending review/)).toBeDefined();
  });

  it('sends only the edits made after the pencil is pressed', async () => {
    const { fake, posts } = promotingAtlas();
    const user = renderApp(fake, '#/captures/default/000001');
    await user.click(await screen.findByRole('button', { name: 'Promote' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Edit before promoting' }));
    expect(within(dialog).getByRole('group', { name: 'Body' })).toBeDefined();
    const dryRuns = () => posts.filter((post) => post.path === 'promotions' && post.body['dryRun'] === true);
    // Opening the editor changes nothing.
    await waitFor(() => {
      expect(dryRuns().length).toBeGreaterThan(0);
    });
    expect(dryRuns().at(-1)?.body).not.toHaveProperty('headers');
    await user.click(within(dialog).getByRole('button', { name: 'Add header' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Response headers name 1' }), 'x-edited');
    await user.type(within(dialog).getByRole('textbox', { name: 'Response headers value 1' }), 'yes');
    await waitFor(() => {
      expect(dryRuns().at(-1)?.body['headers']).toEqual({ 'x-edited': 'yes' });
    });
    expect(dryRuns().at(-1)?.body).not.toHaveProperty('body');
    await user.click(within(dialog).getByRole('button', { name: 'Discard edits' }));
    await waitFor(() => {
      expect(dryRuns().at(-1)?.body).not.toHaveProperty('headers');
    });
  });

  it('shows a refused route template next to its field, and closes on Escape', async () => {
    const { fake } = promotingAtlas();
    const user = renderApp(fake, '#/captures/default/000001');
    await user.click(await screen.findByRole('button', { name: 'Promote' }));
    const dialog = await screen.findByRole('dialog');
    const path = within(dialog).getByLabelText(/Route template/);
    await user.clear(path);
    await user.type(path, '/v1/{{x}/y');
    const error = await within(dialog).findByText(/has 3 segments/);
    expect(path.getAttribute('aria-describedby')).toBe(error.id);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Promote' }));
  });
});

it('confirms a protected header sidecar using its own preview and digest', async () => {
  const { fake, posts } = promotingAtlas(true);
  const user = renderApp(fake, '#/captures/default/000001');
  await user.click(await screen.findByRole('button', { name: 'Promote' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => {
    expect(dialog.textContent).toContain('"location": "/hand-written"');
  });
  expect(dialog.textContent).not.toContain('"hand": "made"');
  await user.click(within(dialog).getByRole('checkbox', { name: /Replace .*402.headers.json/ }));
  await waitFor(() => {
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Promote' }).disabled).toBe(false);
  });
  await user.click(within(dialog).getByRole('button', { name: 'Promote' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(posts.find((post) => post.path === 'promotions' && post.body['dryRun'] !== true)?.body['replace']).toEqual([
    { file: '/v1/payments/POST/402.headers.json', digest: SIDECAR_DIGEST },
  ]);
});
