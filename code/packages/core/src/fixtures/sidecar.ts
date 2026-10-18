import { utf8DecodeStrict } from '../bytes.js';
import { hasFieldControl, HOP_BY_HOP_HEADERS, isFieldName, isFixtureFieldValue } from '../http/headers.js';
import { parseMediaType } from '../http/media-type.js';
import type { StartupErrorCode } from '../types/index.js';
import { scanJson, type TextPosition } from './json.js';

export interface Problem {
  readonly code: StartupErrorCode;
  readonly message: string;
  /** Where in the file, when the problem can be located. */
  readonly position?: TextPosition;
  /** The offending header name or JSON character. */
  readonly token?: string;
}

/** Headers Janus computes from the bytes it actually sends; a fixture value is dropped. */
export const JANUS_COMPUTED_HEADERS: ReadonlySet<string> = new Set(['content-length', 'date', 'content-encoding']);

/** The prefix reserved for Janus's own diagnostic headers. */
export const RESERVED_HEADER_PREFIX = 'x-mock-';

export interface LocatedHeader {
  /** Lower-cased field name. */
  readonly name: string;
  /** The name as written in the sidecar. */
  readonly written: string;
  readonly position: TextPosition;
}

export interface SidecarResult {
  /** Replayed headers: lower-cased field name → values. Never Content-Type or a Janus-computed header. */
  readonly headers: ReadonlyMap<string, readonly string[]>;
  /** The sidecar's `Content-Type`, when it sets one; `build.ts` applies it. */
  readonly contentType?: { readonly value: string; readonly position: TextPosition };
  /** Janus-computed headers the sidecar sets; they are dropped when served. */
  readonly computed: readonly LocatedHeader[];
  /** `Access-Control-*` headers dropped because fixture CORS is on. */
  readonly cors: readonly LocatedHeader[];
  readonly problems: readonly Problem[];
}

/**
 * Parses and classifies a `<status>.headers.json` sidecar:
 * hop-by-hop and `X-Mock-*` headers are errors, Janus-computed headers are
 * reported for dropping, and everything else is replayed as written.
 */
export function parseHeaderSidecar(bytes: Uint8Array, options: { readonly dropCors?: boolean } = {}): SidecarResult {
  const headers = new Map<string, readonly string[]>();
  const problems: Problem[] = [];
  const computed: LocatedHeader[] = [];
  const cors: LocatedHeader[] = [];
  let contentType: SidecarResult['contentType'];
  const result = (): SidecarResult => ({
    headers,
    computed,
    cors,
    problems,
    ...(contentType === undefined ? {} : { contentType }),
  });

  const parsed = parseJson(bytes);
  if (!parsed.ok) {
    problems.push({ code: 'invalid-headers', ...parsed.problem });
    return result();
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({
      code: 'invalid-headers',
      message: 'a header sidecar must contain a JSON object of header names to values',
    });
    return result();
  }

  const scan = scanJson(parsed.text);
  const members = scan.ok ? scan.members : new Map<string, TextPosition>();
  let name = '';
  const positionOf = (): TextPosition => members.get(name) ?? { line: 1, column: 1 };
  const fail = (message: string, code: StartupErrorCode = 'invalid-headers'): void => {
    const position = members.get(name);
    problems.push({ code, message, token: name, ...(position === undefined ? {} : { position }) });
  };

  const seen = new Map<string, string>();
  for (const [key, raw] of Object.entries(value)) {
    name = key;
    if (!isFieldName(name)) {
      fail(`"${name}" is not a valid HTTP field name`);
      continue;
    }
    const lower = name.toLowerCase();
    const previous = seen.get(lower);
    if (previous !== undefined) {
      fail(`"${name}" duplicates "${previous}"; header names are case-insensitive`);
      continue;
    }
    seen.set(lower, name);

    const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : null;
    if (values === null || values.length === 0 || !values.every((item) => typeof item === 'string')) {
      fail(`"${name}" must be a string or a non-empty array of strings`);
      continue;
    }
    const strings = values;
    // Any text without control characters; it is sent as its UTF-8 bytes.
    if (strings.some(hasFieldControl)) {
      fail(`"${name}" has a value containing CR, LF, NUL, or another control character`);
      continue;
    }
    if (!strings.every(isFixtureFieldValue)) {
      fail(`"${name}" has a value that is not valid Unicode text (an unpaired surrogate escape)`);
      continue;
    }
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      fail(`"${name}" is a hop-by-hop header and cannot be set by a fixture`);
      continue;
    }
    if (lower.startsWith(RESERVED_HEADER_PREFIX)) {
      fail(`"${name}" is reserved: Janus adds X-Mock-* diagnostic headers itself`, 'reserved-header');
      continue;
    }
    if (JANUS_COMPUTED_HEADERS.has(lower)) {
      computed.push({ name: lower, written: name, position: positionOf() });
      continue;
    }
    if (options.dropCors === true && lower.startsWith('access-control-')) {
      cors.push({ name: lower, written: name, position: positionOf() });
      continue;
    }
    if (lower === 'content-type') {
      const single = strings.length === 1 ? (strings[0] ?? '') : null;
      if (single === null) fail('"Content-Type" must be a single value');
      // A dynamic value here is reported by the token scan, not as a bad media type.
      else if (single.includes('{{$')) continue;
      else if (parseMediaType(single) === null) fail(`"Content-Type" value "${single}" is not a media type`);
      else contentType = { value: single.trim(), position: positionOf() };
      continue;
    }
    headers.set(lower, Object.freeze([...strings]));
  }
  return result();
}

export type JsonResult =
  | { readonly ok: true; readonly value: unknown; readonly text: string }
  | { readonly ok: false; readonly problem: Omit<Problem, 'code'> };

/**
 * Syntax-checks JSON bytes. A failure is located and described the same way on
 * every engine, and never quotes file content beyond the offending character.
 */
export function parseJson(bytes: Uint8Array): JsonResult {
  const text = utf8DecodeStrict(bytes);
  if (text === null) return { ok: false, problem: { message: 'the file is not valid UTF-8' } };
  try {
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch {
    const scan = scanJson(text);
    if (scan.ok) return { ok: false, problem: { message: 'invalid JSON' } };
    return {
      ok: false,
      problem: {
        message: `invalid JSON: ${scan.message}`,
        position: scan.position,
        ...(scan.token === undefined ? {} : { token: scan.token }),
      },
    };
  }
}
