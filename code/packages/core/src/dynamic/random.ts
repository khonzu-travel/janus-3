import { base, en, Faker, type Randomizer } from '@faker-js/faker';

import type { GeneratorSpec, JsonScalar } from './types.js';

/**
 * Deterministic generators. Each token gets its own
 * small PRNG, seeded from a 32-byte derivation key (or from injected entropy
 * for `:unique`), so no value depends on what else was rendered. Nothing here
 * reads `Math.random`, `Date.now` or a platform random source.
 */

/** sfc32: a small, fast PRNG with a 128-bit state. Deterministic for a given key. */
export class TokenRandom {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(key: Uint8Array) {
    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const word = (i: number): number => (key.byteLength >= (i + 1) * 4 ? view.getUint32(i * 4) : 0);
    this.#a = word(0);
    this.#b = word(1);
    this.#c = word(2);
    this.#d = word(3);
    // Fold in the rest of the key, stirring between words, then discard early output.
    for (let i = 4; i < 8; i++) {
      this.#a ^= word(i);
      for (let j = 0; j < 3; j++) this.uint32();
    }
    for (let i = 0; i < 12; i++) this.uint32();
  }

  uint32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** A float in [0, 1) with 53 random bits: faker's `Randomizer.next`. */
  next(): number {
    return ((this.uint32() >>> 5) * 67_108_864 + (this.uint32() >>> 6)) / 9_007_199_254_740_992;
  }

  bytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 4) {
      const value = this.uint32();
      for (let j = 0; j < 4 && i + j < count; j++) out[i + j] = (value >>> (24 - 8 * j)) & 0xff;
    }
    return out;
  }

  /** A uniform integer in [min, max] (both safe integers), by rejection sampling. */
  integer(min: number, max: number): number {
    const range = BigInt(max) - BigInt(min) + 1n;
    const space = 1n << 64n;
    const limit = space - (space % range);
    for (;;) {
      const value = (BigInt(this.uint32()) << 32n) | BigInt(this.uint32());
      if (value < limit) return Number(BigInt(min) + (value % range));
    }
  }
}

/** A generated value: a JSON value for whole-value typing, or text when embedded. */
export type Generated = JsonScalar | readonly unknown[] | Readonly<Record<string, unknown>>;

export function generate(spec: GeneratorSpec, random: TokenRandom, instant: number): Generated {
  switch (spec.kind) {
    case 'uuid':
      return uuid(random.bytes(16));
    case 'ulid':
      return ulid(instant, random.bytes(10));
    case 'randomBool':
      return (random.uint32() & 1) === 1;
    case 'randomInt':
      return random.integer(spec.min, spec.max);
    case 'randomFrom':
      return spec.values[random.integer(0, spec.values.length - 1)] ?? null;
    case 'faker':
      return callFaker(spec.module, spec.method, random, instant);
  }
}

function uuid(bytes: Uint8Array): string {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48 bits of the render instant (ms), then 80 bits from the token's generator. */
function ulid(instant: number, bytes: Uint8Array): string {
  if (instant < 0 || instant > 2 ** 48 - 1) throw new RangeError('the instant is outside the ULID time range');
  let time = '';
  let remaining = instant;
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[remaining % 32] ?? '0') + time;
    remaining = Math.floor(remaining / 32);
  }
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let random = '';
  for (let i = 0; i < 16; i++) {
    random = (CROCKFORD[Number(bits & 31n)] ?? '0') + random;
    bits >>= 5n;
  }
  return time + random;
}

/** Faker modules that read the current date or need arguments; never reachable from a token. */
const FAKER_EXCLUDED_MODULES: ReadonlySet<string> = new Set(['date', 'helpers', 'fakerCore']);

function newFaker(random: TokenRandom, instant: number): Faker {
  // Faker calls these detached from their object.
  const randomizer: Randomizer = { next: () => random.next(), seed: () => undefined };
  const faker = new Faker({ locale: [en, base], randomizer });
  // Never used by an accepted path, but no generator may fall back to the wall clock.
  faker.setDefaultRefDate(new Date(instant));
  return faker;
}

