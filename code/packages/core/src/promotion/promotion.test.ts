import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { EngineConfig } from '../config/merge.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import {
  fileDigest,
  parseProvenance,
  parseProvenanceName,
  PROVENANCE_FORMAT,
  serializeProvenance,
  type ProvenanceEntry,
} from '../fixtures/provenance.js';
import type { CapturePlan, RecordingPorts, UpstreamResponse } from '../recording/ports.js';
import type { RecordingEndpoint } from '../recording/registrations.js';
import type { AtlasReloadResult } from '../atlas/types.js';
import type { FixtureFiles, HeaderMap, RequestDescription } from '../types/index.js';
import type { FixtureWriter, PromotionAnswer, WritePlan } from './promoter.js';
import { unreviewedPromotions } from './review-check.js';
import { collectBindings, escapeTokens, rewriteJsonBody, rewriteTextBody, type Binding } from './rewrite.js';
import { canonicalSegmentName, resolveTemplate } from './target.js';

// Promotion in core.

const text = (bytes: Uint8Array | null | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());

describe('canonical segment names', () => {
  it.each([
    ['products', 'products'],
    ['café', 'caf%C3%A9'],
    ['a b', 'a%20b'],
    ['a*b', 'a%2Ab'],
    ['v1:batch', 'v1%3Abatch'],
    ['end.', 'end%2E'],
    ['con', '%63on'],
    ['NUL.txt', '%4EUL.txt'],
    ['lpt1', '%6Cpt1'],
    ['café', 'caf%C3%A9'],
  ])('%j is %j', (value, name) => {
    expect(canonicalSegmentName(value)).toBe(name);
    expect(decodeURIComponent(name)).toBe(value.normalize('NFC'));
  });

  it('refuses braces', () => {
    expect(() => canonicalSegmentName('{x}')).toThrow(expect.objectContaining({ code: 'promotion-invalid-path' }));
  });
});

describe('route templates', () => {
  const params = { productId: 'p-8812' };

  it("uses the registration's template and its parameter values", () => {
    expect(resolveTemplate('/v1/products/{productId}', params, undefined).bindings).toEqual([['productId', 'p-8812']]);
  });

  it('renames a parameter or turns a literal into one', () => {
    expect(resolveTemplate('/v1/products/{productId}', params, '/v1/products/{id}').bindings).toEqual([
      ['id', 'p-8812'],
    ]);
    expect(resolveTemplate('/v1/products/{productId}', params, '/{version}/products/{productId}').bindings).toEqual([
      ['version', 'v1'],
      ['productId', 'p-8812'],
    ]);
  });

  it.each(['/v1/products', '/v1/products/p-8812', '/v2/products/{productId}', 'v1/products/{productId}'])(
    'refuses %j',
    (path) => {
      expect(() => resolveTemplate('/v1/products/{productId}', params, path)).toThrow(
        expect.objectContaining({ code: 'promotion-invalid-path' }),
      );
    },
  );
});

describe('ID bindings', () => {
  it('takes explicit, then path, then response bindings, each with its tier', async () => {
    const { parseJsonTree } = await import('../dynamic/json-tree.js');
    const result = collectBindings({
      scenario: 's',
      declared: new Set(['paymentId', 'productId', 'orderId']),
      explicit: [['paymentId', 'pay_1234']],
      path: [
        ['productId', 'p-8812'],
        ['kind', 'lamps'],
      ],
      body: parseJsonTree('{"paymentId":"pay_9999","orderId":"ord-7777"}'),
    });
    expect(result.bindings.map(({ id, value, tier, source }) => [id, value, tier, source])).toEqual([
      ['orderId', 'ord-7777', 'inferred', 'response'],
      ['paymentId', 'pay_1234', 'exact', 'explicit'],
      ['productId', 'p-8812', 'exact', 'path'],
    ]);
    expect(result.refusals).toEqual([
      { code: 'id-undeclared', id: 'kind' },
      { code: 'id-conflict', id: 'paymentId' },
    ]);
  });

  it('refuses short values and names an unknown explicit ID', () => {
    const short = collectBindings({
      scenario: 's',
      declared: new Set(['id']),
      explicit: [['id', 'p1']],
      path: [],
      body: null,
    });
    expect(short).toEqual({ bindings: [], refusals: [{ code: 'id-too-short', id: 'id' }] });
    expect(() =>
      collectBindings({ scenario: 's', declared: new Set(['a']), explicit: [['b', 'value']], path: [], body: null }),
    ).toThrow(expect.objectContaining({ status: 422, code: 'promotion-unknown-id' }));
  });
});

