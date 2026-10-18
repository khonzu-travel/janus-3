import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { buildSnapshot, parseConfig, type EngineConfig, type RecordingEndpoint } from '@janus/core';
import { readFixtureDirectory } from '@janus/fixtures-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureStore } from './captures.js';
import { main, type CliEnvironment } from './main.js';
import { startServer, type RunningServer, type ServeLogger } from './serve.js';

// Recording against a local fake upstream.

let root: string;
let servers: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-recording-'));
  servers = [];
});

afterEach(async () => {
  for (const server of servers.reverse()) await server.close();
  await rm(root, { recursive: true, force: true });
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly rawHeaders: string[];
  readonly body: string;
  readonly bytes: Buffer;
}

/** A fake upstream that records what it receives and answers with `handler`. */
async function fakeUpstream(
  handler: (request: Seen, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; seen: Seen[]; connections: () => number }> {
  const seen: Seen[] = [];
  let connections = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
        bytes: Buffer.concat(chunks),
      };
      seen.push(entry);
      void handler(entry, response);
    });
  });
  server.on('connection', () => {
    connections++;
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  servers.push({
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  });
  return { url: `http://127.0.0.1:${String(port)}`, seen, connections: () => connections };
}

/** One request with header lines in the given order, and a body on any method; fetch allows neither. */
function send(
  url: string,
  method: string,
  lines: readonly (readonly [string, string])[],
  body?: string | Buffer,
): Promise<{ status: number; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const framing = body === undefined ? [] : ['content-length', String(Buffer.byteLength(body))];
    // Node adds no Host to header lines given as an array.
    const headers = ['host', new URL(url).host, ...lines.flat(), ...framing];
    const outgoing = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          rawHeaders: response.rawHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function writeTree(base: string, tree: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(base, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

const TREE = {
  'default/v1/products/{productId}/GET/200.json': '{"from":"fixture"}',
  'default/v1/payments/POST/201.json': '{"from":"fixture"}',
  'payment-declined/flow.yaml': 'description: Declined\n',
};

const logs: string[] = [];
const logger: ServeLogger = {
  info: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
  error: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
};

async function janus(
  endpoints: readonly RecordingEndpoint[],
  options: {
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxConcurrent?: number;
    diagnosticHeaders?: boolean;
    extraCaCerts?: readonly string[];
    skipTlsVerify?: boolean;
  } = {},
): Promise<{ server: RunningServer; captures: string }> {
  const data = join(root, 'data');
  const captures = join(root, 'captures');
  await writeTree(data, TREE);
  await mkdir(captures, { recursive: true });
  const read = await readFixtureDirectory(data);
  if (!read.ok) throw new Error('unreadable');
  const built = buildSnapshot(read.files);
  if (!built.ok) throw new Error('invalid');
  const engine: Partial<EngineConfig> = {
    seed: 1,
    diagnosticHeaders: options.diagnosticHeaders ?? true,
    recording: {
      endpoints,
      timeoutMs: options.timeoutMs ?? 5000,
      maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024,
      maxConcurrent: options.maxConcurrent ?? 16,
    },
  };
  const result = await startServer(
    {
      dataRoot: data,
      host: '127.0.0.1',
      port: 0,
      snapshot: built.snapshot,
      engine,
      captures,
      shutdownTimeoutMs: 1000,
      ...(options.extraCaCerts === undefined ? {} : { extraCaCerts: options.extraCaCerts }),
      ...(options.skipTlsVerify === undefined ? {} : { skipTlsVerify: options.skipTlsVerify }),
    },
    logger,
  );
  if (!result.ok) throw new Error('not started');
  servers.push(result.server);
  return { server: result.server, captures };
}

// A self-signed certificate for 127.0.0.1, valid until 2126, used only by these tests.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUbVIOupriL24BP5H4f5qC5ujXtM0wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAxNjA0NDkyMFoYDzIxMjYwOTIy
MDQ0OTIwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATdNM0Ah9WnUjyn4jhErPpvSwp6Y6hLwccITrRzM06ikaMmZwvahDWQ
Xx1TkK+7t2LyYmD6cPkZXesv8mvDV6E/o28wbTAdBgNVHQ4EFgQUBKAE3JEqtLza
7C87cUS43gbxCS4wHwYDVR0jBBgwFoAUBKAE3JEqtLza7C87cUS43gbxCS4wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZI
zj0EAwIDRwAwRAIgCKCjER8fxNCvKe5egP4dwwOqMdjcAb3M9nwY6DPBcNMCIDE/
A7i/wJzBmCO1QVjwh2BRk6hc+K0vpsC/PTLG3cFu
-----END CERTIFICATE-----`;
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGiRNqz9+nKH9DPSL
40ZTK1XjA0N7y0G12WvgTaqohlahRANCAATdNM0Ah9WnUjyn4jhErPpvSwp6Y6hL
wccITrRzM06ikaMmZwvahDWQXx1TkK+7t2LyYmD6cPkZXesv8mvDV6E/
-----END PRIVATE KEY-----`;

/** An HTTPS upstream on 127.0.0.1 with the self-signed certificate, answering 200 "secure". */
async function selfSignedUpstream(): Promise<string> {
  const server = createHttpsServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('secure');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  servers.push({
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  });
  return `https://127.0.0.1:${String(port)}`;
}

const record = (extra: Record<string, string> = {}): Record<string, string> => ({
  'x-mock-record': 'true',
  'x-mock-scenario': 'payment-declined',
  ...extra,
});

async function exchanges(captures: string, scenario: string): Promise<string[]> {
  return (await readdir(join(captures, scenario)).catch(() => [])).filter((name) => /^\d{6}$/.test(name)).sort();
}

async function logLines(captures: string, scenario: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(captures, scenario, 'log.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('recording through the server', () => {
  it('forwards the request as sent, relays the response unchanged and captures it literally', async () => {
    const body = '{"echo":true,"card":"4000000000000002"}';
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(402, [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'sid=up; Path=/'],
        ['Strict-Transport-Security', 'max-age=60'],
        ['Access-Control-Allow-Origin', '*'],
        ['WWW-Authenticate', 'Bearer error="insufficient_scope"'],
        ['X-Mock-Identity', 'fx_spoofed'],
        ['Request-Id', 'req_1'],
      ]);
      response.end(body);
    });
    const { server, captures } = await janus([
      { method: 'POST', path: '/v1/payments/{paymentId}', upstream: `${upstream.url}/base/` },
    ]);
    const response = await fetch(`${server.url}/v1/payments/pay%201?attempt=1&x=%2F`, {
      method: 'POST',
      headers: record({
        authorization: 'Bearer test-token',
        cookie: 'session=abc',
        'content-type': 'application/json',
        forwarded: 'for=1.2.3.4',
        via: '1.1 proxy',
        'x-forwarded-for': '1.2.3.4',
        'accept-encoding': 'gzip',
      }),
      body: '{"card":{"number":"4000000000000002"}}',
    });
    expect(response.status).toBe(402);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('x-mock-recorded')).toBe('payment-declined/000001');
    expect(response.headers.get('x-mock-scenario')).toBe('payment-declined');
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope"');
    for (const name of ['set-cookie', 'strict-transport-security', 'access-control-allow-origin', 'x-mock-identity']) {
      expect(response.headers.get(name)).toBeNull();
    }

    expect(upstream.seen).toHaveLength(1);
    const seen = upstream.seen[0];
    expect(seen?.url).toBe('/base/v1/payments/pay%201?attempt=1&x=%2F');
    expect(seen?.headers['authorization']).toBe('Bearer test-token');
    expect(seen?.headers['cookie']).toBe('session=abc');
    expect(seen?.headers['accept-encoding']).toBe('identity');
    expect(seen?.headers['host']).toBe(new URL(upstream.url).host);
    expect(seen?.body).toBe('{"card":{"number":"4000000000000002"}}');
    const names = Object.keys(seen?.headers ?? {});
    expect(names.filter((name) => /^(x-mock-|x-forwarded-|forwarded$|via$)/.test(name))).toEqual([]);

    const files = (await readdir(join(captures, 'payment-declined', '000001'))).sort();
    expect(files).toEqual(['402.headers.json', '402.json', '402.meta.json', 'request.json']);
    expect(await readFile(join(captures, 'payment-declined', '000001', '402.json'), 'utf8')).toBe(body);
    const sidecar = JSON.parse(
      await readFile(join(captures, 'payment-declined', '000001', '402.headers.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sidecar['set-cookie']).toBe('sid=up; Path=/');
    expect(sidecar['access-control-allow-origin']).toBe('*');
    const requestFile = JSON.parse(
      await readFile(join(captures, 'payment-declined', '000001', 'request.json'), 'utf8'),
    ) as {
      params: unknown;
      headers: Record<string, string[]>;
      body: unknown;
    };
    expect(requestFile.params).toEqual({ paymentId: 'pay 1' });
    expect(requestFile.headers['authorization']).toEqual(['Bearer test-token']);
    expect(requestFile.body).toEqual({ encoding: 'utf8', data: '{"card":{"number":"4000000000000002"}}' });
    expect(await logLines(captures, 'payment-declined')).toEqual([
      expect.objectContaining({ exchange: '000001', outcome: 'captured', status: 402 }) as unknown,
    ]);
    const requestLog = logs.find((line) => line.startsWith('request ') && line.includes('"recording"'));
    expect(requestLog).toContain(`"upstream":"${upstream.url}"`);
    expect(requestLog).not.toContain('attempt');
  });

  it('forwards and captures a GET body (review X2)', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const response = await send(
      `${server.url}/v1/products/p-1`,
      'GET',
      [...Object.entries(record()), ['content-type', 'application/json']],
      '{"q":1}',
    );
    expect(response.status).toBe(200);
    expect(upstream.seen[0]?.body).toBe('{"q":1}');
    expect(upstream.seen[0]?.headers['content-length']).toBe('7');
    const requestFile = JSON.parse(
      await readFile(join(captures, 'payment-declined', '000001', 'request.json'), 'utf8'),
    ) as { body: unknown };
    expect(requestFile.body).toEqual({ encoding: 'utf8', data: '{"q":1}' });
  });

  it('forwards a compressed body as received and captures it decoded, with its codings', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const { server, captures } = await janus([{ method: 'POST', path: '/v1/payments', upstream: upstream.url }]);
    const gzip = gzipSync('{"q":1}');
    const response = await send(
      `${server.url}/v1/payments`,
      'POST',
      [...Object.entries(record()), ['content-type', 'application/json'], ['content-encoding', 'gzip']],
      gzip,
    );
    expect(response.status).toBe(200);
    expect(upstream.seen[0]?.bytes.equals(gzip)).toBe(true);
    expect(upstream.seen[0]?.headers['content-encoding']).toBe('gzip');
    const requestFile = JSON.parse(
      await readFile(join(captures, 'payment-declined', '000001', 'request.json'), 'utf8'),
    ) as { body: unknown; codings: unknown };
    expect(requestFile.body).toEqual({ encoding: 'utf8', data: '{"q":1}' });
    expect(requestFile.codings).toEqual(['gzip']);
    // Decoding still runs first: a corrupt body is refused before anything is forwarded.
    const corrupt = await send(
      `${server.url}/v1/payments`,
      'POST',
      [...Object.entries(record()), ['content-encoding', 'gzip']],
      'not gzip',
    );
    expect(corrupt.status).toBe(400);
    expect(upstream.seen).toHaveLength(1);
  });

  it("keeps Janus's own X-Janus-Request-Id over the upstream's (review D1)", async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-janus-request-id': 'upstream-id' });
      response.end('ok');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const response = await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    expect(response.headers.get('x-janus-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    // The capture stays literal.
    const sidecar = JSON.parse(
      await readFile(join(captures, 'payment-declined', '000001', '200.headers.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sidecar['x-janus-request-id']).toBe('upstream-id');
  });

  it.each<[string, [string, string][]]>([
    ['no Content-Type', []],
    ['an invalid Content-Type', [['Content-Type', 'text']]],
    [
      'a repeated Content-Type',
      [
        ['Content-Type', 'text/plain'],
        ['Content-Type', 'text/html'],
      ],
    ],
  ])("relays the upstream's header lines with %s unchanged (review D2)", async (_name, lines) => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, [...lines, ['X-Upstream', '1']]);
      response.end('ok');
    });
    const { server } = await janus([{ method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url }]);
    const response = await send(`${server.url}/v1/products/p-1`, 'GET', Object.entries(record()));
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
    const relayed: [string, string][] = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      relayed.push([response.rawHeaders[index] ?? '', response.rawHeaders[index + 1] ?? '']);
    }
    expect(relayed.filter(([name]) => name.toLowerCase() === 'content-type')).toEqual(
      lines.map(([name, value]) => [name.toLowerCase(), value]),
    );
  });

  it('forwards header lines in the order received (review D3)', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    await send(`${server.url}/v1/products/p-1`, 'GET', [
      ...Object.entries(record()),
      ['X-A', '1'],
      ['x-b', '2'],
      ['x-a', '3'],
    ]);
    const seen = upstream.seen[0]?.rawHeaders ?? [];
    const lines: string[] = [];
    for (let index = 0; index < seen.length; index += 2) {
      if (/^x-[ab]$/i.test(seen[index] ?? '')) lines.push(`${seen[index] ?? ''}:${seen[index + 1] ?? ''}`);
    }
    expect(lines).toEqual(['X-A:1', 'x-b:2', 'x-a:3']);
    // request.json groups lines by lower-cased name, in order of first appearance.
    const requestFile = JSON.parse(
      await readFile(join(captures, 'payment-declined', '000001', 'request.json'), 'utf8'),
    ) as { headers: Record<string, string[]> };
    const names = Object.keys(requestFile.headers).filter((name) => /^x-[ab]$/.test(name));
    expect(names).toEqual(['x-a', 'x-b']);
    expect(requestFile.headers['x-a']).toEqual(['1', '3']);
  });

  it('relays a redirect without following it', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(302, { location: '/elsewhere' });
      response.end();
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const response = await fetch(`${server.url}/v1/products/p-1`, { headers: record(), redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/elsewhere');
    expect(upstream.seen).toHaveLength(1);
    expect((await readdir(join(captures, 'payment-declined', '000001'))).sort()).toEqual([
      '302.bin',
      '302.headers.json',
      '302.meta.json',
      'request.json',
    ]);
  });

  it('relays an encoded body unchanged and stores it empty', async () => {
    const gzipped = gzipSync('{"a":1}');
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      response.end(gzipped);
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const response = await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"a":1}');
    const meta = JSON.parse(await readFile(join(captures, 'payment-declined', '000001', '200.meta.json'), 'utf8')) as {
      notes: { code: string }[];
    };
    expect(meta.notes.map((note) => note.code)).toEqual(['body-encoded']);
    expect(await readFile(join(captures, 'payment-declined', '000001', '200.json'), 'utf8')).toBe('');
  });

  it('answers 403 without any connection for an unregistered request', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.end('x');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const response = await fetch(`${server.url}/v1/payments`, { method: 'POST', headers: record() });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('recording-not-allowed');
    expect(upstream.connections()).toBe(0);
    expect(await readdir(captures)).toEqual([]);
    const plain = await fetch(`${server.url}/v1/products/p-1`);
    expect(await plain.text()).toBe('{"from":"fixture"}');
  });

  it.each([
    ['nothing configured', {}, 502],
    ['the certificate in extraCaCerts', { extraCaCerts: [SELF_SIGNED_CERT] }, 200],
    ['skipTlsVerify', { skipTlsVerify: true }, 200],
  ] as const)('records from a self-signed upstream with %s', async (_name, options, status) => {
    const upstream = await selfSignedUpstream();
    const { server } = await janus([{ method: 'GET', path: '/v1/products/{productId}', upstream }], options);
    const response = await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    expect(response.status).toBe(status);
    if (status === 200) expect(await response.text()).toBe('secure');
    else expect(((await response.json()) as { error: { reason: string } }).error.reason).toBe('certificate');
  });

  it('maps a refused connection and a DNS failure to 502 and logs them', async () => {
    const closed = createNetServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const address = closed.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((done) => {
      closed.close(() => {
        done();
      });
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: `http://127.0.0.1:${String(port)}` },
      { method: 'POST', path: '/v1/payments', upstream: 'http://janus-no-such-host.invalid' },
    ]);
    logs.length = 0;
    const refused = await fetch(`${server.url}/v1/products/p-1?token=secret`, { headers: record() });
    expect(refused.status).toBe(502);
    const refusedError = ((await refused.json()) as { error: { code: string; message: string; reason: string } }).error;
    expect(refusedError).toMatchObject({
      code: 'recording-upstream-failed',
      message: 'The upstream could not be reached: the connection was refused; nothing was received from it',
      reason: 'refused',
    });
    expect(JSON.stringify(refusedError)).not.toContain('ECONNREFUSED');
    const dns = await fetch(`${server.url}/v1/payments`, { method: 'POST', headers: record() });
    expect(dns.status).toBe(502);
    expect(((await dns.json()) as { error: { reason: string } }).error.reason).toBe('dns');
    expect(await logLines(captures, 'payment-declined')).toEqual([
      expect.objectContaining({ exchange: '000001', outcome: 'upstream-failed', reason: 'refused' }) as unknown,
      expect.objectContaining({ exchange: '000002', outcome: 'upstream-failed', reason: 'dns' }) as unknown,
    ]);
    // The server log alone carries the error text, and never the query.
    const failed = logs.filter((line) => line.startsWith('upstream-failed '));
    expect(failed).toHaveLength(2);
    expect(failed[0]).toContain('"reason":"refused","code":"ECONNREFUSED"');
    expect(failed[0]).toContain('"path":"/v1/products/p-1"');
    expect(failed[0]).toMatch(/"error":"[^"]*ECONNREFUSED/);
    expect(failed[0]).not.toContain('secret');
    expect(failed[1]).toContain('"reason":"dns"');
    expect(logs.find((line) => line.startsWith('request ') && line.includes('"reason":"refused"'))).toBeDefined();
    expect(await readdir(join(captures, 'payment-declined', '000001'))).toEqual([]);
  });

  it('maps a slow upstream to 504 and a large body to 502', async () => {
    const upstream = await fakeUpstream((request, response) => {
      if (request.url.includes('slow')) return;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(2048));
    });
    const { server, captures } = await janus(
      [{ method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url }],
      { timeoutMs: 1000, maxResponseBytes: 1024 },
    );
    const slow = await fetch(`${server.url}/v1/products/slow`, { headers: record() });
    expect(slow.status).toBe(504);
    const large = await fetch(`${server.url}/v1/products/large`, { headers: record() });
    expect(large.status).toBe(502);
    expect(((await large.json()) as { error: { code: string } }).error.code).toBe('recording-response-too-large');
    expect((await logLines(captures, 'payment-declined')).map((line) => line['outcome'])).toEqual([
      'upstream-timeout',
      'response-too-large',
    ]);
  });

  it.each([0, 10])(
    'relays and captures a 304 with Content-Length above the %i-byte body limit',
    async (maxResponseBytes) => {
      const upstream = await fakeUpstream((_request, response) => {
        response.writeHead(304, { 'content-length': '10000', etag: '"unchanged"' });
        response.end();
      });
      const { server, captures } = await janus(
        [{ method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url }],
        { maxResponseBytes },
      );
      const response = await fetch(`${server.url}/v1/products/a`, { headers: record() });
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
      expect(response.headers.get('etag')).toBe('"unchanged"');
      expect(response.headers.get('x-mock-recorded')).toBe('payment-declined/000001');
      expect(await readFile(join(captures, 'payment-declined', '000001', '304'))).toHaveLength(0);
      expect(await logLines(captures, 'payment-declined')).toMatchObject([{ outcome: 'captured', status: 304 }]);
    },
  );

  it('answers 500 without upstream I/O when no exchange can be claimed', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.end('x');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    // Replacing the pinned root makes every claim fail closed.
    await rename(captures, `${captures}-moved`);
    await mkdir(captures);
    const response = await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('recording-capture-failed');
    expect(upstream.connections()).toBe(0);
    expect(await readdir(captures)).toEqual([]);
    expect(logs.some((line) => line.startsWith('capture-claim-failed'))).toBe(true);
  });

  it('relays the response with X-Mock-Recorded: failed when the capture cannot be written', async () => {
    let capturesDir = '';
    const upstream = await fakeUpstream(async (_request, response) => {
      // Occupy a name the sink must create exclusively, so its write fails after the claim.
      await writeFile(join(capturesDir, 'payment-declined', '000001', 'request.json'), 'taken');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    capturesDir = captures;
    const response = await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get('x-mock-recorded')).toBe('failed');
    expect(await readdir(join(captures, 'payment-declined', '000001'))).toEqual(['request.json']);
    expect(await logLines(captures, 'payment-declined')).toEqual([
      expect.objectContaining({ exchange: '000001', outcome: 'capture-failed' }) as unknown,
    ]);
  });

  it('gives simultaneous recordings distinct, complete exchanges and one log line each', async () => {
    const upstream = await fakeUpstream((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ url: request.url }));
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fetch(`${server.url}/v1/products/p-${String(index)}`, { headers: record() }),
      ),
    );
    const recorded = responses.map((response) => response.headers.get('x-mock-recorded')).sort();
    expect(new Set(recorded).size).toBe(12);
    expect(await exchanges(captures, 'payment-declined')).toHaveLength(12);
    const lines = await logLines(captures, 'payment-declined');
    expect(lines).toHaveLength(12);
    expect(new Set(lines.map((line) => line['exchange'])).size).toBe(12);
    for (const exchange of await exchanges(captures, 'payment-declined')) {
      expect((await readdir(join(captures, 'payment-declined', exchange))).sort()).toEqual([
        '200.json',
        '200.meta.json',
        'request.json',
      ]);
    }
  });

  it('serves the recording, capture list and capture detail', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=1' });
      response.end('{"ok":true}');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    const health = (await (await fetch(`${server.url}/_janus/health`)).json()) as {
      capabilities: { recording: unknown };
    };
    expect(health.capabilities.recording).toEqual({ available: true, endpoints: 1 });
    const recording = await fetch(`${server.url}/_janus/recording`);
    expect(recording.headers.get('cache-control')).toBe('no-store');
    expect(await recording.json()).toEqual({
      apiVersion: 'atlas.v1',
      available: true,
      endpoints: [{ method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url }],
      timeoutMs: 5000,
      maxResponseBytes: 1048576,
      maxConcurrent: 16,
    });
    expect(JSON.stringify(await (await fetch(`${server.url}/_janus/config`)).json())).not.toContain(captures);

    await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    await fetch(`${server.url}/v1/products/p-2`, { headers: record({ 'x-mock-scenario': 'default' }) });
    const list = (await (await fetch(`${server.url}/_janus/captures`)).json()) as {
      items: { id: string; detailHref?: string }[];
      next: string | null;
    };
    expect(list.items.map((item) => item.id).sort()).toEqual(['default/000001', 'payment-declined/000001']);
    const filtered = (await (await fetch(`${server.url}/_janus/captures?scenario=default&limit=1`)).json()) as {
      items: { id: string }[];
    };
    expect(filtered.items.map((item) => item.id)).toEqual(['default/000001']);
    expect((await fetch(`${server.url}/_janus/captures?limit=0`)).status).toBe(400);
    expect((await fetch(`${server.url}/_janus/captures?scenario=Bad`)).status).toBe(400);
    expect((await fetch(`${server.url}/_janus/captures?before=../000001`)).status).toBe(400);

    const detail = await fetch(`${server.url}/_janus/captures/payment-declined/000001`);
    expect(detail.status).toBe(200);
    const document = (await detail.json()) as {
      id: string;
      request: { target: string };
      response: { fileName: string; headers: unknown; modified: boolean };
    };
    expect(document.id).toBe('payment-declined/000001');
    expect(document.request.target).toBe('/v1/products/p-1');
    expect(document.response).toMatchObject({
      fileName: '200.json',
      headers: [{ name: 'set-cookie', value: 'a=1' }],
      modified: false,
    });
    await writeFile(join(captures, 'payment-declined', '000001', '200.json'), '{"edited":true}');
    const modified = (await (await fetch(`${server.url}/_janus/captures/payment-declined/000001`)).json()) as {
      response: { modified: boolean };
    };
    expect(modified.response.modified).toBe(true);

    expect((await fetch(`${server.url}/_janus/captures/payment-declined/000009`)).status).toBe(404);
    expect((await fetch(`${server.url}/_janus/captures/payment-declined/1`)).status).toBe(404);
    expect((await fetch(`${server.url}/_janus/captures/payment-declined/000001/x`)).status).toBe(404);
    expect((await fetch(`${server.url}/_janus/captures/payment-declined`)).status).toBe(404);
    expect((await fetch(`${server.url}/_janus/captures/payment-declined/000001`, { method: 'DELETE' })).status).toBe(
      405,
    );
    expect((await fetch(`${server.url}/_janus/captures`, { method: 'POST' })).status).toBe(405);
  });

  it('rejects traversal and ambiguous encodings before reading anything', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.end('x');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    await writeFile(join(root, 'secret.json'), '{"secret":true}');
    for (const target of [
      '/_janus/captures/..%2Fsecret/000001',
      '/_janus/captures/%2E%2E/000001',
      '/_janus/captures/payment-declined%5C..%5C/000001',
      '/_janus/captures/payment-declined/..%2F..%2F',
      '/_janus/captures/payment-declined/000001%00',
      `/_janus/captures/${'a'.repeat(65)}/000001`,
      '/_janus/captures/payment-declined/0000001',
    ]) {
      const response = await fetch(`${server.url}${target}`);
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain('secret');
    }
    // A link planted in the captures tree is never followed.
    await mkdir(join(captures, 'linked'));
    await writeFile(join(captures, 'linked', 'log.jsonl'), '');
    await symlink(root, join(captures, 'outside'));
    const list = (await (await fetch(`${server.url}/_janus/captures`)).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });

  it('never follows a linked exchange directory or reads a hard-linked file', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const { server, captures } = await janus([
      { method: 'GET', path: '/v1/products/{productId}', upstream: upstream.url },
    ]);
    await fetch(`${server.url}/v1/products/p-1`, { headers: record() });
    const exchange = join(captures, 'payment-declined', '000001');
    await writeFile(join(root, 'outside.json'), '{"outside":true}');
    await rm(join(exchange, 'request.json'));
    await link(join(root, 'outside.json'), join(exchange, 'request.json'));
    const detail = (await (await fetch(`${server.url}/_janus/captures/payment-declined/000001`)).json()) as {
      request: { state: string };
    };
    expect(detail.request.state).toBe('unreadable');
    await rename(exchange, `${exchange}-real`);
    await symlink(`${exchange}-real`, exchange);
    const linked = (await (await fetch(`${server.url}/_janus/captures/payment-declined/000001`)).json()) as {
      request: { state: string };
      response: { state: string };
    };
    expect([linked.request.state, linked.response.state]).toEqual(['unreadable', 'unreadable']);
  });

  it('publishes a capture event after the log line', async () => {
    const upstream = await fakeUpstream((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const { server } = await janus([{ method: 'POST', path: '/v1/payments', upstream: upstream.url }]);
    const controller = new AbortController();
    const stream = await fetch(`${server.url}/_janus/events`, { signal: controller.signal });
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (pattern: string) => {
      while (!text.includes(pattern)) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        text += decoder.decode(chunk.value as Uint8Array);
      }
    };
    await read('event: state');
    await fetch(`${server.url}/v1/payments`, { method: 'POST', headers: record() });
    await read('event: capture');
    controller.abort();
    expect(text).toContain(
      'event: capture\ndata: {"id":"payment-declined/000001","scenario":"payment-declined","outcome":"captured"}\n\n',
    );
  });
});

