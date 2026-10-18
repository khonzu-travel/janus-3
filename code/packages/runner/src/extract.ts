import { firstJsonMatch, isJsonMediaType, type GrammarContext, type HeaderLine } from '@janus/core';

import type { ExtractEntry } from './model.js';
import type { SendRequest } from './render.js';
import { parseTemplate, substitutionText, type ExchangeSource, type TemplateSegment } from './template.js';
import type { Renderer } from './variables.js';

/**
 * `extract`: copies values from the response, or the request
 * as sent, into run variables. Runs after the response arrives and before the
 * `after` scripts; every entry is evaluated, so one failure lists every
 * missing value.
 */

/** A response as the run received it. */
export interface ReceivedResponse {
  readonly status: number;
  readonly headers: readonly HeaderLine[];
  readonly body: Uint8Array;
  readonly timeMs: number;
}

export interface Exchange {
  readonly request: SendRequest;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly response: ReceivedResponse;
}

export interface ExtractOutcome {
  /** The variables to set, in entry order. */
  readonly values: ReadonlyMap<string, unknown>;
  /** Entries whose value was missing and that were not optional: the variable and the token. */
  readonly missing: readonly { readonly name: string; readonly token: string }[];
}

const MISSING = Symbol('missing');

export function evaluateExtract(
  extract: Readonly<Record<string, ExtractEntry>>,
  exchange: Exchange,
  renderer: Renderer,
  grammar: GrammarContext,
): ExtractOutcome {
  const values = new Map<string, unknown>();
  const missing: { name: string; token: string }[] = [];
  const reader = new ExchangeReader(exchange);
  for (const [name, entry] of Object.entries(extract)) {
    const long = typeof entry === 'string' ? null : entry;
    const source = typeof entry === 'string' ? entry : entry.value;
    const { template } = parseTemplate(source, { grammar, exchange: true });
    // Set inside `evaluate`; held in an object so the checks below are not narrowed away.
    const found: { missing: string | null } = { missing: null };
    const evaluate = (segment: TemplateSegment): unknown => {
      if (segment.kind !== 'exchange') return renderer.segmentValue(segment);
      const value = reader.read(segment.source);
      if (value === MISSING) {
        found.missing ??= segment.text;
        return undefined;
      }
      return value;
    };
    const [only] = template.segments;
    let value: unknown =
      template.segments.length === 1 && only !== undefined && only.kind !== 'text'
        ? evaluate(only)
        : template.segments.map((segment) => substitutionText(evaluate(segment))).join('');
    let missingToken = found.missing;
    if (missingToken === null && long?.match !== undefined) {
      const matched = new RegExp(long.match, 'u').exec(substitutionText(value));
      if (matched === null) missingToken = `match ${long.match}`;
      else value = matched.length > 1 ? (matched[1] ?? '') : matched[0];
    }
    if (missingToken === null) {
      values.set(name, value);
      continue;
    }
    if (long !== null && long.default !== undefined) values.set(name, long.default);
    else if (long?.optional !== true) missing.push({ name, token: missingToken });
  }
  renderer.assertResolved();
  return { values, missing };
}

/** Reads one source of an exchange; the body is parsed at most once per side. */
class ExchangeReader {
  readonly #exchange: Exchange;
  #responseJson: { value: unknown } | undefined;
  #requestJson: { value: unknown } | undefined;

  constructor(exchange: Exchange) {
    this.#exchange = exchange;
  }

  read(source: ExchangeSource): unknown {
    const { request, response, pathParams } = this.#exchange;
    if (source.from === 'response') {
      switch (source.part) {
        case 'status':
          return response.status;
        case 'timeMs':
          return response.timeMs;
        case 'text':
          return new TextDecoder().decode(response.body);
        case 'header':
          return firstHeader(response.headers, source.name) ?? MISSING;
        case 'cookie':
          return responseCookie(response.headers, source.name) ?? MISSING;
        case 'body':
          this.#responseJson ??= { value: jsonBody(response.headers, response.body) };
          return match(source.path, this.#responseJson.value);
      }
    }
    switch (source.part) {
      case 'url':
        return request.url;
      case 'header':
        return firstHeader(request.headers, source.name) ?? MISSING;
      case 'query':
        return new URL(request.url).searchParams.get(source.name) ?? MISSING;
      case 'path':
        return Object.hasOwn(pathParams, source.name) ? pathParams[source.name] : MISSING;
      case 'body':
        this.#requestJson ??= { value: jsonBody(request.headers, request.body) };
        return match(source.path, this.#requestJson.value);
    }
  }
}

function match(path: string, document: unknown): unknown {
  if (document === MISSING) return MISSING;
  try {
    const found = firstJsonMatch(path, document);
    return found === undefined ? MISSING : found;
  } catch {
    return MISSING;
  }
}

/** The first value of a header, compared case-insensitively. */
export function firstHeader(headers: readonly HeaderLine[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([written]) => written.toLowerCase() === lower)?.[1];
}

/** A cookie value the response set with `Set-Cookie`, the last one for the name winning. */
function responseCookie(headers: readonly HeaderLine[], name: string): string | undefined {
  let found: string | undefined;
  for (const [written, value] of headers) {
    if (written.toLowerCase() !== 'set-cookie') continue;
    const pair = value.split(';', 1)[0] ?? '';
    const equals = pair.indexOf('=');
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() === name) found = pair.slice(equals + 1).trim();
  }
  return found;
}

/** The parsed JSON body when the `Content-Type` is JSON (`application/json` or `+json`). */
function jsonBody(headers: readonly HeaderLine[], body: Uint8Array | null): unknown {
  const type = firstHeader(headers, 'content-type');
  if (body === null || type === undefined || !isJsonMediaType(type)) return MISSING;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    return MISSING;
  }
}