describe('rewriting and escaping', () => {
  const pay: Binding = { id: 'paymentId', value: 'pay_8f2e91c0', tier: 'exact', source: 'explicit' };

  it('rewrites whole strings and URL segments, suggests substrings, refuses numbers and keys', () => {
    const source =
      '{"id":"pay_8f2e91c0","href":"/v1/payments/pay_8f2e91c0?x=1","note":"ref pay_8f2e91c0x","n":12345678,"pay_8f2e91c0":true}';
    const numeric: Binding = { id: 'orderId', value: '12345678', tier: 'exact', source: 'explicit' };
    const result = rewriteJsonBody(utf8Encode(source), source, [pay, numeric]);
    expect(JSON.parse(text(result.bytes))).toEqual({
      id: '{{$scenario.ids.paymentId}}',
      href: '/v1/payments/{{$scenario.ids.paymentId}}?x=1',
      note: 'ref pay_8f2e91c0x',
      n: 12345678,
      pay_8f2e91c0: true,
    });
    expect(result.rewrites).toEqual([
      { pointer: '/id', tier: 'exact', id: 'paymentId' },
      { pointer: '/href', tier: 'exact', id: 'paymentId' },
    ]);
    expect(result.suggestions).toEqual([{ pointer: '/note', id: 'paymentId' }]);
    expect(result.refusals.map((refusal) => refusal.code).sort()).toEqual(['id-in-key', 'id-not-string']);
  });

  it('keeps the bytes of a JSON body with nothing to change, and escapes {{$ otherwise', () => {
    const plain = '{ "a" : 1 }';
    expect(text(rewriteJsonBody(utf8Encode(plain), plain, [pay]).bytes)).toBe(plain);
    const literal = '{"t":"{{$now}}"}';
    expect(JSON.parse(text(rewriteJsonBody(utf8Encode(literal), literal, []).bytes))).toEqual({ t: '{{$$now}}' });
    expect(escapeTokens('a {{$x}} b')).toBe('a {{$$x}} b');
  });

  it('rewrites text by line', () => {
    const result = rewriteTextBody('payment pay_8f2e91c0\n  /v1/payments/pay_8f2e91c0\n', [pay]);
    expect(text(result.bytes)).toBe('payment pay_8f2e91c0\n  /v1/payments/{{$scenario.ids.paymentId}}\n');
    expect(result.rewrites).toEqual([{ tier: 'exact', id: 'paymentId', line: 2 }]);
    expect(result.suggestions).toEqual([{ id: 'paymentId', line: 1 }]);
  });
});