type FakerMethod = () => unknown;

function fakerMethod(faker: Faker, module: string, method: string): FakerMethod | null {
  if (!Object.hasOwn(faker, module) || module.startsWith('_') || FAKER_EXCLUDED_MODULES.has(module)) return null;
  const target = (faker as unknown as Record<string, unknown>)[module];
  if (typeof target !== 'object' || target === null) return null;
  if (method === 'constructor' || method.startsWith('_')) return null;
  const prototype = Object.getPrototypeOf(target) as object | null;
  if (prototype === null || !Object.hasOwn(prototype, method)) return null;
  const fn = (target as Record<string, unknown>)[method];
  return typeof fn === 'function' ? (fn.bind(target) as FakerMethod) : null;
}

function callFaker(module: string, method: string, random: TokenRandom, instant: number): Generated {
  const fn = fakerMethod(newFaker(random, instant), module, method);
  if (fn === null) throw new TypeError(`faker.${module}.${method} is not available`);
  return fn() as Generated;
}

const fakerChecks = new Map<string, string | null>();

/**
 * Why a faker path cannot be a token (`impure-faker-path`), or null when it
 * can: it must be an existing `module.method` function that runs without
 * arguments, returns JSON data, and gives the same result for the same key
 * whatever the date. Checked once per path with fixed inputs; no entropy.
 */
export function checkFakerPath(module: string, method: string): string | null {
  const key = `${module}.${method}`;
  let reason = fakerChecks.get(key);
  if (reason === undefined) {
    reason = probeFaker(module, method);
    fakerChecks.set(key, reason);
  }
  return reason;
}

function probeFaker(module: string, method: string): string | null {
  if (module === 'date') return `faker.date.${method} depends on the current date, so it is not deterministic`;
  if (module === 'helpers') return `faker.helpers.${method} needs arguments, which tokens cannot pass`;
  const probeKey = new Uint8Array(32).fill(7);
  const run = (instant: number): { ok: true; value: unknown } | { ok: false } => {
    const fn = fakerMethod(newFaker(new TokenRandom(probeKey), instant), module, method);
    if (fn === null) return { ok: false };
    try {
      return { ok: true, value: fn() };
    } catch {
      return { ok: true, value: FAILED };
    }
  };
  const first = run(0);
  if (!first.ok) return `faker.${module}.${method} is not a faker generator`;
  if (first.value === FAILED) return `faker.${module}.${method} needs arguments, which tokens cannot pass`;
  if (!isJsonData(first.value)) return `faker.${module}.${method} does not return JSON data`;
  const later = run(1_900_000_000_000);
  if (!later.ok || JSON.stringify(later.value) !== JSON.stringify(first.value)) {
    return `faker.${module}.${method} depends on the current date, so it is not deterministic`;
  }
  return null;
}

const FAILED = Symbol('failed');

function isJsonData(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonData);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isJsonData);
  }
  return false;
}

/** Every `module.method` a token may name, for "did you mean" suggestions. */
export function fakerPaths(): readonly string[] {
  fakerPathList ??= listFakerPaths();
  return fakerPathList;
}

let fakerPathList: readonly string[] | undefined;

function listFakerPaths(): readonly string[] {
  const faker = newFaker(new TokenRandom(new Uint8Array(32)), 0);
  const out: string[] = [];
  for (const module of Object.keys(faker)) {
    const target = (faker as unknown as Record<string, unknown>)[module];
    if (module.startsWith('_') || FAKER_EXCLUDED_MODULES.has(module) || typeof target !== 'object' || target === null) {
      continue;
    }
    const prototype = Object.getPrototypeOf(target) as object | null;
    if (prototype === null) continue;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method !== 'constructor' && !method.startsWith('_')) out.push(`${module}.${method}`);
    }
  }
  return Object.freeze(out.sort());
}
