import { toHex, utf8Encode } from '../bytes.js';
import { compareStrings, sha256 } from '../canonical.js';
import { parseFileName, isVariantName } from './filename.js';
import { parseJson } from './sidecar.js';

/** The provenance file format. */
export const PROVENANCE_FORMAT = 'janus.provenance.v1';

/** How sure Janus is of a rewrite; `suggested` occurrences are never written. */
export type RewriteTier = 'exact' | 'inferred';

/** Why Janus declined to rewrite a value. */
export type RefusalCode =
  'id-undeclared' | 'id-too-short' | 'id-conflict' | 'id-not-string' | 'id-in-key' | 'id-in-binary-body';

export const REFUSAL_CODES: readonly RefusalCode[] = Object.freeze([
  'id-undeclared',
  'id-too-short',
  'id-conflict',
  'id-not-string',
  'id-in-key',
  'id-in-binary-body',
]);

/** Where in a file: a JSON Pointer into a JSON body, a 1-based line of a text body, or a header name. */
export interface ProvenanceLocation {
  readonly pointer?: string;
  readonly line?: number;
  readonly header?: string;
}

export interface ProvenanceRewrite extends ProvenanceLocation {
  readonly tier: RewriteTier;
  readonly id: string;
}
export interface ProvenanceSuggestion extends ProvenanceLocation {
  readonly id: string;
}
export interface ProvenanceRefusal extends ProvenanceLocation {
  readonly code: RefusalCode;
  readonly id: string;
}

/** Something a reviewer should know that is not an ID, e.g. `existing-headers-kept`. */
export interface ProvenanceNote {
  readonly code: string;
  readonly message: string;
}

export type ReviewState = 'pending' | 'reviewed';

/** One promoted file's record. Locations and codes only, never values. */
export interface ProvenanceEntry {
  readonly source: 'promotion';
  /** `<scenario>/<exchange>`. */
  readonly capture: string;
  readonly promotedAt: string;
  /** `sha256:` and 64 hex digits of the file as written. */
  readonly digest: string;
  readonly review: ReviewState;
  readonly reviewedAt?: string;
  readonly rewrites: readonly ProvenanceRewrite[];
  readonly suggestions: readonly ProvenanceSuggestion[];
  readonly refusals: readonly ProvenanceRefusal[];
  readonly notes: readonly ProvenanceNote[];
}

export interface ProvenanceDocument {
  readonly format: typeof PROVENANCE_FORMAT;
  /** File name in the same method directory → its entry. */
  readonly files: Readonly<Record<string, ProvenanceEntry>>;
}

export type ProvenanceResult =
  { readonly ok: true; readonly document: ProvenanceDocument } | { readonly ok: false; readonly message: string };

const META_NAME = /^(\d{3})(?:\.([^.]+))?\.meta\.json$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CAPTURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/(?:[0-9a-f]{8}|[0-9]{6})$/;
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'source',
  'capture',
  'promotedAt',
  'digest',
  'review',
  'reviewedAt',
  'rewrites',
  'suggestions',
  'refusals',
  'notes',
]);

/** `sha256:` and the hex digest of a file's bytes. */
export function fileDigest(bytes: Uint8Array): string {
  return `sha256:${toHex(sha256(bytes))}`;
}

/**
 * The identity a provenance file name records:
 * `402.meta.json` is `402`, `402.declined.meta.json` is `402.declined`.
 * Null for any other name, including one with an invalid variant.
 */
export function parseProvenanceName(
  name: string,
): { readonly status: number; readonly variant: string | null; readonly identity: string } | null {
  const match = META_NAME.exec(name);
  if (match === null) return null;
  const status = Number(match[1]);
  if (status < 200 || status > 599) return null;
  const variant = match[2] ?? null;
  if (variant !== null && !isVariantName(variant)) return null;
  return { status, variant, identity: variant === null ? String(status) : `${String(status)}.${variant}` };
}

/** `<identity>.meta.json`. */
export function provenanceFileName(identity: string): string {
  return `${identity}.meta.json`;
}

/** True when `file` is a response file or header sidecar of `identity`. */
export function belongsToIdentity(file: string, identity: string): boolean {
  const parsed = parseFileName(file);
  if (parsed.kind === 'invalid') return false;
  const own = parsed.variant === null ? String(parsed.status) : `${String(parsed.status)}.${parsed.variant}`;
  return own === identity;
}

/**
 * Parses and validates a provenance file: valid JSON, the
 * known `format`, no unknown members, and every entry naming a file of the
 * identity the file name records.
 */
export function parseProvenance(name: string, bytes: Uint8Array): ProvenanceResult {
  const fail = (message: string): ProvenanceResult => ({ ok: false, message });
  const parsedName = parseProvenanceName(name);
  if (parsedName === null) return fail('the name is not <status>[.<variant>].meta.json');
  const json = parseJson(bytes);
  if (!json.ok) return fail(json.problem.message);
  const value = json.value;
  if (!isObject(value)) return fail('the file must be a JSON object');
  for (const key of Object.keys(value)) {
    if (key !== 'format' && key !== 'files') return fail(`unknown member "${key}"`);
  }
  if (value['format'] !== PROVENANCE_FORMAT) return fail(`"format" must be "${PROVENANCE_FORMAT}"`);
  const files = value['files'];
  if (!isObject(files)) return fail('"files" must be an object');
  const out: Record<string, ProvenanceEntry> = {};
  for (const [file, raw] of Object.entries(files)) {
    if (!belongsToIdentity(file, parsedName.identity)) {
      return fail(`"${file}" is not a file of ${parsedName.identity}; a provenance file records only its own identity`);
    }
    const entry = parseEntry(raw);
    if (typeof entry === 'string') return fail(`"${file}": ${entry}`);
    out[file] = entry;
  }
  return { ok: true, document: Object.freeze({ format: PROVENANCE_FORMAT, files: Object.freeze(out) }) };
}