describe('provenance files', () => {
  const entry: ProvenanceEntry = {
    source: 'promotion',
    capture: 'default/000001',
    promotedAt: '2026-10-05T09:12:40.031Z',
    digest: fileDigest(utf8Encode('{}')),
    review: 'pending',
    rewrites: [{ pointer: '/id', tier: 'exact', id: 'paymentId' }],
    suggestions: [],
    refusals: [],
    notes: [],
  };
  const document = (files: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    utf8Encode(JSON.stringify({ format: PROVENANCE_FORMAT, files, ...extra }));

  it('names an identity', () => {
    expect(parseProvenanceName('402.meta.json')).toEqual({ status: 402, variant: null, identity: '402' });
    expect(parseProvenanceName('402.declined.meta.json')).toMatchObject({ identity: '402.declined' });
    expect(parseProvenanceName('402.json')).toBeNull();
    expect(parseProvenanceName('999.meta.json')).toBeNull();
  });

  it('round-trips', () => {
    const bytes = serializeProvenance({ format: PROVENANCE_FORMAT, files: { '402.json': entry } });
    expect(text(bytes).endsWith('}\n')).toBe(true);
    expect(parseProvenance('402.meta.json', bytes)).toEqual({
      ok: true,
      document: { format: PROVENANCE_FORMAT, files: { '402.json': entry } },
    });
  });

  it.each([
    ['not JSON', utf8Encode('{')],
    ['an unknown format', utf8Encode(JSON.stringify({ format: 'janus.provenance.v9', files: {} }))],
    ['an unknown member', document({}, { extra: 1 })],
    ['an unknown entry member', document({ '402.json': { ...entry, value: 'pay_1' } })],
    ['an entry outside its identity', document({ '200.json': entry })],
    ['a bad digest', document({ '402.json': { ...entry, digest: 'md5:x' } })],
  ])('refuses %s', (_label, bytes) => {
    expect(parseProvenance('402.meta.json', bytes).ok).toBe(false);
  });

  it('loads into the snapshot: never served, pending counted, stale and invalid reported', () => {
    const tree = (files: Record<string, string | Uint8Array>): FixtureFiles =>
      new Map(
        Object.entries(files).map(([key, value]) => [key, typeof value === 'string' ? utf8Encode(value) : value]),
      );
    const meta = serializeProvenance({ format: PROVENANCE_FORMAT, files: { '402.json': entry } });
    const built = buildSnapshot(tree({ 'default/v1/p/POST/402.json': '{}', 'default/v1/p/POST/402.meta.json': meta }));
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    expect(built.warnings.map((warning) => warning.code)).toEqual(['promotions-pending']);
    expect(unreviewedPromotions(built.snapshot)).toEqual([
      expect.objectContaining({ code: 'promotion-unreviewed', path: 'default/v1/p/POST/402.json' }),
    ]);

    const stale = buildSnapshot(tree({ 'default/v1/p/POST/201.json': '{}', 'default/v1/p/POST/402.meta.json': meta }));
    expect(stale.ok && stale.warnings.map((warning) => warning.code)).toContain('stale-provenance');

    const invalid = buildSnapshot(tree({ 'default/v1/p/POST/402.json': '{}', 'default/v1/p/POST/402.meta.json': '{' }));
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.errors.map((error) => error.code)).toEqual(['invalid-provenance']);
  });
});

// --- The promoter against in-memory ports ---------------------------------------------------------------

const STAGING = 'https://staging.api.example.test';
const ENDPOINTS: readonly RecordingEndpoint[] = [{ method: 'POST', path: '/v1/payments', upstream: STAGING }];
const BASE = {
  'default/v1/payments/POST/201.json': '{"status":"paid"}',
  'declined/flow.yaml': 'description: Declined\nids:\n  paymentId: pay_declined_1\noverrides:\n  - /v1/payments/POST\n',
};