describe('the capture store', () => {
  const quiet = { error: () => undefined };

  it('never shares an exchange number between two processes, and never reuses one', async () => {
    const captures = join(root, 'captures');
    await mkdir(captures);
    const [a, b] = await Promise.all([CaptureStore.open(captures, quiet), CaptureStore.open(captures, quiet)]);
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? a : b).claim('payment-declined')),
    );
    const numbers = claims.map((claim) => claim.exchange).sort();
    expect(new Set(numbers).size).toBe(20);
    expect(numbers.at(-1)).toBe('000020');
    // A failed exchange keeps its empty directory, so a restarted process continues after it.
    await a.fail(claims[0] ?? { scenario: 'payment-declined', exchange: '000001' }, {
      exchange: claims[0]?.exchange ?? '',
      at: '2026-10-03T00:00:00.000Z',
      method: 'GET',
      target: '/',
      registration: '/',
      outcome: 'upstream-failed',
      durationMs: 1,
    });
    const restarted = await CaptureStore.open(captures, quiet);
    expect((await restarted.claim('payment-declined')).exchange).toBe('000021');
  });

  it('reports exchanges with no log line once they are older than the timeout', async () => {
    const captures = join(root, 'captures');
    await mkdir(join(captures, 'default', '000001'), { recursive: true });
    await mkdir(join(captures, 'default', '000002'));
    await mkdir(join(captures, 'default', '000003'));
    await writeFile(
      join(captures, 'default', 'log.jsonl'),
      '{"exchange":"000003","at":"x","method":"GET","target":"/","registration":"/","outcome":"upstream-failed","durationMs":1}\n',
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(join(captures, 'default', '000001'), old, old);
    const store = await CaptureStore.open(captures, quiet);
    const incomplete = await store.incomplete(30_000, Date.now() + 60_000);
    expect(incomplete.map((entry) => entry.exchange)).toEqual(['000001', '000002']);
    expect((await store.incomplete(30_000)).map((entry) => entry.exchange)).toEqual([]);
  });
});

