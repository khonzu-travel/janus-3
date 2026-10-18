import type { HeaderLine } from '@janus/core';

import type { NameValue, RequestBody } from './model.js';
import { pathParameterNames } from './documents.js';
import { RenderError, type Renderer } from './variables.js';

/**
 * Building the request to send: templates are rendered
 * as text, path parameters are encoded as one segment each, and the body
 * gets its default `Content-Type` unless a header sets one.
 */

/** What a step sends, in either mode. */
export interface SendRequest {
  /** Absolute `http` or `https` URL. */
  readonly url: string;
  readonly method: string;
  /** In order, names as written. */
  readonly headers: readonly HeaderLine[];
  readonly body: Uint8Array | null;
}

/** A request before rendering: the document's members after `before` scripts changed them. */
export interface RequestDraft {
  method: string;
  url: string;
  /** Active headers, inherited ones first. */
  headers: NameValue[];
  body: RequestBody | undefined;
}

/** Why a step failed before anything was sent. */
export class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

export interface RenderedRequest {
  readonly request: SendRequest;
  /** The `pathParams` values as sent. */
  readonly pathParams: Readonly<Record<string, string>>;
}

export interface RenderPorts {
  /** Reads a body file below `runner.root`; null when it is missing or not allowed. */
  readFile(path: string): Promise<Uint8Array | null>;
  randomBytes(count: number): Uint8Array;
}

/**
 * Combines inherited and request headers: outermost first; a
 * disabled entry removes every inherited header of its name and is not sent.
 */
export function combineHeaders(levels: readonly (readonly NameValue[] | undefined)[]): NameValue[] {
  let combined: NameValue[] = [];
  for (const level of levels) {
    for (const header of level ?? []) {
      if (header.disabled === true) {
        const name = header.name.toLowerCase();
        combined = combined.filter((inherited) => inherited.name.toLowerCase() !== name);
      }
    }
    for (const header of level ?? []) {
      if (header.disabled !== true) combined.push({ name: header.name, value: header.value });
    }
  }
  return combined;
}

/**
 * Renders a draft. Every template is rendered before any
 * failure is raised, so `unresolved-variable` names every undefined variable.
 */
export async function renderRequest(
  draft: RequestDraft,
  pathParams: Readonly<Record<string, string>>,
  baseDirectory: string,
  renderer: Renderer,
  ports: RenderPorts,
): Promise<RenderedRequest> {
  const url = renderer.text(draft.url);
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(pathParams)) params[name] = renderer.text(value);
  const headers: HeaderLine[] = draft.headers.map((header) => [header.name, renderer.text(header.value)] as const);
  const body = draft.body === undefined ? null : renderBodyText(draft.body, renderer);
  renderer.assertResolved();

  const finalUrl = buildUrl(url, params);
  for (const [name, value] of headers) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new StepFailure('invalid-header', `"${name}" is not a header name`);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new StepFailure('invalid-header', `The ${name} header renders to text with CR, LF or NUL`);
    }
  }
  const has = (name: string): boolean => headers.some(([written]) => written.toLowerCase() === name);
  let bytes: Uint8Array | null = null;
  if (draft.body !== undefined && body !== null) {
    const built = await encodeBody(draft.body, body, baseDirectory, ports);
    bytes = built.bytes;
    if (built.contentType !== null && !has('content-type')) headers.push(['Content-Type', built.contentType]);
  }
  return {
    request: Object.freeze({
      url: finalUrl,
      method: draft.method.toUpperCase(),
      headers: Object.freeze(headers),
      body: bytes,
    }),
    pathParams: Object.freeze(params),
  };
}

/** The rendered text parts of a body; files are read later. */
type RenderedBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fields'; readonly fields: readonly (readonly [string, string])[] }
  | {
      readonly kind: 'parts';
      readonly parts: readonly (
        | { readonly name: string; readonly value: string }
        | { readonly name: string; readonly file: string; readonly contentType?: string }
      )[];
    }
  | { readonly kind: 'file' };