function harness(
  files: Readonly<Record<string, string>> = BASE,
  options: { beforeApply?: () => void; response?: UpstreamResponse; config?: Partial<EngineConfig> } = {},
) {
  const tree = new Map<string, Uint8Array>(Object.entries(files).map(([key, value]) => [key, utf8Encode(value)]));
  const captures = new Map<string, CapturePlan>();
  const writes: WritePlan[] = [];
  const build = () => {
    const built = buildSnapshot(new Map(tree));
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    return built.snapshot;
  };
  let next = 0;
  const response: UpstreamResponse = options.response ?? {
    kind: 'response',
    status: 402,
    headers: [
      ['Content-Type', 'application/json'],
      ['Location', '/v1/payments/pay_8f2e91c0'],
    ],
    body: utf8Encode('{"id":"pay_8f2e91c0","status":"declined"}'),
  };
  const recording: RecordingPorts = {
    upstream: { send: () => Promise.resolve(response) },
    captures: {
      claim: (scenario) => Promise.resolve({ scenario, exchange: String(++next).padStart(6, '0') }),
      write: (reservation, plan) => {
        captures.set(`${reservation.scenario}/${reservation.exchange}`, plan);
        return Promise.resolve({ ok: true });
      },
      fail: () => Promise.resolve(),
    },
  };
  const fixtures: FixtureWriter = {
    read: () => Promise.resolve(new Map(tree)),
    apply: (plan) => {
      options.beforeApply?.();
      for (const check of plan.checks ?? []) {
        const current = tree.get(check.path.join('/'));
        if (current === undefined || fileDigest(current) !== check.digest)
          return Promise.resolve({ outcome: 'conflict' as const, files: [check.path.join('/')] });
      }
      writes.push(plan);
      for (const file of plan.files) {
        const key = file.path.join('/');
        const current = tree.get(key);
        const holds =
          file.precondition.kind === 'absent'
            ? current === undefined
            : current !== undefined && fileDigest(current) === file.precondition.digest;
        if (!holds) return Promise.resolve({ outcome: 'conflict' as const, files: [key] });
      }
      for (const file of plan.files) tree.set(file.path.join('/'), file.bytes);
      return Promise.resolve({ outcome: 'written' as const });
    },
  };
  const engine = createEngine({
    snapshot: build(),
    clock: () => Date.UTC(2026, 9, 5, 9),
    randomBytes: (count) => new Uint8Array(count).fill(7),
    config: {
      recording: { endpoints: ENDPOINTS, maxConcurrent: 4, timeoutMs: 30000, maxResponseBytes: 4096 },
      ...options.config,
    },
    recording,
    promotion: {
      fixtures,
      captures: {
        exchange: (scenario, exchange) => {
          const plan = captures.get(`${scenario}/${exchange}`);
          if (plan === undefined) return Promise.resolve(null);
          return Promise.resolve({
            entry: plan.log,
            files: new Map(plan.files.map((file) => [file.name, file.bytes])),
          });
        },
      },
      reload: () => {
        const snapshot = build();
        engine.replaceSnapshot(snapshot);
        return Promise.resolve({
          outcome: 'swapped',
          triggers: ['promotion'],
          finishedAt: '2026-10-05T09:00:00.000Z',
          activeSnapshotVersion: engine.snapshot().version,
          candidateSnapshotVersion: engine.snapshot().version,
          errors: [],
          warnings: [],
        } satisfies AtlasReloadResult);
      },
    },
  });
  const record = (scenario = 'declined'): Promise<unknown> =>
    engine.resolve({
      method: 'POST',
      target: '/v1/payments',
      headers: { 'x-mock-record': ['true'], 'x-mock-scenario': [scenario] },
      body: utf8Encode('{}'),
    } satisfies RequestDescription);
  const promote = (body: unknown): Promise<PromotionAnswer> =>
    engine.promotions.promote({ 'content-type': ['application/json'] }, utf8Encode(JSON.stringify(body)));
  const review = (body: unknown): Promise<PromotionAnswer> =>
    engine.promotions.review({ 'content-type': ['application/json'] }, utf8Encode(JSON.stringify(body)));
  const read = (key: string): string => text(tree.get(key));
  const set = (key: string, value: string): void => {
    tree.set(key, utf8Encode(value));
    engine.replaceSnapshot(build());
  };
  const createScenario = (body: unknown, headers: HeaderMap = { 'content-type': ['application/json'] }) =>
    engine.promotions.createScenario(headers, utf8Encode(typeof body === 'string' ? body : JSON.stringify(body)));
  return { engine, tree, writes, record, promote, review, read, set, createScenario };
}

const RESPONSE = 'declined/v1/payments/POST/402.json';
const FILE = '/v1/payments/POST/402.json';
const failure = (answer: PromotionAnswer) =>
  answer.ok ? { status: answer.status } : { status: answer.status, code: answer.code, details: answer.details };

