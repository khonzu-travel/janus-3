import { describe, expect, it } from 'vitest';

import { fromBase64, toBase64, utf8Encode } from '../bytes.js';
import { decodeResolveEnvelope, MAX_INSTANT_MS, type ResolveEnvelopeResult } from './envelope.js';

// The resolve envelope.

const decode = (value: unknown, maxBodyBytes = 1024): ResolveEnvelopeResult =>
  decodeResolveEnvelope(value, { maxBodyBytes });

/** Parses JSON text first, as the adapter does. */
const decodeText = (text: string): ResolveEnvelopeResult => decode(JSON.parse(text) as unknown);

const invalid = (field: string) => ({ ok: false, kind: 'invalid', field });

describe('decodeResolveEnvelope', () => {
  it('decodes the minimal envelope: method and target, no headers or body', () => {
    expect(decode({ method: 'get', target: '/v1/products?x=1' })).toEqual({
      ok: true,
      request: { method: 'get', target: '/v1/products?x=1', headers: {} },
    });
  });

  it('decodes every field', () => {
    const result = decode({
      method: 'POST',
      target: '/v1/products?dryRun=1',
      headers: { 'Content-Type': ['application/json'], accept: '*/*' },
      body: { encoding: 'utf8', data: '{"name":"Chair"}' },
      nowMs: '2026-01-01T00:00:00Z',
    });
    expect(result).toEqual({
      ok: true,
      request: {
        method: 'POST',
        target: '/v1/products?dryRun=1',
        headers: { 'content-type': ['application/json'], accept: ['*/*'] },
        body: utf8Encode('{"name":"Chair"}'),
        nowMs: Date.UTC(2026, 0, 1),
      },
    });
  });

  it('passes method and target through for resolution to normalise', () => {
    expect(decode({ method: 'not a token', target: '../x' })).toMatchObject({
      ok: true,
      request: { method: 'not a token', target: '../x' },
    });
  });

  it('keeps repeated header values in order', () => {
    expect(decode({ method: 'GET', target: '/', headers: { accept: ['a/b', 'c/d'] } })).toMatchObject({
      ok: true,
      request: { headers: { accept: ['a/b', 'c/d'] } },
    });
  });

  it.each([
    ['base64', toBase64(new Uint8Array([0, 255, 1])), [0, 255, 1]],
    ['base64', '', []],
    ['utf8', 'é', [0xc3, 0xa9]],
    ['utf8', '', []],
  ])('decodes a %s body %j', (encoding, data, bytes) => {
    const result = decode({ method: 'POST', target: '/', body: { encoding, data } });
    if (!result.ok) throw new Error(result.message);
    expect([...(result.request.body ?? [])]).toEqual(bytes);
  });

  it.each([
    [0, 0],
    [1_767_225_600_000, 1_767_225_600_000],
    [-MAX_INSTANT_MS, -MAX_INSTANT_MS],
    [MAX_INSTANT_MS, MAX_INSTANT_MS],
    ['2026-01-01T09:00:00+09:00', Date.UTC(2026, 0, 1)],
    ['2026-01-01T00:00:00.123Z', Date.UTC(2026, 0, 1) + 123],
  ])('accepts nowMs %j', (nowMs, expected) => {
    expect(decode({ method: 'GET', target: '/', nowMs })).toMatchObject({ ok: true, request: { nowMs: expected } });
  });

  it.each<[string, unknown, string]>([
    ['a non-object', [], ''],
    ['null', null, ''],
    ['a missing method', { target: '/' }, 'method'],
    ['a non-string method', { method: 1, target: '/' }, 'method'],
    ['a missing target', { method: 'GET' }, 'target'],
    ['a non-string target', { method: 'GET', target: null }, 'target'],
    ['an unknown key', { method: 'GET', target: '/', extra: 1 }, 'extra'],
    ['a requestId', { method: 'GET', target: '/', requestId: 'x' }, 'requestId'],
    ['headers that are not an object', { method: 'GET', target: '/', headers: ['a'] }, 'headers'],
    ['an invalid header name', { method: 'GET', target: '/', headers: { 'bad name': 'x' } }, 'headers.bad name'],
    ['an empty header array', { method: 'GET', target: '/', headers: { accept: [] } }, 'headers.accept'],
    ['a non-string header value', { method: 'GET', target: '/', headers: { accept: [1] } }, 'headers.accept'],
    ['a numeric header value', { method: 'GET', target: '/', headers: { accept: 1 } }, 'headers.accept'],
    ['a header value with CR LF', { method: 'GET', target: '/', headers: { a: 'x\r\nb: y' } }, 'headers.a'],
    ['a body that is a string', { method: 'GET', target: '/', body: 'x' }, 'body'],
    ['an unknown body key', { method: 'GET', target: '/', body: { encoding: 'utf8', data: '', x: 1 } }, 'body.x'],
    ['an unknown encoding', { method: 'GET', target: '/', body: { encoding: 'hex', data: '' } }, 'body.encoding'],
    ['a missing encoding', { method: 'GET', target: '/', body: { data: '' } }, 'body.encoding'],
    ['non-string data', { method: 'GET', target: '/', body: { encoding: 'utf8', data: 1 } }, 'body.data'],
    ['invalid base64', { method: 'GET', target: '/', body: { encoding: 'base64', data: 'a*==' } }, 'body.data'],
    ['unpadded base64', { method: 'GET', target: '/', body: { encoding: 'base64', data: 'AA' } }, 'body.data'],
    ['base64 with spaces', { method: 'GET', target: '/', body: { encoding: 'base64', data: 'AA A' } }, 'body.data'],
    ['a fractional nowMs', { method: 'GET', target: '/', nowMs: 1.5 }, 'nowMs'],
    ['a nowMs past the Date range', { method: 'GET', target: '/', nowMs: MAX_INSTANT_MS + 1 }, 'nowMs'],
    ['a nowMs before the Date range', { method: 'GET', target: '/', nowMs: -MAX_INSTANT_MS - 1 }, 'nowMs'],
    ['a nowMs without an offset', { method: 'GET', target: '/', nowMs: '2026-01-01T00:00:00' }, 'nowMs'],
    ['an impossible nowMs date', { method: 'GET', target: '/', nowMs: '2026-02-30T00:00:00Z' }, 'nowMs'],
    ['a boolean nowMs', { method: 'GET', target: '/', nowMs: true }, 'nowMs'],
    ['a null nowMs', { method: 'GET', target: '/', nowMs: null }, 'nowMs'],
    ['an uppercase scenario', { method: 'GET', target: '/', scenario: 'Declined' }, 'scenario'],
    ['a null scenario', { method: 'GET', target: '/', scenario: null }, 'scenario'],
  ])('rejects %s, naming the field', (_label, value, field) => {
    const result = decode(value);
    expect(result).toMatchObject(invalid(field));
    if (!result.ok && field !== '') expect(result.message).toContain(`"${field}"`);
  });

  it('passes a scenario through as the caller source', () => {
    expect(decode({ method: 'GET', target: '/', scenario: 'payment-declined' })).toMatchObject({
      ok: true,
      request: { scenario: 'payment-declined' },
    });
  });

  it('rejects header names that differ only by case rather than guessing their order', () => {
    const result = decode({ method: 'GET', target: '/', headers: { Accept: 'a/b', accept: 'c/d' } });
    expect(result).toMatchObject(invalid('headers.accept'));
    if (!result.ok) expect(result.message).toContain('another case');
  });

  it('lets the last of exact duplicate JSON members win, as the native decoder does', () => {
    // JSON.parse keeps the last value of a repeated member name before the envelope is validated.
    expect(decodeText('{"method":"GET","target":"/a","target":"/b"}')).toMatchObject({
      ok: true,
      request: { target: '/b' },
    });
    expect(decodeText('{"method":"GET","target":"/","headers":{"accept":"a/b","accept":"c/d"}}')).toMatchObject({
      ok: true,
      request: { headers: { accept: ['c/d'] } },
    });
  });

  it('limits the decoded body, not its encoded form', () => {
    const exact = toBase64(new Uint8Array(12));
    expect(decode({ method: 'POST', target: '/', body: { encoding: 'base64', data: exact } }, 12).ok).toBe(true);
    expect(decode({ method: 'POST', target: '/', body: { encoding: 'utf8', data: 'x'.repeat(13) } }, 12)).toMatchObject(
      { ok: false, kind: 'too-large', field: 'body' },
    );
    expect(decode({ method: 'POST', target: '/', body: { encoding: 'utf8', data: 'éé' } }, 3)).toMatchObject({
      ok: false,
      kind: 'too-large',
    });
  });
});

describe('fromBase64', () => {
  it('round-trips every length', () => {
    for (let length = 0; length < 10; length++) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 97 + 3) % 256);
      expect([...(fromBase64(toBase64(bytes)) ?? [])]).toEqual([...bytes]);
    }
  });

  it('rejects non-canonical padding bits and stray characters', () => {
    expect(fromBase64('AB==')).toBeNull(); // "AA==" is the canonical spelling of [0]
    expect(fromBase64('A===')).toBeNull();
    expect(fromBase64('AA=A')).toBeNull();
    expect(fromBase64('AA-_')).toBeNull();
  });
});
