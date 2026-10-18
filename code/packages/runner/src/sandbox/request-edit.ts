import type { NameValue, RequestBody } from '../model.js';

/**
 * Pure edits of a script's request. The URL is a
 * template that may hold `{{variables}}` anywhere, so the query is edited as
 * text rather than through `URL`.
 */

interface UrlParts {
  readonly base: string;
  /** Null when the URL has no `?`. */
  readonly query: string | null;
  /** The fragment with its `#`, or "". */
  readonly hash: string;
}

function splitUrl(url: string): UrlParts {
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const rest = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  return queryAt < 0
    ? { base: rest, query: null, hash }
    : { base: rest.slice(0, queryAt), query: rest.slice(queryAt + 1), hash };
}

function joinUrl(base: string, pairs: readonly string[], hash: string): string {
  return pairs.length === 0 ? base + hash : `${base}?${pairs.join('&')}${hash}`;
}

/** The query without its `?`, as `pm.request.url.getQueryString()` returns it. */
export function queryString(url: string): string {
  return splitUrl(url).query ?? '';
}

/** Appends `key=value` (just `key` for a null value) to the query, as written. */
export function addQuery(url: string, key: string, value: string | null): string {
  const { base, query, hash } = splitUrl(url);
  const pairs = query === null || query === '' ? [] : query.split('&');
  return joinUrl(base, [...pairs, value === null ? key : `${key}=${value}`], hash);
}

/** Removes every query parameter named `key`; drops the `?` when none remain. */
export function removeQuery(url: string, key: string): string {
  const { base, query, hash } = splitUrl(url);
  if (query === null) return url;
  const pairs = query.split('&').filter((pair) => pair !== '' && pair.split('=', 1)[0] !== key);
  return joinUrl(base, pairs, hash);
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The first header with this name, compared case-insensitively. */
export function headerValue(headers: readonly NameValue[], name: string): string | undefined {
  return headers.find((header) => sameName(header.name, name))?.value;
}

/** The headers as an object; for a repeated name the first value wins. */
export function headersObject(headers: readonly NameValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    if (!Object.hasOwn(out, header.name)) out[header.name] = header.value;
  }
  return out;
}

export function addHeader(headers: readonly NameValue[], name: string, value: string): NameValue[] {
  return [...headers, { name, value }];
}

/** Replaces the first header with this name and drops the others, or appends it. */
export function upsertHeader(headers: readonly NameValue[], name: string, value: string): NameValue[] {
  const at = headers.findIndex((header) => sameName(header.name, name));
  if (at < 0) return addHeader(headers, name, value);
  return headers.flatMap((header, index) =>
    index === at ? [{ name, value }] : sameName(header.name, name) ? [] : [header],
  );
}

export function removeHeader(headers: readonly NameValue[], name: string): NameValue[] {
  return headers.filter((header) => !sameName(header.name, name));
}

const isRaw = (body: RequestBody | undefined): body is Extract<RequestBody, { type: 'json' | 'text' | 'xml' }> =>
  body?.type === 'json' || body?.type === 'text' || body?.type === 'xml';

/** True when the text parses as a JSON object or array. */
function isJsonContainer(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null;
  } catch {
    return false;
  }
}

/**
 * Sets a body's text, as `pm.request.body.update(text)` and `req.setBody(text)`
 * do. A json, text or xml body keeps its type. Without a body, or with a
 * form, multipart, file or GraphQL body, the result is a `json` body when the
 * text parses as a JSON object or array and a `text` body otherwise.
 */
export function setBodyText(body: RequestBody | undefined, text: string): RequestBody {
  if (isRaw(body)) return { type: body.type, text };
  return { type: isJsonContainer(text) ? 'json' : 'text', text };
}