describe('promotion', () => {
  it('writes a captured non-ASCII header value to the sidecar as the text its bytes carry', async () => {
    // Captured values hold one character per byte, as undici gives them.
    const bytes = (text: string) => String.fromCharCode(...utf8Encode(text));
    const janus = harness(BASE, {
      response: {
        kind: 'response',
        status: 402,
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Note', bytes('café €')],
        ],
        body: utf8Encode('{"status":"declined"}'),
      },
    });
    await janus.record();
    expect(await janus.promote({ capture: 'declined/000001' })).toMatchObject({ ok: true, status: 201 });
    const sidecar = JSON.parse(janus.read('declined/v1/payments/POST/402.headers.json')) as Record<string, string>;
    expect(Object.values(sidecar)).toContain('café €');
  });

  it('writes the response, sidecar and provenance with rewritten IDs, then serves them', async () => {
    const janus = harness();
    await janus.record();
    const answer = await janus.promote({ capture: 'declined/000001', ids: { paymentId: 'pay_8f2e91c0' } });
    expect(answer).toMatchObject({ ok: true, status: 201 });
    expect(JSON.parse(janus.read(RESPONSE))).toEqual({ id: '{{$scenario.ids.paymentId}}', status: 'declined' });
    const meta = JSON.parse(janus.read('declined/v1/payments/POST/402.meta.json')) as {
      files: Record<string, ProvenanceEntry>;
    };
    expect(Object.keys(meta.files).sort()).toEqual(['402.headers.json', '402.json']);
    expect(meta.files['402.json']).toMatchObject({ capture: 'declined/000001', review: 'pending' });
    expect(JSON.stringify(meta)).not.toContain('pay_8f2e91c0');

    const served = await janus.engine.resolve({
      method: 'POST',
      target: '/v1/payments',
      headers: { 'x-mock-scenario': ['declined'] },
      body: utf8Encode('{}'),
    });
    expect(served.status).toBe(402);
    expect(JSON.parse(text(served.body))).toEqual({ id: 'pay_declined_1', status: 'declined' });
    expect(served.headers['location']).toEqual(['/v1/payments/pay_declined_1']);
    expect(served.trace.outcome).toMatchObject({
      fixture: { provenance: { capture: 'declined/000001', review: 'pending' } },
    });
  });

  it('promotes an edited body and edited headers, rewriting IDs in them and noting the edit', async () => {
    const janus = harness();
    await janus.record();
    const answer = await janus.promote({
      capture: 'declined/000001',
      ids: { paymentId: 'pay_8f2e91c0' },
      body: '{"id":"pay_8f2e91c0","status":"refused"}',
      headers: { 'Content-Type': 'application/json', 'X-Edited': ['one', 'two'] },
    });
    expect(answer).toMatchObject({ ok: true, status: 201 });
    expect(JSON.parse(janus.read(RESPONSE))).toEqual({ id: '{{$scenario.ids.paymentId}}', status: 'refused' });
    expect(JSON.parse(janus.read('declined/v1/payments/POST/402.headers.json'))).toEqual({
      'Content-Type': 'application/json',
      'X-Edited': ['one', 'two'],
    });
    const meta = JSON.parse(janus.read('declined/v1/payments/POST/402.meta.json')) as {
      files: Record<string, ProvenanceEntry>;
    };
    expect(meta.files['402.json']?.notes).toEqual([
      { code: 'edited-before-promotion', message: 'the body was edited before it was promoted' },
    ]);
    expect(meta.files['402.headers.json']?.notes).toEqual([
      { code: 'edited-before-promotion', message: 'the headers were edited before they were promoted' },
    ]);
    expect(failure(await janus.promote({ capture: 'declined/000001', body: 1 }))).toMatchObject({
      status: 400,
      code: 'invalid-request',
    });
    expect(failure(await janus.promote({ capture: 'declined/000001', headers: { 'Bad name': 'x' } }))).toMatchObject({
      status: 400,
      code: 'invalid-request',
    });
  });

  it('takes an edited response as large as recording.maxResponseBytes allows', async () => {
    const janus = harness();
    await janus.record();
    expect(janus.engine.promotions.bodyLimit).toBe(2 * 4096 + 64 * 1024);
    const body = JSON.stringify({ id: 'pay_8f2e91c0', pad: 'x'.repeat(70 * 1024) });
    // The dry run shows the edited text whole.
    expect(await janus.promote({ capture: 'declined/000001', body, dryRun: true })).toMatchObject({
      ok: true,
      document: {
        files: expect.arrayContaining([
          expect.objectContaining({
            role: 'response',
            preview: expect.objectContaining({ truncated: false }) as unknown,
          }),
        ]) as unknown,
      },
    });
    expect(
      failure(await janus.promote({ capture: 'declined/000001', body: 'x'.repeat(janus.engine.promotions.bodyLimit) })),
    ).toMatchObject({ status: 413, code: 'request-too-large' });
  });

  it('refuses a promoted file without replace, and replaces it when named', async () => {
    const janus = harness();
    await janus.record();
    await janus.record();
    await janus.promote({ capture: 'declined/000001' });
    expect(failure(await janus.promote({ capture: 'declined/000002' }))).toMatchObject({
      status: 409,
      code: 'promotion-conflict',
      details: {
        conflicts: expect.arrayContaining([
          expect.objectContaining({ file: FILE, kind: 'promoted', reason: 'exists' }),
        ]) as unknown,
      },
    });
    const replaced = await janus.promote({
      capture: 'declined/000002',
      replace: [{ file: FILE }, { file: '/v1/payments/POST/402.headers.json' }],
    });
    expect(replaced).toMatchObject({ ok: true, status: 201 });
  });

  it('protects modified and hand-written files unless named with their current digest', async () => {
    const janus = harness();
    await janus.record();
    await janus.record();
    await janus.promote({ capture: 'declined/000001' });
    janus.set(RESPONSE, '{"edited":true}');
    const current = fileDigest(utf8Encode('{"edited":true}'));
    const sidecar = { file: '/v1/payments/POST/402.headers.json' };

    expect(
      failure(await janus.promote({ capture: 'declined/000002', replace: [{ file: FILE }, sidecar] })),
    ).toMatchObject({
      status: 409,
      details: { conflicts: [expect.objectContaining({ file: FILE, kind: 'modified', reason: 'modified' })] },
    });
    const wrong = fileDigest(utf8Encode('other'));
    expect(
      failure(await janus.promote({ capture: 'declined/000002', replace: [{ file: FILE, digest: wrong }, sidecar] })),
    ).toMatchObject({ status: 409, details: { conflicts: [expect.objectContaining({ reason: 'digest-mismatch' })] } });

    // A dry run reports the same conflict with 200 and applicable: false.
    const dry = await janus.promote({ capture: 'declined/000002', replace: [{ file: FILE }, sidecar], dryRun: true });
    expect(dry).toMatchObject({
      ok: true,
      status: 200,
      document: { applicable: false, conflicts: [expect.objectContaining({ file: FILE, kind: 'modified' })] },
    });

    expect(
      await janus.promote({ capture: 'declined/000002', replace: [{ file: FILE, digest: current }, sidecar] }),
    ).toMatchObject({ ok: true, status: 201 });

    const hand = harness({ ...BASE, [RESPONSE]: '{"hand":true}' });
    await hand.record();
    expect(failure(await hand.promote({ capture: 'declined/000001' }))).toMatchObject({
      status: 409,
      details: { conflicts: [expect.objectContaining({ file: FILE, kind: 'hand-written', reason: 'hand-written' })] },
    });
    const digest = fileDigest(utf8Encode('{"hand":true}'));
    expect(await hand.promote({ capture: 'declined/000001', replace: [{ file: FILE, digest }] })).toMatchObject({
      ok: true,
    });
  });

  it('refuses a stale replace entry with 400', async () => {
    const janus = harness();
    await janus.record();
    expect(
      failure(await janus.promote({ capture: 'declined/000001', replace: [{ file: '/v1/other/GET/200.json' }] })),
    ).toMatchObject({ status: 400, code: 'invalid-request' });
    expect(janus.writes).toEqual([]);
  });

  it('writes nothing when the result would be invalid', async () => {
    // default has its own payment answer; promoting a second status into a non-overriding child makes the
    // inherited endpoint ambiguous, which is reported with the overrides hint.
    const janus = harness({
      'default/v1/payments/POST/201.json': '{"status":"paid"}',
      'child/flow.yaml': 'description: Child\n',
    });
    await janus.record('child');
    const answer = failure(await janus.promote({ capture: 'child/000001' }));
    expect(answer).toMatchObject({ status: 422, code: 'promotion-invalid-tree' });
    expect(janus.writes).toEqual([]);
  });

  it('refuses a capture whose body was not stored', async () => {
    const janus = harness(BASE, {
      response: {
        kind: 'response',
        status: 402,
        headers: [
          ['Content-Type', 'application/json'],
          ['Content-Encoding', 'gzip'],
        ],
        body: new Uint8Array([31, 139, 8]),
      },
    });
    await janus.record();
    expect(failure(await janus.promote({ capture: 'declined/000001' }))).toMatchObject({
      status: 422,
      code: 'capture-body-unavailable',
    });
    expect(failure(await janus.promote({ capture: 'declined/000009' }))).toMatchObject({ status: 404 });
  });

  it('marks files reviewed when the digest matches, and refuses otherwise', async () => {
    const janus = harness();
    await janus.record();
    await janus.promote({ capture: 'declined/000001' });
    const digest = fileDigest(janus.tree.get(RESPONSE) ?? new Uint8Array());
    expect(
      failure(
        await janus.review({ scenario: 'declined', files: [{ file: FILE, digest: fileDigest(utf8Encode('x')) }] }),
      ),
    ).toMatchObject({
      status: 409,
    });
    expect(
      failure(await janus.review({ scenario: 'declined', files: [{ file: '/v1/other/GET/200.json', digest }] })),
    ).toMatchObject({
      status: 400,
      code: 'invalid-request',
    });
    expect(await janus.review({ scenario: 'declined', files: [{ file: FILE, digest }] })).toMatchObject({
      ok: true,
      status: 200,
    });
    const meta = JSON.parse(janus.read('declined/v1/payments/POST/402.meta.json')) as {
      files: Record<string, ProvenanceEntry>;
    };
    expect(meta.files['402.json']).toMatchObject({ review: 'reviewed', reviewedAt: '2026-10-05T09:00:00Z' });
    expect(meta.files['402.headers.json']?.review).toBe('pending');
    expect(janus.engine.atlas.promotions().items.map((item) => [item.file, item.review])).toEqual(
      expect.arrayContaining([
        [FILE, 'reviewed'],
        ['/v1/payments/POST/402.headers.json', 'pending'],
      ]),
    );
  });

  it('promotes automatically in auto mode and says so in X-Mock-Promoted', async () => {
    const janus = harness(BASE, { config: { promotionMode: 'auto' } });
    const first = (await janus.record()) as { headers: Record<string, string[]> };
    expect(first.headers['x-mock-promoted']).toEqual(['promoted']);
    const second = (await janus.record()) as { headers: Record<string, string[]> };
    expect(second.headers['x-mock-promoted']).toEqual(['promoted']);
    janus.set(RESPONSE, '{"edited":true}');
    const third = (await janus.record()) as { headers: Record<string, string[]> };
    expect(third.headers['x-mock-promoted']).toEqual(['skipped']);
    expect(janus.read(RESPONSE)).toBe('{"edited":true}');
  });
});

