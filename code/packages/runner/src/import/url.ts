import type { Note } from './template.js';

/**
 * URL template helpers for importers: path parameters,
 * appended query parameters and the absolute-URL rule.
 */

/** A `:name` path segment's name, in the variable grammar. */
const PATH_PARAM = /^:([A-Za-z_][A-Za-z0-9_.-]*)$/;

/** The path of a URL template: what follows the scheme and authority, before `?` or `#`. */
function pathOf(url: string): string {
  let rest = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  const hash = rest.indexOf('#');
  if (hash !== -1) rest = rest.slice(0, hash);
  const query = rest.indexOf('?');
  if (query !== -1) rest = rest.slice(0, query);
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(slash);
}

/** The names of a URL template's `:name` segments, in order. */
export function pathParamNames(url: string): string[] {
  return pathOf(url)
    .split('/')
    .map((segment) => PATH_PARAM.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Percent-encodes text for a query string, leaving `{{…}}` templates as written. */
export function encodeQueryPart(text: string): string {
  return text
    .split(/(\{\{[\s\S]*?\}\})/)
    .map((part, index) => (index % 2 === 1 ? part : encodeURIComponent(part)))
    .join('');
}

/** Appends `name=value` to a URL template's query, before any fragment. */
export function appendQuery(url: string, name: string, value: string): string {
  const hash = url.indexOf('#');
  const head = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? '' : url.slice(hash);
  const separator = head.includes('?') ? (head.endsWith('?') || head.endsWith('&') ? '' : '&') : '?';
  return `${head}${separator}${encodeQueryPart(name)}=${encodeQueryPart(value)}${tail}`;
}

/**
 * Makes a URL template absolute where that can be known at import time:
 * a template that starts with a variable is kept, `http(s)://` is kept, and a
 * URL with no scheme gets `http://`, as Postman and Bruno assume. Returns null
 * for another scheme.
 */
export function absoluteUrl(url: string): { readonly url: string; readonly added: boolean } | null {
  const trimmed = url.trim();
  if (trimmed.startsWith('{{') || /^https?:\/\//i.test(trimmed)) return { url: trimmed, added: false };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return null;
  return { url: `http://${trimmed}`, added: true };
}

/**
 * `pathParams` for a URL template: one entry per `:name`
 * segment, from `values`; a segment with no value gets an empty one and a
 * value with no segment is dropped, each with a note.
 */
export function reconcilePathParams(
  url: string,
  values: Readonly<Record<string, string>>,
  note: Note,
): Readonly<Record<string, string>> | undefined {
  const names = pathParamNames(url);
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = values[name];
    if (value === undefined) note(`path parameter :${name} has no value in the source; it is empty`);
    out[name] = value ?? '';
  }
  for (const name of Object.keys(values)) {
    if (!names.includes(name)) note(`path variable "${name}" has no :${name} segment in the URL and was dropped`);
  }
  return names.length === 0 ? undefined : out;
}
