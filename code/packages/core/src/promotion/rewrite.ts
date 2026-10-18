import { utf8Encode } from '../bytes.js';
import { compareStrings } from '../canonical.js';
import { escapePointer, parseJsonTree, serializeJsonTree, type JsonNode } from '../dynamic/json-tree.js';
import type {
  ProvenanceRefusal,
  ProvenanceRewrite,
  ProvenanceSuggestion,
  RewriteTier,
} from '../fixtures/provenance.js';
import { PromotionError } from './errors.js';

/** A declared ID paired with a value found in the capture. */
export interface Binding {
  readonly id: string;
  readonly value: string;
  readonly tier: RewriteTier;
  readonly source: 'explicit' | 'path' | 'response';
}

/** Bound values shorter than this are too likely to occur by chance. */
export const MIN_ID_LENGTH = 4;

const RANK: Readonly<Record<Binding['source'], number>> = { explicit: 0, path: 1, response: 2 };

/**
 * Collects bindings in precedence order: explicit `ids`,
 * template parameters named like a declared ID, then string members of a JSON
 * response whose key is a declared name. Conflicts, undeclared parameters and
 * short values become refusals; an explicit binding naming an undeclared ID is
 * `422 promotion-unknown-id`.
 */
export function collectBindings(input: {
  readonly scenario: string;
  readonly declared: ReadonlySet<string>;
  readonly explicit: readonly (readonly [string, string])[];
  readonly path: readonly (readonly [string, string])[];
  readonly body: JsonNode | null;
}): { readonly bindings: readonly Binding[]; readonly refusals: readonly ProvenanceRefusal[] } {
  const refusals: ProvenanceRefusal[] = [];
  const candidates: Binding[] = [];
  for (const [id, value] of input.explicit) {
    if (!input.declared.has(id)) {
      const known = [...input.declared].sort(compareStrings);
      throw new PromotionError(
        422,
        'promotion-unknown-id',
        `scenario "${input.scenario}" declares no id "${id}"${known.length === 0 ? '' : `; its ids are ${known.join(', ')}`}`,
        { field: 'ids', scenario: input.scenario, id },
      );
    }
    candidates.push({ id, value, tier: 'exact', source: 'explicit' });
  }
  for (const [name, value] of input.path) {
    if (input.declared.has(name)) candidates.push({ id: name, value, tier: 'exact', source: 'path' });
    else refusals.push({ code: 'id-undeclared', id: name });
  }
  if (input.body !== null) {
    const visit = (node: JsonNode): void => {
      if (node.kind === 'object') {
        for (const [key, child] of node.entries) {
          if (child.kind === 'string' && input.declared.has(key)) {
            candidates.push({ id: key, value: child.value, tier: 'inferred', source: 'response' });
          }
          visit(child);
        }
      } else if (node.kind === 'array') node.items.forEach(visit);
    };
    visit(input.body);
  }

  // One name, two values: the higher-precedence binding wins; a tie at the top refuses the name.
  const byName = new Map<string, Binding[]>();
  for (const candidate of candidates) byName.set(candidate.id, [...(byName.get(candidate.id) ?? []), candidate]);
  const kept: Binding[] = [];
  const refuse = (code: ProvenanceRefusal['code'], id: string): void => {
    if (!refusals.some((refusal) => refusal.code === code && refusal.id === id)) refusals.push({ code, id });
  };
  for (const [id, list] of byName) {
    const best = Math.min(...list.map((binding) => RANK[binding.source]));
    const top = [...new Set(list.filter((binding) => RANK[binding.source] === best).map((binding) => binding.value))];
    if (top.length > 1) {
      refuse('id-conflict', id);
      continue;
    }
    const winner = list.find((binding) => RANK[binding.source] === best) as Binding;
    if (list.some((binding) => binding.value !== winner.value)) refuse('id-conflict', id);
    kept.push(winner);
  }

  // Two names, one value: an explicit binding wins; otherwise both are refused.
  const byValue = new Map<string, Binding[]>();
  for (const binding of kept) byValue.set(binding.value, [...(byValue.get(binding.value) ?? []), binding]);
  const bindings: Binding[] = [];
  for (const list of byValue.values()) {
    if (list.length === 1) {
      bindings.push(list[0] as Binding);
      continue;
    }
    const explicit = list.filter((binding) => binding.source === 'explicit');
    if (explicit.length === 1) bindings.push(explicit[0] as Binding);
    for (const binding of list) if (binding !== explicit[0] || explicit.length !== 1) refuse('id-conflict', binding.id);
  }

  const searched = bindings.filter((binding) => {
    if (binding.value.length >= MIN_ID_LENGTH) return true;
    refuse('id-too-short', binding.id);
    return false;
  });
  return {
    bindings: Object.freeze(searched.sort((a, b) => compareStrings(a.id, b.id))),
    refusals: Object.freeze(refusals),
  };
}

