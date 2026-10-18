import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import { endpointId } from '../ids.js';
import type { Engine, HeaderMap, RequestDescription, ResponseDescription } from '../types/index.js';
import { SIMULATION_NOTES } from './explain.js';

// engine.atlas.explain: one resolver, projected, with no side effects.

const TREE: Readonly<Record<string, string>> = {
  'default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  'default/v1/products/POST/201_{application-json}.json': '{"id":"{{$body.$.name}}"}',
  'default/v1/products/POST/accepts.yaml': 'accepts: [application/json]\n',
  'default/v1/products/POST/201.headers.json': JSON.stringify({ 'Set-Cookie': 'session=secret', Location: '/v1/p' }),
  'default/v1/products/featured/GET/200_{application-json}.json': '{"featured":true}',
  'default/v1/products/{productId}/GET/200_{application-json}.json': '{"id":"{{$path.productId}}"}',
  'default/v1/products/{productId}/GET/200_{application-yaml}.yaml': 'id: "{{$path.productId}}"\n',
  'default/v1/products/{productId}/reviews/GET/200_{application-json}.json': '[]',
  'default/v1/greeting/GET/200_[fr]_{text-plain}.txt': 'Bonjour',
  'default/v1/p-1/DELETE/204': '',
  'default/v1/ids/GET/200_{text-plain}.txt': '{{$uuid:unique}}',
  'default/v1/broken/GET/200_{application-json}.json': '{"at":"{{$now}}"}',
};

