import { isMap, isScalar, type Node as YamlNode, type Pair } from 'yaml';

import { CanonicalWriter } from '../canonical.js';

/** A delay before the first byte: exactly `ms`, or an integer from `min` to `max`. */
export type LatencyProfile = { readonly ms: number } | { readonly min: number; readonly max: number };

/** The largest delay any profile may name, in milliseconds. */
export const MAX_LATENCY_MS = 60_000;

/** What reading a profile from YAML found: the profile, or why the node is not one. */
export type LatencyRead =
  { readonly ok: true; readonly profile: LatencyProfile } | { readonly ok: false; readonly message: string };

const SHAPE = `"latency" must be { ms: N } or { min: A, max: B }, with integers from 0 to ${String(MAX_LATENCY_MS)}`;

/** Reads a latency profile from a `flow.yaml` or `fault.yaml` node. */
export function readLatency(node: YamlNode | null | undefined): LatencyRead {
  if (!isMap(node)) return { ok: false, message: SHAPE };
  const values = new Map<string, number>();
  for (const pair of node.items as Pair<YamlNode | null, YamlNode | null>[]) {
    const name = isScalar(pair.key) ? String(pair.key.value) : '';
    if (name !== 'ms' && name !== 'min' && name !== 'max') {
      return { ok: false, message: `unknown key "${name}" in "latency"; ${SHAPE}` };
    }
    const value = isScalar(pair.value) ? pair.value.value : undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_LATENCY_MS) {
      return { ok: false, message: `"latency.${name}" must be an integer from 0 to ${String(MAX_LATENCY_MS)}` };
    }
    values.set(name, value);
  }
  const ms = values.get('ms');
  const min = values.get('min');
  const max = values.get('max');
  if (ms !== undefined && min === undefined && max === undefined) return { ok: true, profile: Object.freeze({ ms }) };
  if (ms === undefined && min !== undefined && max !== undefined) {
    if (min > max) return { ok: false, message: `"latency.min" is greater than "latency.max"` };
    return { ok: true, profile: Object.freeze({ min, max }) };
  }
  return { ok: false, message: SHAPE };
}

/** A profile as Atlas publishes a setting: `{ ms: 1500 }` or `{ min: 200, max: 800 }`. */
export function formatLatency(profile: LatencyProfile): string {
  return 'ms' in profile
    ? `{ ms: ${String(profile.ms)} }`
    : `{ min: ${String(profile.min)}, max: ${String(profile.max)} }`;
}

/**
 * The delay a request gets from a profile: a range is drawn
 * from the seed, the domain tag `latency`, the method, the route template (or
 * the normalised path for a route miss) and the canonical request digest, so
 * the same request in the same run always waits the same time.
 */
export function drawLatency(
  profile: LatencyProfile,
  input: { readonly seed: number; readonly method: string; readonly route: string; readonly requestDigest: Uint8Array },
): number {
  if ('ms' in profile) return profile.ms;
  const span = profile.max - profile.min + 1;
  if (span === 1) return profile.min;
  const digest = new CanonicalWriter()
    .string('janus-latency/1')
    .number(input.seed)
    .string('latency')
    .string(input.method)
    .string(input.route)
    .bytes(input.requestDigest)
    .digest();
  // 48 bits keep the modulo bias far below anything a 60 001-wide range could show.
  let value = 0;
  for (let index = 0; index < 6; index++) value = value * 256 + (digest[index] ?? 0);
  return profile.min + (value % span);
}
