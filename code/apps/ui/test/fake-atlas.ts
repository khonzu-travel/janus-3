/**
 * An in-memory stand-in for the Atlas HTTP API, used as the
 * client's `fetch` in UI tests. Documents follow the wire contract exactly.
 */

export const V1 = 'aaaaaaaaaaaaaaaa';
export const V2 = 'bbbbbbbbbbbbbbbb';
export const DIGEST = 'cfg_0123456789abcdef';

/** The effective configuration the fake reports by default: running on defaults. */
export const DEFAULT_CONFIG = {
  configDigest: DIGEST,
  configFile: false,
  settings: [
    { key: 'limits.maxBodyBytes', value: 1048576, source: 'default' },
    { key: 'limits.maxHeaderBytes', value: 16384, source: 'default' },
    { key: 'limits.maxUrlBytes', value: 8192, source: 'default' },
    { key: 'onUnknownMethod', value: 405, source: 'default' },
    { key: 'server.strictTrailingSlash', value: true, source: 'default' },
  ],
};

/** The `/_janus/clock` document the fake reports by default. */
export const DEFAULT_CLOCK = {
  now: '2026-01-01T00:00:00Z',
  mode: 'frozen',
  source: 'server-default',
  timezone: 'UTC',
  seed: 42,
  seedSource: 'cli',
  serverDefault: { now: '2026-01-01T00:00:00Z', mode: 'frozen' },
};

type Doc = Record<string, unknown>;

interface EndpointSpec {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly fixtures: readonly FixtureSpec[];
  /** Templates, representation groups and accepts. */
  readonly variations?: { readonly pathParameters: readonly string[]; readonly accepts: Doc | null };
  /** The `controls` document, when the endpoint has control files. */
  readonly controls?: Doc;
}

interface FixtureSpec {
  readonly id: string;
  readonly status: number;
  readonly mediaType: string | null;
  readonly locale: string | null;
  readonly headers: readonly Doc[];
  readonly preview: Doc;
  /** The Content-Type sent, when a sidecar overrides it. */
  readonly wireContentType?: string;
  /** Token annotations, and the `rendered` document for `view=rendered`. */
  readonly rendering?: {
    readonly tokens: readonly Doc[];
    readonly render: (now: string | null, params: Readonly<Record<string, string>>) => Doc | Response;
  };
}

const utf8 = (value: string): Doc => ({
  state: 'available',
  encoding: 'utf8',
  value,
  byteLength: new TextEncoder().encode(value).length,
  truncated: false,
});

export const ENDPOINTS: readonly EndpointSpec[] = [
  {
    id: 'ep_0000000000000001',
    method: 'GET',
    path: '/v1/greeting',
    fixtures: [
      {
        id: 'fx_0000000000000021',
        status: 200,
        mediaType: 'text/plain',
        locale: null,
        headers: [{ name: 'content-type', value: 'text/plain' }],
        preview: utf8('Hi'),
      },
      {
        id: 'fx_0000000000000022',
        status: 200,
        mediaType: 'text/plain',
        locale: 'fr',
        headers: [
          { name: 'content-language', value: 'fr' },
          { name: 'content-type', value: 'text/plain' },
        ],
        preview: utf8('Bonjour'),
      },
    ],
  },
  {
    id: 'ep_0000000000000002',
    method: 'GET',
    path: '/v1/logo',
    fixtures: [
      {
        id: 'fx_0000000000000031',
        status: 200,
        mediaType: 'image/png',
        locale: null,
        headers: [{ name: 'content-type', value: 'image/png' }],
        preview: { state: 'available', encoding: 'base64', value: 'iVBORw==', byteLength: 4, truncated: false },
      },
    ],
  },
  {
    id: 'ep_0000000000000003',
    method: 'GET',
    path: '/v1/page',
    fixtures: [
      {
        id: 'fx_0000000000000041',
        status: 200,
        mediaType: 'text/html',
        locale: null,
        headers: [{ name: 'content-type', value: 'text/html' }],
        preview: { ...utf8('<b id="injected">bold</b>'), truncated: true, byteLength: 70_000 },
      },
    ],
  },
  {
    id: 'ep_0000000000000004',
    method: 'GET',
    path: '/v1/products',
    fixtures: [
      {
        id: 'fx_0000000000000011',
        status: 200,
        mediaType: 'application/json',
        locale: null,
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'set-cookie', value: 'session=example' },
          { name: 'x-example', value: 'fixture' },
        ],
        preview: utf8('[{"id":"p-1"}]'),
      },
    ],
  },
  {
    id: 'ep_0000000000000005',
    method: 'DELETE',
    path: '/v1/products/p-1',
    fixtures: [
      {
        id: 'fx_0000000000000051',
        status: 204,
        mediaType: null,
        locale: null,
        headers: [],
        preview: { state: 'unavailable', reason: 'bodyless' },
      },
    ],
  },
];