function renderBodyText(body: RequestBody, renderer: Renderer): RenderedBody {
  switch (body.type) {
    case 'json':
    case 'text':
    case 'xml':
      return { kind: 'text', text: renderer.text(body.text) };
    case 'graphql': {
      const query = renderer.text(body.query);
      const variables = body.variables === undefined ? '' : renderer.text(body.variables).trim();
      // Substituted as text, like a JSON body: the variables need not parse.
      const text = `{"query":${JSON.stringify(query)}${variables === '' ? '' : `,"variables":${variables}`}}`;
      return { kind: 'text', text };
    }
    case 'form':
      return {
        kind: 'fields',
        fields: body.fields
          .filter((field) => field.disabled !== true)
          .map((field) => [renderer.text(field.name), renderer.text(field.value)] as const),
      };
    case 'multipart':
      return {
        kind: 'parts',
        parts: body.parts
          .filter((part) => part.disabled !== true)
          .map((part) =>
            'value' in part
              ? { name: part.name, value: renderer.text(part.value) }
              : {
                  name: part.name,
                  file: part.file,
                  ...(part.contentType === undefined ? {} : { contentType: part.contentType }),
                },
          ),
      };
    case 'file':
      return { kind: 'file' };
  }
}

const DEFAULT_TYPES = { json: 'application/json', text: 'text/plain; charset=utf-8', xml: 'application/xml' } as const;

async function encodeBody(
  body: RequestBody,
  rendered: RenderedBody,
  baseDirectory: string,
  ports: RenderPorts,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const encoder = new TextEncoder();
  const read = async (file: string): Promise<Uint8Array> => {
    const path = resolveBodyPath(baseDirectory, file);
    const bytes = path === null ? null : await ports.readFile(path);
    if (bytes === null) {
      throw new StepFailure('missing-file', `The body file "${file}" is missing or outside the requests root`);
    }
    return bytes;
  };
  if (rendered.kind === 'text') {
    const type =
      body.type === 'graphql'
        ? 'application/json'
        : body.type in DEFAULT_TYPES
          ? DEFAULT_TYPES[body.type as keyof typeof DEFAULT_TYPES]
          : null;
    return { bytes: encoder.encode(rendered.text), contentType: type };
  }
  if (rendered.kind === 'fields') {
    const params = new URLSearchParams();
    for (const [name, value] of rendered.fields) params.append(name, value);
    return { bytes: encoder.encode(params.toString()), contentType: 'application/x-www-form-urlencoded' };
  }
  if (rendered.kind === 'parts') {
    const boundary = `----janus${[...ports.randomBytes(12)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const chunks: Uint8Array[] = [];
    for (const part of rendered.parts) {
      const name = quoteName(part.name);
      if ('value' in part) {
        chunks.push(
          encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${part.value}\r\n`),
        );
      } else {
        const bytes = await read(part.file);
        const filename = quoteName(part.file.slice(part.file.lastIndexOf('/') + 1));
        chunks.push(
          encoder.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
          ),
          bytes,
          encoder.encode('\r\n'),
        );
      }
    }
    chunks.push(encoder.encode(`--${boundary}--\r\n`));
    return { bytes: concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  if (body.type !== 'file') throw new Error('unreachable');
  return { bytes: await read(body.file), contentType: body.contentType ?? 'application/octet-stream' };
}

function quoteName(name: string): string {
  return name.replace(/["\\\r\n]/g, (char) => (char === '"' ? '%22' : char === '\\' ? '\\\\' : ' '));
}

/** A body file's path below the root, or null when it would leave it. */
export function resolveBodyPath(baseDirectory: string, file: string): string | null {
  const parts = baseDirectory === '' ? [] : baseDirectory.split('/');
  for (const part of file.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (part.includes('\\') || part.includes('\0')) return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * The URL to send: each `:name` path segment replaced by its
 * percent-encoded value; it must be an absolute `http` or `https` URL with
 * no user name or password. The fragment is dropped.
 */
export function buildUrl(rendered: string, params: Readonly<Record<string, string>>): string {
  const names = pathParameterNames(rendered);
  let url = rendered;
  if (names.length > 0) {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(.*)$/s.exec(rendered);
    if (match !== null) {
      const path = (match[2] ?? '')
        .split('/')
        .map((part) => {
          const name = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(part)?.[1];
          return name !== undefined && Object.hasOwn(params, name) ? encodeURIComponent(params[name] ?? '') : part;
        })
        .join('/');
      url = `${match[1] ?? ''}${path}${match[3] ?? ''}`;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StepFailure('invalid-url', `The URL "${truncate(url)}" is not an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StepFailure('invalid-url', `The URL "${truncate(url)}" is not an http or https URL`);
  }
  if (parsed.username !== '' || parsed.password !== '' || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)) {
    throw new StepFailure('invalid-url', 'The URL must not contain a user name or password');
  }
  parsed.hash = '';
  return parsed.href;
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export { RenderError };