describe('an invalid existing provenance file (review E3)', () => {
  it('refuses with 422 rather than overwriting its other entries', async () => {
    const janus = harness();
    await janus.record();
    await janus.record();
    await janus.promote({ capture: 'declined/000001' });
    const meta = 'declined/v1/payments/POST/402.meta.json';
    const broken = janus.read(meta).replace('"files"', '"files" oops');
    // Edited on disk; the reload that would report it has not happened yet.
    janus.tree.set(meta, utf8Encode(broken));
    for (const dryRun of [false, true]) {
      expect(
        failure(await janus.promote({ capture: 'declined/000002', replace: [{ file: FILE }], dryRun })),
      ).toMatchObject({
        status: 422,
        code: 'promotion-invalid-tree',
        details: { errors: [expect.objectContaining({ code: 'invalid-provenance', path: meta })] },
      });
    }
    expect(janus.read(meta)).toBe(broken);
  });
});

describe('write-time conflicts (review E2)', () => {
  it('names a file that appeared since the plan hand-written', async () => {
    let appear = false;
    const janus = harness(BASE, {
      beforeApply: () => {
        if (appear) janus.tree.set(RESPONSE, utf8Encode('{"new":true}'));
      },
    });
    await janus.record();
    appear = true;
    expect(failure(await janus.promote({ capture: 'declined/000001' }))).toMatchObject({
      status: 409,
      details: { conflicts: [{ file: FILE, kind: 'hand-written', reason: 'changed-on-disk' }] },
    });
    expect(janus.read(RESPONSE)).toBe('{"new":true}');
  });

  it('keeps the kind the plan found for a file replaced with its digest', async () => {
    let edit = false;
    const janus = harness(
      { ...BASE, [RESPONSE]: '{"hand":true}' },
      {
        beforeApply: () => {
          if (edit) janus.tree.set(RESPONSE, utf8Encode('{"again":true}'));
        },
      },
    );
    await janus.record();
    edit = true;
    const digest = fileDigest(utf8Encode('{"hand":true}'));
    expect(
      failure(await janus.promote({ capture: 'declined/000001', replace: [{ file: FILE, digest }] })),
    ).toMatchObject({
      status: 409,
      details: { conflicts: [{ file: FILE, kind: 'hand-written', reason: 'changed-on-disk' }] },
    });
  });
});

