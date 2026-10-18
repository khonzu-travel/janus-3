import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { toHex } from '../packages/core/src/bytes.js';
import {
  canonicalJsonText,
  exceedsJsonDepth,
  MAX_CANONICAL_JSON_DEPTH,
  sha256,
} from '../packages/core/src/canonical.js';

// Core cannot import node:crypto, so its portable SHA-256 is checked against it here.
describe('core sha256', () => {
  it('matches node:crypto for known vectors and random inputs of every padding length', () => {
    const inputs = [new Uint8Array(), new TextEncoder().encode('abc')];
    for (let length = 0; length < 200; length++) inputs.push(new Uint8Array(randomBytes(length)));
    inputs.push(new Uint8Array(randomBytes(100_000)));
    for (const input of inputs) {
      expect(toHex(sha256(input))).toBe(createHash('sha256').update(input).digest('hex'));
    }
  });
});

describe('request JSON depth limit', () => {
  it.each(['array', 'object', 'mixed'] as const)('accepts exactly the depth limit for %s nesting', (kind) => {
    const wrap = (value: string, level: number) =>
      kind === 'array' || (kind === 'mixed' && level % 2 === 0) ? `[${value}]` : `{"z":${value}}`;
    let text = '{"z":0,"a":1}';
    let canonical = '{"a":1,"z":0}';
    for (let level = 1; level < MAX_CANONICAL_JSON_DEPTH; level++) {
      text = wrap(text, level);
      canonical = wrap(canonical, level);
    }
    const value: unknown = JSON.parse(text);
    expect(exceedsJsonDepth(value)).toBe(false);
    expect(canonicalJsonText(value)).toBe(canonical);

    const tooDeep: unknown = JSON.parse(wrap(text, MAX_CANONICAL_JSON_DEPTH));
    expect(exceedsJsonDepth(tooDeep)).toBe(true);
    expect(canonicalJsonText(tooDeep)).toBeNull();
  });

  it('checks every branch, including empty containers beyond the limit', () => {
    const deep = JSON.parse(
      `${'['.repeat(MAX_CANONICAL_JSON_DEPTH + 1)}${']'.repeat(MAX_CANONICAL_JSON_DEPTH + 1)}`,
    ) as unknown;
    for (const value of [
      { first: deep, last: null },
      { first: null, last: deep },
    ]) {
      expect(exceedsJsonDepth(value)).toBe(true);
      expect(canonicalJsonText(value)).toBeNull();
    }
  });
});