describe('recording at startup', () => {
  function environment(): { env: CliEnvironment; stdout: () => string; stderr: () => string } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      env: {
        cwd: root,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        onSignal: () => () => undefined,
        uiRoot: null,
      },
      stdout: () => out.join(''),
      stderr: () => err.join(''),
    };
  }
  const config = (extra = '') =>
    [
      'fixtures:',
      '  root: ./data',
      'recording:',
      '  endpoints:',
      '    - { method: GET, path: "/v1/products/{productId}", upstream: "https://staging.example.test" }',
      extra,
      '',
    ].join('\n');

  it('validates the registrations without creating the captures directory', async () => {
    await writeTree(root, { ...prefixed('data', TREE), 'janus.config.yaml': config() });
    const io = environment();
    expect(await main(['validate'], io.env)).toBe(0);
    expect(await readdir(root)).not.toContain('captures');
    expect(parseConfig({ text: config(), sourceName: 'janus.config.yaml' }).ok).toBe(true);
  });

  it('reports captures inside the fixture root, also through a link', async () => {
    await writeTree(root, { ...prefixed('data', TREE), 'janus.config.yaml': config('  captures: ./data/captures') });
    const io = environment();
    expect(await main(['validate'], io.env)).toBe(1);
    expect(io.stderr()).toContain('[captures-inside-fixtures]');
    await symlink(join(root, 'data'), join(root, 'alias'));
    await writeFile(join(root, 'janus.config.yaml'), config('  captures: ./alias'));
    const aliased = environment();
    expect(await main(['validate'], aliased.env)).toBe(1);
    expect(aliased.stderr()).toContain('[captures-inside-fixtures]');
    expect(await readdir(join(root, 'data'))).not.toContain('captures');
  });

  it('refuses to serve when the captures directory cannot be created', async () => {
    await writeTree(root, {
      ...prefixed('data', TREE),
      'janus.config.yaml': config('  captures: ./taken'),
      taken: 'a file',
    });
    const io = environment();
    expect(await main(['serve', '--port', '0'], io.env)).toBe(1);
    expect(io.stderr()).toContain('[captures-not-writable]');
  });

  it('refuses a non-loopback listener unless allowNonLoopback opts in, then warns', async () => {
    await writeTree(root, { ...prefixed('data', TREE), 'janus.config.yaml': config() });
    const io = environment();
    expect(await main(['validate', '--host', '0.0.0.0'], io.env)).toBe(1);
    expect(io.stderr()).toContain('[recording-non-loopback]');
    await writeFile(join(root, 'janus.config.yaml'), config('  allowNonLoopback: true'));
    const allowed = environment();
    expect(await main(['validate', '--host', '0.0.0.0'], allowed.env)).toBe(0);
    expect(allowed.stdout()).toContain('[recording-exposed]');
  });

  it('warns tls-verification-off when runner.skipTlsVerify is on', async () => {
    await writeTree(root, {
      ...prefixed('data', TREE),
      'janus.config.yaml': `${config()}runner:\n  skipTlsVerify: true\n`,
    });
    const io = environment();
    expect(await main(['validate'], io.env)).toBe(0);
    expect(io.stdout()).toContain('[tls-verification-off]');
  });

  it('needs nothing from a configuration without registrations', async () => {
    await writeTree(root, {
      ...prefixed('data', TREE),
      'janus.config.yaml': 'fixtures:\n  root: ./data\nrecording:\n  captures: ./data\n',
    });
    const io = environment();
    expect(await main(['validate', '--host', '0.0.0.0'], io.env)).toBe(0);
  });
});

function prefixed(prefix: string, tree: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, contents]) => [`${prefix}/${path}`, contents]));
}