/** What rewriting one file produced: its bytes, and every rewrite, suggestion and refusal located in it. */
export interface RewriteResult {
  readonly bytes: Uint8Array;
  readonly rewrites: readonly ProvenanceRewrite[];
  readonly suggestions: readonly ProvenanceSuggestion[];
  readonly refusals: readonly ProvenanceRefusal[];
}

type Piece = { readonly text: string } | { readonly binding: Binding };

/** The token a rewritten occurrence becomes. */
export function idToken(id: string): string {
  return `{{$scenario.ids.${id}}}`;
}

/** The escape: every `{{$` in captured text is served literally. */
export function escapeTokens(text: string): string {
  // A function replacement: in a replacement string, `$$` would itself mean one `$`.
  return text.replaceAll('{{$', () => '{{$$');
}

/**
 * Rewrites a JSON body: whole string values and whole
 * URL or path segments become tokens; other substrings are suggestions;
 * numbers, booleans and keys equal to a value are refused. A body with no
 * rewrite and no escape keeps its bytes; otherwise it is re-serialised in
 * member order.
 */
export function rewriteJsonBody(bytes: Uint8Array, text: string, bindings: readonly Binding[]): RewriteResult {
  const tree = parseJsonTree(text);
  const byValue = new Map(bindings.map((binding) => [binding.value, binding]));
  const rewrites: ProvenanceRewrite[] = [];
  const suggestions: ProvenanceSuggestion[] = [];
  const refusals: ProvenanceRefusal[] = [];
  const replaced = new Map<string, string>();
  const visit = (node: JsonNode, pointer: string): void => {
    if (node.kind === 'object') {
      for (const [key, child] of node.entries) {
        const at = `${pointer}/${escapePointer(key)}`;
        const binding = byValue.get(key);
        if (binding !== undefined) refusals.push({ code: 'id-in-key', id: binding.id, pointer: at });
        visit(child, at);
      }
    } else if (node.kind === 'array') {
      node.items.forEach((child, index) => {
        visit(child, `${pointer}/${String(index)}`);
      });
    } else if (node.kind === 'literal') {
      const binding = byValue.get(node.text);
      if (binding !== undefined) refusals.push({ code: 'id-not-string', id: binding.id, pointer });
    } else {
      const pieces = stringPieces(node.value, byValue, false);
      const located = { pointer };
      record(pieces, bindings, located, rewrites, suggestions);
      const written = render(pieces);
      if (written !== node.value) replaced.set(pointer, written);
    }
  };
  visit(tree, '');
  if (replaced.size === 0) return { bytes, rewrites, suggestions, refusals };
  const out = serializeJsonTree(tree, (node, pointer, writer) => {
    writer.write(JSON.stringify(replaced.get(pointer) ?? node.value));
  });
  return { bytes: utf8Encode(out), rewrites, suggestions, refusals };
}

/** Rewrites a text body line by line: a line that is a URL or absolute path has its whole segments rewritten. */
export function rewriteTextBody(text: string, bindings: readonly Binding[]): RewriteResult {
  const byValue = new Map(bindings.map((binding) => [binding.value, binding]));
  const rewrites: ProvenanceRewrite[] = [];
  const suggestions: ProvenanceSuggestion[] = [];
  const lines = text.split('\n');
  const out = lines.map((line, index) => {
    const pieces = stringPieces(line, byValue, true);
    record(pieces, bindings, { line: index + 1 }, rewrites, suggestions);
    return render(pieces);
  });
  return { bytes: utf8Encode(out.join('\n')), rewrites, suggestions, refusals: [] };
}

/**
 * Rewrites a header sidecar object: URL and path values, and
 * the targets of `Location`, `Content-Location` and `Link`, have their whole
 * segments rewritten; other substrings are suggestions. Returns the sidecar in
 * the capture's shape, or null when there is nothing to write.
 */