function engineFor(clock?: () => number): Engine {
  const built = buildSnapshot(new Map(Object.entries(TREE).map(([path, text]) => [path, utf8Encode(text)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  let counter = 0;
  return createEngine({
    snapshot: built.snapshot,
    config: { seed: 7, now: Date.UTC(2026, 0, 1) },
    randomBytes: (count) => new Uint8Array(count).fill(++counter),
    ...(clock === undefined ? {} : { clock }),
  });
}

const request = (method: string, target: string, headers: HeaderMap = {}, body?: string): RequestDescription => ({
  method,
  target,
  headers,
  ...(body === undefined ? {} : { body: utf8Encode(body) }),
});

const json = { 'content-type': ['application/json'] };

/** Every outcome kind, and the interesting variations of a match. */
const CASES: readonly [string, RequestDescription][] = [
  ['matched', request('GET', '/v1/products')],
  ['matched by template', request('GET', '/v1/products/p-42', { accept: ['application/yaml'] })],
  ['matched after backtracking', request('GET', '/v1/products/featured/reviews')],
  ['matched HEAD', request('HEAD', '/v1/products')],
  ['matched bodyless', request('DELETE', '/v1/p-1')],
  ['matched with a body', request('POST', '/v1/products', json, '{"name":"Chair"}')],
  ['route-not-found', request('GET', '/v1/nowhere')],
  ['method-not-allowed', request('PATCH', '/v1/products')],
  ['not-acceptable (media type)', request('GET', '/v1/products', { accept: ['text/csv'] })],
  ['not-acceptable (language)', request('GET', '/v1/greeting', { 'accept-language': ['de'] })],
  ['unsupported-media-type', request('POST', '/v1/products', { 'content-type': ['text/plain'] }, 'x')],
  ['invalid-request (method)', request('G E T', '/v1/products')],
  ['invalid-request (target)', request('GET', '/v1/../x')],
  ['invalid-request (body)', request('POST', '/v1/products', json, '{not json')],
  ['the Atlas namespace', request('GET', '/_janus/health')],
];

const projectHeaders = (response: ResponseDescription) =>
  Object.keys(response.headers)
    .sort()
    .flatMap((name) => (response.headers[name] ?? []).map((value) => ({ name, value })));

describe('engine.atlas.explain', () => {
  it.each(CASES)('answers exactly as resolve does: %s', async (_label, simulated) => {
    const engine = engineFor();
    const served = await engine.resolve(simulated);
    const explained = await engine.atlas.explain(simulated);
    expect(explained.snapshotVersion).toBe(served.trace.snapshotVersion);
    expect(explained.response?.status).toBe(served.status);
    expect(explained.response?.headers).toEqual(projectHeaders(served));
    // A simulation describes the transport without performing it.
    const transport = served.trace.transport;
    expect(explained.trace).toEqual({
      ...served.trace,
      ...(transport === undefined ? {} : { transport: { ...transport, performed: false } }),
    });
    if (served.body === null) {
      expect(explained.response?.body).toEqual({ state: 'unavailable', reason: 'bodyless' });
    } else {
      expect(explained.response?.body).toMatchObject({
        state: 'available',
        encoding: 'utf8',
        value: new TextDecoder().decode(served.body),
        byteLength: served.body.length,
        truncated: false,
      });
    }
    expect(explained.notes).toEqual(SIMULATION_NOTES);
  });

  it('links the fixture that answered, and nothing for a Janus-generated outcome', async () => {
    const engine = engineFor();
    const explained = await engine.atlas.explain(request('GET', '/v1/products/featured/reviews'));
    expect(explained.fixture).toEqual({
      endpointId: endpointId('default', 'GET', ['v1', 'products', '{productId}', 'reviews']),
      fixtureId: explained.trace.headers?.identity,
    });
    expect(explained.trace.route).toEqual({
      template: '/v1/products/{productId}/reviews',
      params: { productId: 'featured' },
      considered: ['/v1/products/featured'],
    });
    expect((await engine.atlas.explain(request('GET', '/v1/nowhere'))).fixture).toBeNull();
    expect((await engine.atlas.explain(request('PATCH', '/v1/products'))).fixture).toBeNull();
  });

  it('shows every response header value as served', async () => {
    const explained = await engineFor().atlas.explain(request('POST', '/v1/products', json, '{"name":"Chair"}'));
    expect(explained.response?.headers).toContainEqual({ name: 'set-cookie', value: 'session=secret' });
  });

  it('never echoes request header or body values in the trace', async () => {
    const explained = await engineFor().atlas.explain(
      request('POST', '/v1/products', { ...json, authorization: ['Bearer token-123'] }, '{"name":"Chair-77"}'),
    );
    expect(JSON.stringify(explained.trace)).not.toContain('token-123');
    expect(JSON.stringify(explained.trace)).not.toContain('Chair-77');
    // The rendered response itself is what a real request would get.
    expect(explained.response?.body).toMatchObject({ value: '{"id":"Chair-77"}' });
  });

  it('renders :unique tokens and reports nondeterminism like a real request', async () => {
    const engine = engineFor();
    const explained = await engine.atlas.explain(request('GET', '/v1/ids'));
    const served = await engine.resolve(request('GET', '/v1/ids'));
    expect(explained.trace.render?.nondeterministic).toBe(true);
    expect(served.trace.render?.nondeterministic).toBe(true);
    expect(explained.response?.headers).toContainEqual({
      name: 'x-mock-nondeterministic',
      value: 'true',
    });
  });

  it('honours nowMs like a real request', async () => {
    const explained = await engineFor().atlas.explain({ ...request('GET', '/v1/broken'), nowMs: Date.UTC(2030, 0, 1) });
    expect(explained.response?.body).toMatchObject({ value: '{"at":"2030-01-01T00:00:00Z"}' });
    expect(explained.trace.render?.clockSource).toBe('caller');
  });

  it('leaves no state behind: a real request after a simulation gets the same bytes', async () => {
    const plain = engineFor();
    const simulated = engineFor();
    for (const [, simulatedRequest] of CASES) await simulated.atlas.explain(simulatedRequest);
    for (const [, served] of CASES) {
      if (served.target === '/v1/ids') continue;
      const a = await plain.resolve(served);
      const b = await simulated.resolve(served);
      expect(b.status).toBe(a.status);
      expect(b.headers).toEqual(a.headers);
      expect(b.body).toEqual(a.body);
    }
    expect(simulated.atlas.health()).toEqual(plain.atlas.health());
  });

  it('rejects when aborted before it starts, without effect', async () => {
    const engine = engineFor();
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    await expect(engine.atlas.explain(request('GET', '/v1/products'), { signal: controller.signal })).rejects.toThrow(
      'client went away',
    );
    expect((await engine.resolve(request('GET', '/v1/products'))).status).toBe(200);
  });
});
