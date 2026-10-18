/**
 * Language tags and `Accept-Language` negotiation (RFC 9110 §12.5.4, RFC 4647).
 * Pure string handling: no `Intl`, so results never depend on the runtime's
 * locale data.
 */

// A well-formed BCP 47 shape: a 2–8 letter primary subtag, then 1–8 character
// alphanumeric subtags. Registry validity (is "zz" a real language?) is not checked.
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
// RFC 4647 §2.1 basic language range, or the wildcard.
const LANGUAGE_RANGE = /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/;
const WEIGHT = /^[qQ]=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** True when `tag` is a well-formed language tag such as `en`, `en-US`, or `zh-Hant-TW`. */
export function isLanguageTag(tag: string): boolean {
  return LANGUAGE_TAG.test(tag);
}

export interface LanguagePreference {
  /** Lower-cased language range, or `*`. */
  readonly range: string;
  /** Weight in thousandths (0–1000), so comparisons are exact. */
  readonly weight: number;
}

/**
 * Parses `Accept-Language` field values into preferences, highest weight
 * first; equal weights keep their order in the field. Malformed members are
 * ignored, as RFC 9110 allows, rather than failing the request.
 */
export function parseAcceptLanguage(values: readonly string[]): readonly LanguagePreference[] {
  const preferences: LanguagePreference[] = [];
  for (const value of values) {
    for (const member of value.split(',')) {
      const [rawRange = '', ...parameters] = member.split(';').map((part) => part.trim());
      if (rawRange === '' || !LANGUAGE_RANGE.test(rawRange) || parameters.length > 1) continue;
      let weight = 1000;
      if (parameters.length === 1) {
        const match = WEIGHT.exec(parameters[0] ?? '');
        if (match === null) continue;
        weight = Math.round(Number(match[1]) * 1000);
      }
      preferences.push({ range: rawRange.toLowerCase(), weight });
    }
  }
  // Array.prototype.sort is stable, so equal weights keep field order.
  return preferences.sort((a, b) => b.weight - a.weight);
}

/**
 * `range` is the part of the language range that decided the choice (the
 * matched prefix after RFC 4647 truncation), or null when none did. It never
 * holds more of the request header than the available tags reveal.
 */
export type LanguageChoice =
  | { readonly kind: 'tag'; readonly key: string; readonly range: string }
  | { readonly kind: 'fallback'; readonly range: string | null }
  | { readonly kind: 'none' };

/**
 * Chooses among available language tags for an `Accept-Language` field.
 *
 * `available` holds lower-cased tags in the caller's deterministic order;
 * `hasFallback` says whether a language-neutral representation exists.
 * `header` is undefined when the request has no `Accept-Language` field,
 * which RFC 9110 treats as "any language is acceptable", like `*`. A field
 * with no usable member (empty or entirely malformed) is treated the same.
 *
 * Each positive range, in preference order, tries:
 * 1. an exact tag match, then progressively shorter prefixes of the range
 *    (RFC 4647 §3.4 lookup: `en-US` → `en`);
 * 2. otherwise the first available tag that extends the range
 *    (`en` → `en-GB`, `en-US`: the first in `available` order wins);
 * 3. `*` picks the fallback when there is one, else the first available tag.
 * Tags named with `q=0` are never chosen. When no range matches, the fallback
 * is used; with no fallback the result is `none` (the caller answers `406`).
 */
export function chooseLanguage(
  header: readonly string[] | undefined,
  available: readonly string[],
  hasFallback: boolean,
): LanguageChoice {
  const parsed = header === undefined ? [] : parseAcceptLanguage(header);
  const preferences = parsed.length > 0 ? parsed : [{ range: '*', weight: 1000 }];
  const excluded = new Set(preferences.filter((p) => p.weight === 0 && p.range !== '*').map((p) => p.range));
  const candidates = available.filter((key) => !excluded.has(key));
  const has = new Set(candidates);

  for (const { range, weight } of preferences) {
    if (weight === 0) continue;
    if (range === '*') {
      if (hasFallback) return { kind: 'fallback', range };
      const first = candidates[0];
      if (first !== undefined) return { kind: 'tag', key: first, range };
      continue;
    }
    for (let prefix = range; prefix !== ''; prefix = truncate(prefix)) {
      if (has.has(prefix)) return { kind: 'tag', key: prefix, range: prefix };
    }
    const extended = candidates.find((key) => key.startsWith(`${range}-`));
    if (extended !== undefined) return { kind: 'tag', key: extended, range };
  }
  return hasFallback ? { kind: 'fallback', range: null } : { kind: 'none' };
}

/** Drops the last subtag, and a single-character subtag left before it (RFC 4647 §3.4). */
function truncate(range: string): string {
  const parts = range.split('-');
  parts.pop();
  while (parts.length > 1 && (parts[parts.length - 1] ?? '').length === 1) parts.pop();
  return parts.join('-');
}