/** An endpoint: a path template, two media types, an override, a dropped header and accepts.yaml. */
export const PRODUCT_BY_ID: EndpointSpec = {
  id: 'ep_0000000000000006',
  method: 'GET',
  path: '/v1/products/{productId}',
  variations: {
    pathParameters: ['productId'],
    accepts: { mediaTypes: ['application/json'], allowMissingContentType: null },
  },
  fixtures: [
    {
      id: 'fx_0000000000000061',
      status: 200,
      mediaType: 'application/json',
      wireContentType: 'text/plain; charset=utf-8',
      locale: null,
      headers: [
        { name: 'content-type', value: 'text/plain; charset=utf-8', treatment: 'replayed' },
        { name: 'vary', value: 'Accept', treatment: 'replayed' },
        { name: 'date', value: 'Mon, 01 Jan 2001 00:00:00 GMT', treatment: 'dropped' },
      ],
      preview: utf8('{"id":"any","tags":["a"]}'),
    },
    {
      id: 'fx_0000000000000062',
      status: 200,
      mediaType: 'application/yaml',
      locale: null,
      headers: [{ name: 'content-type', value: 'application/yaml', treatment: 'replayed' }],
      preview: utf8('id: any\n'),
    },
    {
      id: 'fx_0000000000000063',
      status: 200,
      mediaType: 'application/json',
      locale: 'fr',
      headers: [{ name: 'content-type', value: 'application/json', treatment: 'replayed' }],
      preview: utf8('{"id":"tout"}'),
    },
  ],
};

const ORDER_RAW = '{"id":"{{$path.orderId}}","due":"{{$tomorrow}}","ref":"{{$uuid:unique}}"}';
const tokenAt = (expression: string, pointer: string, category: string, unique = false): Doc => {
  const start = ORDER_RAW.indexOf(`{{$${expression}}}`);
  return {
    location: 'body',
    pointer,
    header: null,
    expression,
    category,
    unique,
    span: { start, end: start + expression.length + 5 },
  };
};