describe('review commit preconditions', () => {
  it('refuses an edit between reading the reviewed content and committing its provenance', async () => {
    let editDuringCommit = false;
    const janus = harness(BASE, {
      beforeApply: () => {
        if (editDuringCommit) janus.tree.set(RESPONSE, utf8Encode('{"unseen":true}'));
      },
    });
    await janus.record();
    await janus.promote({ capture: 'declined/000001' });
    const digest = fileDigest(janus.tree.get(RESPONSE) as Uint8Array);
    const metadata = janus.read('declined/v1/payments/POST/402.meta.json');
    editDuringCommit = true;
    const answer = await janus.review({ scenario: 'declined', files: [{ file: FILE, digest }] });
    expect(failure(answer)).toMatchObject({
      status: 409,
      code: 'promotion-conflict',
      details: {
        conflicts: [{ file: FILE, reason: 'changed-on-disk' }],
      },
    });
    expect(janus.read(RESPONSE)).toBe('{"unseen":true}');
    expect(janus.read('declined/v1/payments/POST/402.meta.json')).toBe(metadata);
  });
});

describe('creating a scenario', () => {
  it('writes flow.yaml extending the default scenario, then has it in the snapshot', async () => {
    const janus = harness(BASE, { config: { defaultScenario: 'declined' } });
    const answer = await janus.createScenario({ name: 'sold-out' });
    expect(answer).toMatchObject({ ok: true, status: 201, document: { name: 'sold-out', extends: 'declined' } });
    expect(janus.read('sold-out/flow.yaml')).toBe('extends: declined\n');
    expect(janus.engine.atlas.scenarios().items.map((item) => item.name)).toContain('sold-out');
    const child = await janus.createScenario({ name: 'sold-out-en', extends: 'sold-out' });
    expect(child).toMatchObject({ ok: true, document: { extends: 'sold-out' } });
  });

  it('refuses a malformed body, a bad name, an existing scenario and an unknown parent', async () => {
    const janus = harness();
    for (const body of ['{', '[]', { name: 1 }, { name: 'a', extends: 2 }, { name: 'a', other: true }]) {
      expect(await janus.createScenario(body)).toMatchObject({ ok: false, status: 400, code: 'atlas-invalid-request' });
    }
    expect(await janus.createScenario({ name: 'a' }, { 'content-type': ['text/plain'] })).toMatchObject({
      status: 415,
      code: 'unsupported-media-type',
    });
    expect(await janus.createScenario({ name: 'Sold Out' })).toMatchObject({
      status: 422,
      code: 'scenario-invalid-name',
    });
    expect(await janus.createScenario({ name: 'declined' })).toMatchObject({ status: 409, code: 'scenario-exists' });
    expect(await janus.createScenario({ name: 'x', extends: 'nope' })).toMatchObject({
      status: 422,
      code: 'unknown-scenario',
    });
    // A directory the snapshot does not list as a scenario is not taken over.
    janus.tree.set('hidden/.janus-1.tmp', utf8Encode(''));
    expect(await janus.createScenario({ name: 'hidden' })).toMatchObject({ status: 409, code: 'scenario-exists' });
    expect(janus.writes).toEqual([]);
  });

  it('is unavailable exactly when promotion is', async () => {
    const engine = createEngine({
      snapshot: (() => {
        const built = buildSnapshot(new Map([['default/v1/a/GET/200.json', utf8Encode('{}')]]));
        if (!built.ok) throw new Error('invalid');
        return built.snapshot;
      })(),
    });
    expect(
      await engine.promotions.createScenario(
        { 'content-type': ['application/json'] },
        utf8Encode(JSON.stringify({ name: 'a' })),
      ),
    ).toMatchObject({ ok: false, status: 501, code: 'promotion-unavailable' });
  });
});