/** Form fields from `[{ key, value }]` rows, as Postman's `urlencoded` lists them. */
export function formFields(rows: readonly unknown[]): NameValue[] {
  return rows.map((row) => {
    if (typeof row !== 'object' || row === null) throw new TypeError('a form field must be an object with a key');
    const { key, name, value } = row as { key?: unknown; name?: unknown; value?: unknown };
    const fieldName = typeof key === 'string' ? key : name;
    if (typeof fieldName !== 'string') throw new TypeError('a form field must have a string key');
    return {
      name: fieldName,
      value: value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value),
    };
  });
}

export type PostmanBodyMode = 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql';

/** Postman's view of a body: `mode`, plus `raw`, `urlencoded`, `formdata`, `file` or `graphql`. */
export function postmanBody(body: RequestBody | undefined): Record<string, unknown> {
  if (body === undefined) return { mode: undefined };
  switch (body.type) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode: 'raw', raw: body.text, options: { raw: { language: body.type } } };
    case 'form':
      return { mode: 'urlencoded', urlencoded: body.fields.map((field) => ({ key: field.name, value: field.value })) };
    case 'multipart':
      return {
        mode: 'formdata',
        formdata: body.parts.map((part) =>
          'file' in part
            ? { key: part.name, type: 'file', src: part.file }
            : { key: part.name, type: 'text', value: part.value },
        ),
      };
    case 'file':
      return { mode: 'file', file: { src: body.file } };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: body.query, variables: body.variables } };
  }
}

/**
 * Bruno's `req.getBody()`: the parsed JSON for a json body (its text when it
 * does not parse), the text of a text or xml body, an object of fields for a
 * form or multipart body, and `{ query, variables }` or `{ file }` otherwise.
 */
export function brunoBody(body: RequestBody | undefined): unknown {
  if (body === undefined) return undefined;
  switch (body.type) {
    case 'json':
      try {
        return JSON.parse(body.text) as unknown;
      } catch {
        return body.text;
      }
    case 'text':
    case 'xml':
      return body.text;
    case 'form':
      return headersObject(body.fields);
    case 'multipart':
      return Object.fromEntries(
        body.parts.map((part) => [part.name, 'file' in part ? { file: part.file } : part.value]),
      );
    case 'file':
      return { file: body.file };
    case 'graphql':
      return { query: body.query, variables: body.variables };
  }
}

/**
 * Bruno's `req.setBody(value)`: text as {@link setBodyText}; a plain object
 * on a form body replaces its fields; any other value becomes a `json` body
 * of its JSON text.
 */
export function setBrunoBody(body: RequestBody | undefined, value: unknown): RequestBody {
  if (typeof value === 'string') return setBodyText(body, value);
  if (body?.type === 'form' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return {
      type: 'form',
      fields: Object.entries(value).map(([name, field]) => ({
        name,
        value: typeof field === 'string' ? field : JSON.stringify(field),
      })),
    };
  }
  return { type: 'json', text: JSON.stringify(value) };
}

/**
 * Splits a simple path such as `data.items[0].id` or `a["b.c"]` into keys and
 * indexes (Bruno's `res("…")`, Postman's `to.have.jsonBody(path)`). Null when
 * the path is not of that form; "" is the whole value.
 */
export function parsePath(path: string): (string | number)[] | null {
  const segments: (string | number)[] = [];
  const pattern = /(?:^|\.)([^.[\]'"]+)|\[(\d+)\]|\[(["'])(.*?)\3\]/y;
  let at = 0;
  while (at < path.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(path);
    if (match === null) return null;
    const [, key, index, , quoted] = match;
    segments.push(index !== undefined ? Number(index) : (key ?? quoted ?? ''));
    at = pattern.lastIndex;
  }
  return segments;
}

/** Reads a path from a JSON value; `found` is false when a step is missing. */
export function queryJson(value: unknown, path: string): { found: boolean; value?: unknown } {
  const segments = parsePath(path.trim());
  if (segments === null) return { found: false };
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = typeof segment === 'number' ? segment : /^\d+$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= current.length) return { found: false };
      current = current[index] as unknown;
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, String(segment))) {
      current = (current as Record<string, unknown>)[String(segment)];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
