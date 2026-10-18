/**
 * `Accept` parsing and media-type ranking. Pure string handling;
 * the resolver decides what to do with the result.
 */
import { compareStrings } from '../canonical.js';
import { formatMediaRange, parseParameters, splitOutsideQuotes, type MediaParameter } from './media-type.js';
import { isToken } from './token.js';

const WEIGHT = /^(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
/** Longest dropped range quoted back in a warning or trace, in characters. */
const DROPPED_RANGE_LIMIT = 64;

export interface MediaRange {
  /** Lower-cased, or "*". */
  readonly type: string;
  /** Lower-cased, or "*". */
  readonly subtype: string;
  /** Media parameters written before `q`; they take part in matching. */
  readonly parameters: readonly MediaParameter[];
  /** Weight in thousandths (0–1000), so comparisons are exact. */
  readonly weight: number;
  /** 3 = type/subtype;params, 2 = type/subtype, 1 = type/*, 0 = *\/*. */
  readonly specificity: number;
  /** Canonical text, e.g. "application/*" or "text/html;level=1". Never the raw header. */
  readonly text: string;
}

export interface ParsedAccept {
  /** False when the field is absent or has no members; it then means `*\/*`. */
  readonly present: boolean;
  /** Usable ranges, identical ranges collapsed to their highest weight, in first-seen order. */
  readonly ranges: readonly MediaRange[];
  /** Members that were not usable, as safe printable text in field order. */
  readonly dropped: readonly string[];
  /** 1-based positions of the dropped members among all members, e.g. "#2", for traces. */
  readonly droppedPositions: readonly string[];
}

const ANY: MediaRange = Object.freeze({
  type: '*',
  subtype: '*',
  parameters: Object.freeze([]),
  weight: 1000,
  specificity: 0,
  text: '*/*',
});

/** The meaning of an absent `Accept` field. */
export const ACCEPT_ANY: readonly MediaRange[] = Object.freeze([ANY]);

/**
 * Parses `Accept` field lines, combined in wire order. A member with a
 * malformed range, a malformed `q`, or more than one `q` is dropped; every
 * other member is usable.
 */
export function parseAccept(values: readonly string[] | undefined): ParsedAccept {
  const ranges: MediaRange[] = [];
  const dropped: string[] = [];
  const droppedPositions: string[] = [];
  let position = 0;
  const byIdentity = new Map<string, number>();
  let present = false;

  for (const value of values ?? []) {
    for (const member of splitOutsideQuotes(value, ',')) {
      const trimmed = member.trim();
      if (trimmed === '') continue;
      present = true;
      position++;
      const range = parseRange(trimmed);
      if (range === null) {
        dropped.push(safeText(trimmed));
        droppedPositions.push(`#${String(position)}`);
        continue;
      }
      const existing = byIdentity.get(range.text);
      if (existing === undefined) {
        byIdentity.set(range.text, ranges.length);
        ranges.push(range);
      } else if ((ranges[existing]?.weight ?? 0) < range.weight) {
        ranges[existing] = range;
      }
    }
  }
  return { present, ranges, dropped, droppedPositions };
}

function parseRange(member: string): MediaRange | null {
  const [head = '', ...rest] = splitOutsideQuotes(member, ';');
  const essence = head.trim();
  const slash = essence.indexOf('/');
  const type = essence.slice(0, slash).toLowerCase();
  const subtype = essence.slice(slash + 1).toLowerCase();
  if (slash === -1 || !isToken(type) || !isToken(subtype)) return null;
  if (type === '*' && subtype !== '*') return null;

  const all = parseParameters(rest);
  if (all === null) return null;
  const qIndex = all.findIndex(([name]) => name === 'q');
  const parameters = qIndex === -1 ? all : all.slice(0, qIndex);
  let weight = 1000;
  if (qIndex !== -1) {
    const match = WEIGHT.exec(all[qIndex]?.[1] ?? '');
    if (match === null) return null;
    // Accept extensions after `q` are ignored, but a second `q` is ambiguous.
    if (all.slice(qIndex + 1).some(([name]) => name === 'q')) return null;
    weight = Math.round(Number(match[1]) * 1000);
  }
  const specificity = type === '*' ? 0 : subtype === '*' ? 1 : parameters.length > 0 ? 3 : 2;
  if (specificity < 2 && parameters.length > 0) return null;
  const sorted = [...parameters].sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  return { type, subtype, parameters: sorted, weight, specificity, text: formatMediaRange(type, subtype, sorted) };
}

/** Printable ASCII only, without quotes or backslashes, and bounded, so it can be echoed in a quoted-string. */
function safeText(member: string): string {
  let out = '';
  for (const char of member) {
    const code = char.charCodeAt(0);
    out += code >= 0x20 && code <= 0x7e && char !== '"' && char !== '\\' ? char : '?';
  }
  return out.length > DROPPED_RANGE_LIMIT ? `${out.slice(0, DROPPED_RANGE_LIMIT - 3)}...` : out;
}

export interface RankedMediaType {
  /** The candidate as given. */
  readonly mediaType: string;
  /** The range that decided its quality. */
  readonly range: MediaRange;
}

/**
 * Chooses the best of `candidates` (bare `type/subtype` media types) for the
 * ranges, or null when none is acceptable. Each candidate takes its quality
 * from its most specific matching range; a candidate whose deciding range has
 * `q=0` is refused. Ties break by specificity, then `preference` order, then
 * lexical order of the media type.
 */
export function chooseMediaType(
  ranges: readonly MediaRange[],
  candidates: readonly string[],
  preference: readonly string[],
): RankedMediaType | null {
  let best: RankedMediaType | null = null;
  for (const mediaType of candidates) {
    const range = decidingRange(ranges, mediaType);
    if (range === null || range.weight === 0) continue;
    const ranked = { mediaType, range };
    if (best === null || compareRanked(ranked, best, preference) < 0) best = ranked;
  }
  return best;
}

/** The candidate that ranks first by `preference` order, then lexical order alone (`onUnacceptable: ignore`). */
export function firstByPreference(candidates: readonly string[], preference: readonly string[]): string | null {
  return [...candidates].sort((a, b) => comparePreference(a, b, preference))[0] ?? null;
}

function decidingRange(ranges: readonly MediaRange[], mediaType: string): MediaRange | null {
  const lower = mediaType.toLowerCase();
  const slash = lower.indexOf('/');
  const type = lower.slice(0, slash);
  const subtype = lower.slice(slash + 1);
  let best: MediaRange | null = null;
  for (const range of ranges) {
    // Filename media types carry no parameters, so a parameterized range never matches one.
    const matches =
      range.specificity === 0 ||
      (range.specificity === 1 && range.type === type) ||
      (range.specificity === 2 && range.type === type && range.subtype === subtype);
    if (matches && (best === null || range.specificity > best.specificity)) best = range;
  }
  return best;
}

function compareRanked(a: RankedMediaType, b: RankedMediaType, preference: readonly string[]): number {
  return (
    b.range.weight - a.range.weight ||
    b.range.specificity - a.range.specificity ||
    comparePreference(a.mediaType, b.mediaType, preference)
  );
}

function comparePreference(a: string, b: string, preference: readonly string[]): number {
  const rank = (mediaType: string): number => {
    const index = preference.findIndex((entry) => entry.toLowerCase() === mediaType.toLowerCase());
    return index === -1 ? preference.length : index;
  };
  return rank(a) - rank(b) || compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b);
}