/** An endpoint whose response has dynamic values; the fake "renders" it with a fixed recipe. */
export const DYNAMIC_ORDER: EndpointSpec = {
  id: 'ep_0000000000000007',
  method: 'GET',
  path: '/v1/orders/{orderId}',
  variations: { pathParameters: ['orderId'], accepts: null },
  fixtures: [
    {
      id: 'fx_0000000000000071',
      status: 200,
      mediaType: 'application/json',
      locale: null,
      headers: [{ name: 'content-type', value: 'application/json', treatment: 'replayed' }],
      preview: utf8(ORDER_RAW),
      rendering: {
        tokens: [
          tokenAt('path.orderId', '/id', 'request'),
          tokenAt('tomorrow', '/due', 'clock'),
          tokenAt('uuid:unique', '/ref', 'generator', true),
        ],
        render: (now, params) => {
          if (now !== null && !/^\d{4}-\d{2}-\d{2}T/.test(now)) {
            return envelope(
              400,
              'atlas-invalid-request',
              'Invalid Atlas request: "now" must be an RFC 3339 instant with an offset',
            );
          }
          const instant = now ?? '2026-01-01T00:00:00Z';
          const id = params['orderId'];
          const day = String(Number(instant.slice(8, 10)) + 1).padStart(2, '0');
          const idText = id === undefined ? 'null' : JSON.stringify(id);
          const due = `${instant.slice(0, 8)}${day}`;
          const value = `{"id":${idText},"due":"${due}","ref":"00000000-0000-4000-8000-000000000001"}`;
          const at = (text: string) => ({ start: value.indexOf(text), end: value.indexOf(text) + text.length });
          return {
            preview: utf8(value),
            headers: [{ name: 'content-type', value: 'application/json', treatment: 'replayed' }],
            instant,
            clockSource: now === null ? 'server-default' : 'caller',
            seed: 42,
            nondeterministic: true,
            unresolved: id === undefined ? ['path.orderId'] : [],
            spans: [at(idText), at(due), at('00000000-0000-4000-8000-000000000001')],
            error: null,
          };
        },
      },
    },
  ],
};

/** What the fake's explorer answers by default: the products fixture for GET /v1/products, else a 404. */
export function defaultExplanation(version: string, request: Doc): Doc {
  const matched = request['method'] === 'GET' && request['target'] === '/v1/products';
  return {
    snapshotVersion: version,
    response: matched
      ? {
          status: 200,
          headers: [
            { name: 'content-type', value: 'application/json' },
            { name: 'set-cookie', value: 'session=example' },
            { name: 'x-mock-identity', value: 'fx_0000000000000011' },
          ],
          body: utf8('[{"id":"p-1"}]'),
        }
      : {
          status: 404,
          headers: [{ name: 'content-type', value: 'application/json' }],
          body: utf8('{"error":{"code":"route-not-found","message":"No fixture matches"}}'),
        },
    trace: matched
      ? {
          snapshotVersion: version,
          scenario: 'default',
          normalizedPath: '/v1/products',
          outcome: { kind: 'matched', fixture: { path: 'default/v1/products/GET/200_{application-json}.json' } },
          route: { template: '/v1/products', params: {}, considered: ['/v1/products/p-1'] },
          negotiation: {
            mediaType: {
              requested: null,
              available: ['application/json'],
              selected: 'application/json',
              droppedRanges: [],
            },
          },
          headers: { identity: 'fx_0000000000000011', dropped: [], contentTypeOverride: null },
        }
      : {
          snapshotVersion: version,
          scenario: 'default',
          normalizedPath: String(request['target']),
          outcome: { kind: 'route-not-found' },
          route: { template: null, params: {}, considered: ['/v1'] },
        },
    fixture: matched
      ? {
          endpointId: 'ep_0000000000000004',
          fixtureId: 'fx_0000000000000011',
          detailHref: `fixtures/fx_0000000000000011?at=${version}`,
        }
      : null,
    notes: ['transport limits (413, 414, 431) are not simulated'],
  };
}

export const [GREETING, LOGO, PAGE, PRODUCTS, DELETE_PRODUCT] = ENDPOINTS as [
  EndpointSpec,
  EndpointSpec,
  EndpointSpec,
  EndpointSpec,
  EndpointSpec,
];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const envelope = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message, requestId: '00000000-0000-4000-8000-000000000000' } });

/**
 * A server with scenarios, as whole documents keyed the way the client
 * asks for them. When set, it answers health, `/scenarios`, `/endpoints`,
 * endpoint and fixture documents instead of `endpoints`.
 */
