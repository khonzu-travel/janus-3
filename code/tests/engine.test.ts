import { buildSnapshot, createEngine } from '@janus/core';
import type { ResponseDescription } from '@janus/core';
import { describe, expect, it } from 'vitest';

describe('direct delivery mode', () => {
  it('resolves a request through the @janus/core package entry point', async () => {
    const built = buildSnapshot(new Map([['default/GET/200_{text-plain}.txt', new TextEncoder().encode('hello')]]));
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const response: ResponseDescription = await createEngine({ snapshot: built.snapshot }).resolve({
      method: 'GET',
      target: '/',
      headers: {},
    });
    expect(response.kind).toBe('response');
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body ?? new Uint8Array())).toBe('hello');
    expect(response.trace.outcome).toEqual({ kind: 'matched', fixture: { path: 'default/GET/200_{text-plain}.txt' } });
  });
});