/** A provenance document as written: two-space JSON, files sorted by name, with a final newline. */
export function serializeProvenance(document: ProvenanceDocument): Uint8Array {
  const files: Record<string, unknown> = {};
  for (const name of Object.keys(document.files).sort(compareStrings)) {
    const entry = document.files[name];
    if (entry === undefined) continue;
    files[name] = {
      source: entry.source,
      capture: entry.capture,
      promotedAt: entry.promotedAt,
      digest: entry.digest,
      review: entry.review,
      ...(entry.reviewedAt === undefined ? {} : { reviewedAt: entry.reviewedAt }),
      rewrites: entry.rewrites,
      suggestions: entry.suggestions,
      refusals: entry.refusals,
      notes: entry.notes,
    };
  }
  return utf8Encode(`${JSON.stringify({ format: document.format, files }, null, 2)}\n`);
}

function parseEntry(raw: unknown): ProvenanceEntry | string {
  if (!isObject(raw)) return 'an entry must be an object';
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) return `unknown member "${key}"`;
  const { source, capture, promotedAt, digest, review, reviewedAt } = raw;
  if (source !== 'promotion') return '"source" must be "promotion"';
  if (typeof capture !== 'string' || !CAPTURE_ID.test(capture)) return '"capture" must be a capture ID';
  if (typeof promotedAt !== 'string' || promotedAt === '') return '"promotedAt" must be an instant';
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return '"digest" must be sha256: and 64 hex digits';
  if (review !== 'pending' && review !== 'reviewed') return '"review" must be "pending" or "reviewed"';
  if (reviewedAt !== undefined && typeof reviewedAt !== 'string') return '"reviewedAt" must be an instant';
  const rewrites = list(raw['rewrites'], 'rewrites', (item) => {
    const tier = item['tier'];
    if (tier !== 'exact' && tier !== 'inferred') return '"tier" must be "exact" or "inferred"';
    return located(item, ['tier', 'id'], (): { tier: RewriteTier; id: string } => ({
      tier,
      id: item['id'] as string,
    }));
  });
  if (typeof rewrites === 'string') return rewrites;
  const suggestions = list(raw['suggestions'], 'suggestions', (item) =>
    located(item, ['id'], () => ({ id: item['id'] as string })),
  );
  if (typeof suggestions === 'string') return suggestions;
  const refusals = list(raw['refusals'], 'refusals', (item) => {
    const code = item['code'];
    if (!REFUSAL_CODES.includes(code as RefusalCode)) return `"code" must be one of ${REFUSAL_CODES.join(', ')}`;
    return located(item, ['code', 'id'], () => ({ code: code as RefusalCode, id: item['id'] as string }));
  });
  if (typeof refusals === 'string') return refusals;
  const notes = list(raw['notes'], 'notes', (item) => {
    for (const key of Object.keys(item)) if (key !== 'code' && key !== 'message') return `unknown member "${key}"`;
    if (typeof item['code'] !== 'string' || typeof item['message'] !== 'string') {
      return 'a note has a "code" and a "message"';
    }
    return { code: item['code'], message: item['message'] };
  });
  if (typeof notes === 'string') return notes;
  return Object.freeze({
    source: 'promotion' as const,
    capture,
    promotedAt,
    digest,
    review,
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    rewrites,
    suggestions,
    refusals,
    notes,
  });
}

function list<T>(
  value: unknown,
  name: string,
  item: (entry: Record<string, unknown>) => T | string,
): readonly T[] | string {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return `"${name}" must be a list`;
  const out: T[] = [];
  for (const raw of value as unknown[]) {
    if (!isObject(raw)) return `each of "${name}" must be an object`;
    const parsed = item(raw);
    if (typeof parsed === 'string') return `${name}: ${parsed}`;
    out.push(Object.freeze(parsed));
  }
  return Object.freeze(out);
}

/** An item with the given members, an `id`, and at most one location. */
function located<T extends object>(
  item: Record<string, unknown>,
  members: readonly string[],
  build: () => T,
): (T & ProvenanceLocation) | string {
  const allowed = new Set([...members, 'pointer', 'line', 'header']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) return `unknown member "${key}"`;
  if (typeof item['id'] !== 'string' || item['id'] === '') return '"id" must be a name';
  const { pointer, line, header } = item;
  const count = [pointer, line, header].filter((entry) => entry !== undefined).length;
  if (count > 1) return 'an item has at most one of "pointer", "line" and "header"';
  if (pointer !== undefined && (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/')))) {
    return '"pointer" must be a JSON Pointer';
  }
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    return '"line" must be a positive integer';
  }
  if (header !== undefined && (typeof header !== 'string' || header === '')) return '"header" must be a header name';
  return {
    ...build(),
    ...(pointer === undefined ? {} : { pointer }),
    ...(line === undefined ? {} : { line }),
    ...(header === undefined ? {} : { header }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