export interface ScenarioWorld {
  readonly configuredDefault: string;
  /** The `/_janus/scenarios` document, without `apiVersion`. */
  readonly scenarios: Doc;
  /** Inventory documents by scenario name. */
  readonly inventories: Readonly<Record<string, Doc>>;
  /** Endpoint documents by endpoint ID. */
  readonly endpoints: Readonly<Record<string, Doc>>;
  /** Fixture documents by fixture ID. */
  readonly fixtures: Readonly<Record<string, Doc>>;
}

export { json as jsonResponse, envelope as errorResponse };

export class FakeAtlas {
  /** Mount point of Atlas on the fake origin. */
  readonly root: string;
  version = V1;
  endpoints: readonly EndpointSpec[] = ENDPOINTS;
  /** When true, every request fails as if the server were down. */
  down = false;
  /** Paths (without origin) whose responses never arrive; they settle only when aborted. */
  readonly hold = new Set<string>();
  /** Overrides for the health document. */
  healthOverride: Doc | null = null;
  /** The `/_janus/config` document; null answers `404 route-not-found`. */
  config: Doc | null = DEFAULT_CONFIG;
  /** The `/_janus/clock` document; null answers `404 route-not-found`. */
  clock: Doc | null = DEFAULT_CLOCK;
  warnings: readonly Doc[] = [];
  /** `capabilities` in health; null leaves them out, like an older server. */
  capabilities: Doc | null = { resolve: true, reload: true, watch: false, events: true };
  /** `lastReload` in health. */
  lastReload: Doc | null = null;
  /** The `/_janus/reload` document; `{ outcome: null }` before the first reload. */
  reloadResult: Doc = { outcome: null };
  /** Answers `POST /_janus/resolve` from the parsed envelope; null answers 404, like an older server. */
  resolver: ((envelope: Doc) => Doc | Response) | null = (envelope) => defaultExplanation(this.version, envelope);
  /** Envelopes received by `POST /_janus/resolve`, in order. */
  readonly envelopes: Doc[] = [];
  /** Scenarios; null for a server with only `default`, which predates them. */
  world: ScenarioWorld | null = null;
  /** Answers checked before every other route, by path below the root (recording and captures); null passes. */
  extra: ((path: string, url: URL) => Response | null) | null = null;
  /** POST answers checked before `resolve`, by path below the root (promotions); null passes. */
  extraPost: ((path: string, body: Doc) => Response | null) | null = null;
  /** Pathname + search of every request, in order. */
  readonly requests: string[] = [];
  readonly aborted: string[] = [];

