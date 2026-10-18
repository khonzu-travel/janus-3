import { describe, expect, it } from 'vitest';

import {
  isLoopbackHost,
  isLoopbackIp,
  isSameAuthority,
  normalizeOriginEntry,
  parseAuthority,
  parseOrigin,
} from './origin.js';

describe('parseOrigin', () => {
  it.each([
    ['http://localhost:5173', 'http', 'localhost', 5173, 'http://localhost:5173'],
    ['https://atlas.example.com', 'https', 'atlas.example.com', 443, 'https://atlas.example.com'],
    ['HTTPS://Atlas.Example.COM:443', 'https', 'atlas.example.com', 443, 'https://atlas.example.com'],
    ['http://example.com:80', 'http', 'example.com', 80, 'http://example.com'],
    ['http://example.com:443', 'http', 'example.com', 443, 'http://example.com:443'],
    ['http://127.0.0.1:4010', 'http', '127.0.0.1', 4010, 'http://127.0.0.1:4010'],
    ['http://[::1]:4010', 'http', '[::1]', 4010, 'http://[::1]:4010'],
    ['https://[2001:DB8::1]', 'https', '[2001:db8::1]', 443, 'https://[2001:db8::1]'],
    ['http://[::ffff:127.0.0.1]', 'http', '[::ffff:127.0.0.1]', 80, 'http://[::ffff:127.0.0.1]'],
  ])('parses %s', (value, scheme, host, port, serialized) => {
    expect(parseOrigin(value)).toEqual({ scheme, host, port, serialized });
  });

  it.each([
    'null',
    '',
    'localhost:5173',
    'ftp://example.com',
    'file:///etc/passwd',
    'http://',
    'http://example.com/',
    'http://example.com/path',
    'http://example.com?x=1',
    'http://example.com#f',
    'http://user@example.com',
    'http://example.com:',
    'http://example.com:65536',
    'http://example.com:-1',
    'http://exa mple.com',
    'http://a.com, http://b.com',
    'http://a.com http://b.com',
    'http://[::1',
    'http://[fe80::1%25eth0]',
    'http://[fe80::1%eth0]',
    'http://[1:2:3:4:5:6:7:8:9]',
    'http://[::1::2]',
    'http://[12345::1]',
    'http://-bad.example',
    'http://bad..example',
  ])('rejects %j', (value) => {
    expect(parseOrigin(value)).toBeNull();
  });
});

describe('parseAuthority', () => {
  it.each([
    ['localhost:4010', 'localhost', 4010],
    ['Example.COM', 'example.com', null],
    ['[::1]:4010', '[::1]', 4010],
    ['[::1]', '[::1]', null],
    ['127.0.0.1', '127.0.0.1', null],
  ])('parses %s', (value, host, port) => {
    expect(parseAuthority(value)).toEqual({ host, port });
  });

  it.each(['', 'host:', 'host:abc', '[::1', '::1', 'host:99999', 'a b'])('rejects %j', (value) => {
    expect(parseAuthority(value)).toBeNull();
  });
});

describe('isSameAuthority', () => {
  const same = (origin: string, host: string): boolean => {
    const parsedOrigin = parseOrigin(origin);
    const authority = parseAuthority(host);
    if (parsedOrigin === null || authority === null) throw new Error('unparseable');
    return isSameAuthority(parsedOrigin, authority);
  };

  it('compares host and port, never the scheme', () => {
    expect(same('http://127.0.0.1:4010', '127.0.0.1:4010')).toBe(true);
    expect(same('https://127.0.0.1:4010', '127.0.0.1:4010')).toBe(true);
    expect(same('http://127.0.0.1:4011', '127.0.0.1:4010')).toBe(false);
    expect(same('http://localhost:4010', '127.0.0.1:4010')).toBe(false);
  });

  it("reads a Host without a port as the default port of the origin's scheme", () => {
    expect(same('https://host', 'host')).toBe(true);
    expect(same('https://host:443', 'host')).toBe(true);
    expect(same('http://host', 'host')).toBe(true);
    expect(same('http://host', 'host:80')).toBe(true);
    expect(same('https://host', 'host:80')).toBe(false);
    expect(same('http://host:8080', 'host')).toBe(false);
  });

  it('compares hosts lowercased and IPv6 literals in brackets', () => {
    expect(same('http://Example.com:4010', 'EXAMPLE.COM:4010')).toBe(true);
    expect(same('http://[::1]:4010', '[::1]:4010')).toBe(true);
  });
});

describe('normalizeOriginEntry', () => {
  it('keeps the wildcard and normalizes origins', () => {
    expect(normalizeOriginEntry('*')).toBe('*');
    expect(normalizeOriginEntry('HTTP://LOCALHOST:80')).toBe('http://localhost');
  });
});

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'atlas.localhost',
    'a.b.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]',
  ])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    'evil.example',
    'localhost.evil.example',
    'notlocalhost',
    '128.0.0.1',
    '127.1',
    '10.0.0.1',
    '[::2]',
    '[::]',
    '[2001:db8::1]',
    '[::ffff:10.0.0.1]',
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('isLoopbackIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.2', false],
    ['localhost', false],
  ])('%s → %s', (address, expected) => {
    expect(isLoopbackIp(address)).toBe(expected);
  });
});
