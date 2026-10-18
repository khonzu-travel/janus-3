import { MAX_NAME_BYTES, isVariableName } from '../model.js';

/**
 * Path names for imported collections, folders, requests and environments:
 * source names lower-cased, other characters replaced
 * by `-`, made unique within their folder and prefixed with a position.
 */

/**
 * A source name in the path-name grammar: accents dropped, lower-cased, each
 * run of other characters replaced by `-`, trimmed and cut to `maxBytes`;
 * `fallback` when nothing is left.
 */
export function toRunnerName(source: string, fallback: string, maxBytes: number = MAX_NAME_BYTES): string {
  const ascii = source.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const name = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = name.slice(0, maxBytes).replace(/-+$/, '');
  return cut === '' ? fallback.slice(0, maxBytes) : cut;
}

/** Makes names unique in order, adding `-2`, `-3`, … to repeats; each result fits `maxBytes`. */
export function uniqueNames(names: readonly string[], maxBytes: number = MAX_NAME_BYTES): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) {
      const suffix = `-${String(n)}`;
      candidate = name.slice(0, maxBytes - suffix.length).replace(/-+$/, '') + suffix;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * The position prefix of the `index`th (0-based) of `count` entries: `010`,
 * `020`, … in steps of 10. Three digits, widened only when a folder holds more
 * than 99 entries so that byte order stays source order.
 */
export function positionPrefix(index: number, count: number): string {
  const width = Math.max(3, String(count * 10).length);
  return String((index + 1) * 10).padStart(width, '0');
}

/** Prefixes each name with its position, keeping the whole within the byte limit. */
export function positionedNames(bases: readonly string[]): string[] {
  const prefixes = bases.map((_, index) => positionPrefix(index, bases.length));
  const room = MAX_NAME_BYTES - (prefixes[0]?.length ?? 3) - 1;
  const unique = uniqueNames(
    bases.map((base) => base.slice(0, room).replace(/-+$/, '') || 'item'),
    room,
  );
  return unique.map((base, index) => `${prefixes[index] ?? ''}-${base}`);
}

/**
 * A variable name in the grammar. Names outside it have each
 * run of other characters replaced by `_` (and a leading `_` when they start
 * with a digit), so a definition and every reference to it map the same way.
 */
export function toVariableName(name: string): string {
  if (isVariableName(name)) return name;
  let out = name.replace(/[^A-Za-z0-9_.-]+/g, '_');
  if (!/^[A-Za-z_]/.test(out)) out = `_${out}`;
  return out.slice(0, 128);
}

/** `api.example.com` → `apiExampleCom`: words of the host, camel-cased. */
export function camelCase(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  const joined = words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
  return /^[a-z]/.test(joined) ? joined : `host${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
}