  constructor(root = 'http://janus.test/_janus/') {
    this.root = root;
  }

  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = url.pathname + url.search;
    this.requests.push(key);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
    if (this.hold.has(url.pathname)) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          this.aborted.push(key);
          reject(signal.reason as Error);
        });
      });
    }
    if (this.down) return Promise.reject(new TypeError('Failed to fetch'));
    if ((init?.method ?? 'GET') === 'POST') return Promise.resolve(this.post(url, init?.body));
    return Promise.resolve(this.respond(url));
  };

  private post(url: URL, body: unknown): Response {
    if (this.extraPost !== null && url.href.startsWith(this.root)) {
      const parsed = JSON.parse(typeof body === 'string' ? body : '{}') as Doc;
      const answer = this.extraPost(url.href.slice(this.root.length), parsed);
      if (answer !== null) return answer;
    }
    if (url.href !== `${this.root}resolve` || this.resolver === null) {
      return envelope(404, 'route-not-found', 'No fixture matches');
    }
    const parsed = JSON.parse(typeof body === 'string' ? body : '{}') as Doc;
    this.envelopes.push(parsed);
    const result = this.resolver(parsed);
    return result instanceof Response ? result : json(200, { apiVersion: 'atlas.v1', ...result });
  }

  private respond(url: URL): Response {
    if (!url.href.startsWith(this.root)) return new Response('<html>not janus</html>', { status: 404 });
    const extra = this.extra?.(url.pathname.slice(new URL(this.root).pathname.length), url) ?? null;
    if (extra !== null) return extra;
    const [resource, id, ...rest] = url.href.slice(this.root.length).split('?')[0]?.split('/') ?? [];
    if (rest.length > 0) return envelope(404, 'route-not-found', 'No fixture matches');
    const world = this.world;
    if (world !== null) {
      const answer = this.respondInWorld(world, url, resource, id);
      if (answer !== null) return answer;
    }
    if (resource === 'health' && id === undefined) {
      const count = this.endpoints.length;
      return json(200, {
        apiVersion: 'atlas.v1',
        status: 'ready',
        snapshot: this.version,
        snapshotVersion: this.version,
        fixtureCount: count,
        routeCount: new Set(this.endpoints.map((endpoint) => endpoint.path)).size,
        ...(this.config === null ? {} : { configDigest: this.config['configDigest'], warnings: this.warnings }),
        ...(this.capabilities === null ? {} : { capabilities: this.capabilities, lastReload: this.lastReload }),
        ...this.healthOverride,
      });
    }
    if (resource === 'config' && id === undefined) {
      if (this.config === null) return envelope(404, 'route-not-found', 'No fixture matches GET /_janus/config');
      return json(200, { apiVersion: 'atlas.v1', ...this.config });
    }
    if (resource === 'reload' && id === undefined && this.capabilities !== null) {
      return json(200, { apiVersion: 'atlas.v1', ...this.reloadResult });
    }
    if (resource === 'clock' && id === undefined) {
      if (this.clock === null) return envelope(404, 'route-not-found', 'No fixture matches GET /_janus/clock');
      return json(200, { apiVersion: 'atlas.v1', ...this.clock });
    }
    if (resource === 'endpoints' && id === undefined) {
      return json(200, {
        apiVersion: 'atlas.v1',
        snapshotVersion: this.version,
        items: this.endpoints.map((endpoint) => ({
          id: endpoint.id,
          scenario: 'default',
          method: endpoint.method,
          path: endpoint.path,
          ...(endpoint.variations === undefined ? {} : { pathParameters: endpoint.variations.pathParameters }),
          detailHref: `endpoints/${endpoint.id}?at=${this.version}`,
        })),
      });
    }
    const at = url.searchParams.getAll('at');
    if (at.length !== 1) return envelope(400, 'atlas-invalid-request', 'Invalid Atlas request');
    if (at[0] !== this.version) return envelope(409, 'atlas-snapshot-stale', 'The fixture snapshot changed');
    if (resource === 'endpoints') {
      const endpoint = this.endpoints.find((entry) => entry.id === id);
      if (endpoint === undefined) return envelope(404, 'atlas-resource-not-found', 'No endpoint');
      const summary = (fixture: FixtureSpec): Doc => ({
        id: fixture.id,
        status: fixture.status,
        mediaType: fixture.mediaType,
        ...(endpoint.variations === undefined ? {} : { wireContentType: fixture.wireContentType ?? fixture.mediaType }),
        locale: fixture.locale,
        byteLength: fixture.preview['byteLength'] ?? 0,
        headers: fixture.headers,
        detailHref: `fixtures/${fixture.id}?at=${this.version}`,
      });
      const groups: { status: number; locale: string | null; representations: Doc[] }[] = [];
      for (const fixture of endpoint.fixtures) {
        const group = groups.find((entry) => entry.status === fixture.status && entry.locale === fixture.locale);
        if (group === undefined)
          groups.push({ status: fixture.status, locale: fixture.locale, representations: [summary(fixture)] });
        else group.representations.push(summary(fixture));
      }
      return json(200, {
        apiVersion: 'atlas.v1',
        snapshotVersion: this.version,
        id: endpoint.id,
        scenario: 'default',
        method: endpoint.method,
        path: endpoint.path,
        fixtures: endpoint.fixtures.map(summary),
        ...(endpoint.variations === undefined
          ? {}
          : {
              pathParameters: endpoint.variations.pathParameters,
              representationGroups: groups,
              accepts: endpoint.variations.accepts,
            }),
        ...(endpoint.controls === undefined ? {} : { controls: endpoint.controls }),
      });
    }
    if (resource === 'fixtures') {
      for (const endpoint of this.endpoints) {
        const fixture = endpoint.fixtures.find((entry) => entry.id === id);
        if (fixture === undefined) continue;
        let rendered: Doc | undefined;
        if (url.searchParams.get('view') === 'rendered' && fixture.rendering !== undefined) {
          const params = Object.fromEntries(
            [...url.searchParams]
              .filter(([name]) => name.startsWith('param.'))
              .map(([name, value]) => [name.slice(6), value]),
          );
          const result = fixture.rendering.render(url.searchParams.get('now'), params);
          if (result instanceof Response) return result;
          rendered = result;
        }
        return json(200, {
          apiVersion: 'atlas.v1',
          snapshotVersion: this.version,
          id: fixture.id,
          status: fixture.status,
          mediaType: fixture.mediaType,
          ...(endpoint.variations === undefined
            ? {}
            : { wireContentType: fixture.wireContentType ?? fixture.mediaType }),
          locale: fixture.locale,
          byteLength: (fixture.preview['byteLength'] as number | undefined) ?? 0,
          headers: fixture.headers,
          endpointId: endpoint.id,
          scenario: 'default',
          method: endpoint.method,
          path: endpoint.path,
          ...(endpoint.variations === undefined ? {} : { pathParameters: endpoint.variations.pathParameters }),
          preview: fixture.preview,
          ...(fixture.rendering === undefined ? {} : { dynamic: true, tokens: fixture.rendering.tokens }),
          ...(rendered === undefined ? {} : { rendered }),
        });
      }
      return envelope(404, 'atlas-resource-not-found', 'No fixture');
    }
    return envelope(404, 'route-not-found', 'No fixture matches');
  }

  private respondInWorld(
    world: ScenarioWorld,
    url: URL,
    resource: string | undefined,
    id: string | undefined,
  ): Response | null {
    const items = world.scenarios['items'] as readonly Doc[];
    if (resource === 'health' && id === undefined) {
      const inventory = world.inventories[world.configuredDefault] ?? {};
      return json(200, {
        apiVersion: 'atlas.v1',
        status: 'ready',
        snapshot: this.version,
        snapshotVersion: this.version,
        fixtureCount: (inventory['items'] as unknown[] | undefined)?.length ?? 0,
        routeCount: 1,
        configDigest: DIGEST,
        warnings: [],
        scenarioCount: items.length,
        configuredDefaultScenario: world.configuredDefault,
        capabilities: { resolve: true, reload: true, watch: false, events: true, scenarios: true, sessions: true },
        lastReload: null,
      });
    }
    if (resource === 'scenarios' && id === undefined) {
      return json(200, { apiVersion: 'atlas.v1', ...world.scenarios });
    }
    if (resource === 'endpoints' && id === undefined) {
      const name = url.searchParams.get('scenario') ?? world.configuredDefault;
      const inventory = world.inventories[name];
      if (inventory === undefined) return envelope(404, 'atlas-resource-not-found', 'No scenario');
      return json(200, { apiVersion: 'atlas.v1', ...inventory });
    }
    if (resource === 'endpoints' || resource === 'fixtures') {
      if (url.searchParams.get('at') !== this.version) {
        return envelope(409, 'atlas-snapshot-stale', 'The fixture snapshot changed');
      }
      const document = (resource === 'endpoints' ? world.endpoints : world.fixtures)[id ?? ''];
      if (document === undefined) return envelope(404, 'atlas-resource-not-found', 'Not found');
      return json(200, { apiVersion: 'atlas.v1', ...document });
    }
    return null;
  }
}