export function rewriteHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
  bindings: readonly Binding[],
): { readonly headers: Record<string, string | string[]> } & Omit<RewriteResult, 'bytes'> {
  const byValue = new Map(bindings.map((binding) => [binding.value, binding]));
  const rewrites: ProvenanceRewrite[] = [];
  const suggestions: ProvenanceSuggestion[] = [];
  const out: Record<string, string | string[]> = {};
  for (const [written, raw] of Object.entries(headers)) {
    const name = written.toLowerCase();
    const values = typeof raw === 'string' ? [raw] : [...raw];
    const rewritten = values.map((value) => {
      // Location and Content-Location are a URL or path as a whole; Link holds one in each <target>.
      const pieces = name === 'link' ? linkPieces(value, byValue) : stringPieces(value, byValue, true);
      record(pieces, bindings, { header: name }, rewrites, suggestions);
      return render(pieces);
    });
    out[written] = typeof raw === 'string' ? (rewritten[0] ?? '') : rewritten;
  }
  return { headers: out, rewrites, suggestions, refusals: [] };
}

/** One refusal per binding for a body that is neither JSON nor text. */
export function binaryRefusals(bindings: readonly Binding[]): readonly ProvenanceRefusal[] {
  return bindings.map((binding) => ({ code: 'id-in-binary-body' as const, id: binding.id }));
}

const URL_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*/;

/** True for an absolute URL or an absolute path with no whitespace. */
function isUrlOrPath(text: string): boolean {
  if (/\s/.test(text)) return false;
  return (text.startsWith('/') && !text.startsWith('//')) || URL_PREFIX.test(text);
}

/**
 * Splits a string into literal text and bound values: the whole string when
 * it equals one, or each whole path segment of a URL or path. `lineMode`
 * allows surrounding whitespace around a URL, as in a text line.
 */
function stringPieces(value: string, byValue: ReadonlyMap<string, Binding>, lineMode: boolean): Piece[] {
  const whole = byValue.get(value);
  if (whole !== undefined && !lineMode) return [{ binding: whole }];
  const leading = lineMode ? (/^\s*/.exec(value)?.[0] ?? '') : '';
  const trailing = lineMode ? (/\s*$/.exec(value.slice(leading.length))?.[0] ?? '') : '';
  const core = value.slice(leading.length, value.length - trailing.length);
  if (core === '' || !isUrlOrPath(core)) return [{ text: value }];
  const prefix = URL_PREFIX.exec(core)?.[0] ?? '';
  const rest = core.slice(prefix.length);
  const end = rest.search(/[?#]/);
  const path = end === -1 ? rest : rest.slice(0, end);
  const suffix = end === -1 ? '' : rest.slice(end);
  const pieces: Piece[] = [{ text: leading + prefix }];
  path.split('/').forEach((segment, index) => {
    if (index > 0) pieces.push({ text: '/' });
    const binding = segment === '' ? undefined : byValue.get(segment);
    pieces.push(binding === undefined ? { text: segment } : { binding });
  });
  pieces.push({ text: suffix + trailing });
  return pieces;
}

/** A `Link` value: each `<target>` is rewritten as a URL; parameters are text. */
function linkPieces(value: string, byValue: ReadonlyMap<string, Binding>): Piece[] {
  const pieces: Piece[] = [];
  let index = 0;
  const pattern = /<([^>]*)>/g;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    pieces.push({ text: value.slice(index, match.index + 1) });
    pieces.push(...stringPieces(match[1] ?? '', byValue, false));
    pieces.push({ text: '>' });
    index = match.index + match[0].length;
  }
  pieces.push({ text: value.slice(index) });
  return pieces;
}

/** Rewrites for bound pieces; suggestions for values still found inside literal text. */
function record(
  pieces: readonly Piece[],
  bindings: readonly Binding[],
  location: { readonly pointer: string } | { readonly line: number } | { readonly header: string },
  rewrites: ProvenanceRewrite[],
  suggestions: ProvenanceSuggestion[],
): void {
  const add = <T extends { id: string }>(list: T[], item: T): void => {
    if (!list.some((entry) => JSON.stringify(entry) === JSON.stringify(item))) list.push(item);
  };
  for (const piece of pieces) {
    if ('binding' in piece) add(rewrites, { tier: piece.binding.tier, id: piece.binding.id, ...location });
  }
  const text = pieces.map((piece) => ('text' in piece ? piece.text : '\0')).join('');
  for (const binding of bindings) {
    if (text.includes(binding.value)) add(suggestions, { id: binding.id, ...location });
  }
}

/** Literal text escaped, bound values as tokens. */
function render(pieces: readonly Piece[]): string {
  return pieces.map((piece) => ('text' in piece ? escapeTokens(piece.text) : idToken(piece.binding.id))).join('');
}
