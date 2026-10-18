import { describe, expect, it } from 'vitest';

import { decodeConfig, readRuntimeConfig } from './config.js';

const PAGE = 'https://ui.example/atlas/index.html?x=1#/endpoints';

function roots(raw: unknown, page = PAGE): { serverUrl: string; atlasRoot: string } {
  const result = decodeConfig(raw, page);
  if (!result.ok) throw new Error(result.message);
  return { serverUrl: result.config.serverUrl.href, atlasRoot: result.config.atlasRoot.href };
}

function failure(raw: unknown): string {
  const result = decodeConfig(raw, PAGE);
  if (result.ok) throw new Error('expected a configuration error');
  return result.message;
}

describe('decodeConfig', () => {
  it("defaults to the page's own origin", () => {
    expect(roots(undefined)).toEqual({ serverUrl: 'https://ui.example/', atlasRoot: 'https://ui.example/_janus/' });
    expect(roots({})).toEqual(roots(undefined));
  });

  it('accepts an absolute override', () => {
    expect(roots({ serverUrl: 'http://127.0.0.1:4010' })).toEqual({
      serverUrl: 'http://127.0.0.1:4010/',
      atlasRoot: 'http://127.0.0.1:4010/_janus/',
    });
  });

  it('keeps a path and adds the trailing slash', () => {
    expect(roots({ serverUrl: 'https://host/mock' }).atlasRoot).toBe('https://host/mock/_janus/');
    expect(roots({ serverUrl: 'https://host/mock/' }).atlasRoot).toBe('https://host/mock/_janus/');
  });

  it('resolves a relative serverUrl against the page', () => {
    expect(roots({ serverUrl: '/mock' }).atlasRoot).toBe('https://ui.example/mock/_janus/');
    expect(roots({ serverUrl: '../api' }).atlasRoot).toBe('https://ui.example/api/_janus/');
  });

  it("resolves the Janus-served '../../' to the serving server, under a path prefix too", () => {
    const at = (page: string) => {
      const result = decodeConfig({ serverUrl: '../../' }, page);
      if (!result.ok) throw new Error(result.message);
      return result.config.atlasRoot.href;
    };
    expect(at('http://127.0.0.1:4010/_janus/ui/')).toBe('http://127.0.0.1:4010/_janus/');
    expect(at('https://host/mock/_janus/ui/')).toBe('https://host/mock/_janus/');
    expect(at('https://host/mock/_janus/ui/#/endpoints/ep_0123456789abcdef?q=x')).toBe('https://host/mock/_janus/');
  });

  it('rejects unknown keys, including atlasPrefix', () => {
    expect(failure({ atlasPrefix: '/_other' })).toContain('"atlasPrefix"');
    expect(failure({ serverUrl: 'http://x', extra: 1 })).toContain('"extra"');
  });

  it.each([
    [null, 'must be an object'],
    ['http://x', 'must be an object'],
    [[], 'must be an object'],
    [{ serverUrl: 42 }, 'non-empty string'],
    [{ serverUrl: ' ' }, 'non-empty string'],
    [{ serverUrl: 'ftp://host/' }, 'http: or https:'],
    [{ serverUrl: 'javascript:alert(1)' }, 'http: or https:'],
    [{ serverUrl: 'http://user:pass@host/' }, 'credentials'],
    [{ serverUrl: 'http://host/?token=x' }, 'query or fragment'],
    [{ serverUrl: 'http://host/#x' }, 'query or fragment'],
    [{ serverUrl: 'http://[bad' }, 'not a valid URL'],
  ])('rejects %j', (raw, message) => {
    expect(failure(raw)).toContain(message);
  });

  it('reads the object the page defined before startup', () => {
    globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: 'http://127.0.0.1:4010' };
    try {
      const result = readRuntimeConfig(PAGE);
      expect(result.ok && result.config.atlasRoot.href).toBe('http://127.0.0.1:4010/_janus/');
    } finally {
      globalThis.__JANUS_ATLAS_CONFIG__ = undefined;
    }
  });
});
