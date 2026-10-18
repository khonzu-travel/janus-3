import { toHex, utf8DecodeStrict, utf8Encode, toBase64 } from '../bytes.js';
import { compareStrings, sha256 } from '../canonical.js';
import { parseFileName } from '../fixtures/filename.js';
import { JANUS_COMPUTED_HEADERS, RESERVED_HEADER_PREFIX } from '../fixtures/sidecar.js';
import { isBodylessStatus } from '../fixtures/status.js';
import { rfc3339 } from '../dynamic/time.js';
import { HOP_BY_HOP_HEADERS, isFieldName, isFieldValue } from '../http/headers.js';
import { isLanguageTag } from '../http/language.js';
import { extensionForMediaType, parseMediaType } from '../http/media-type.js';
import type { HeaderMap } from '../types/index.js';
import { connectionListed } from './forward.js';
import type { CaptureLogEntry, CapturePlan, CaptureReservation, HeaderLine } from './ports.js';
import type { Registration } from './registrations.js';

/** The provenance format. */
export const CAPTURE_FORMAT = 'janus.capture.v1';

/** Why a stored response differs from what the upstream sent. */
export type CaptureNoteCode = 'body-encoded' | 'bodyless-status-body-discarded' | 'invalid-content-type';

export interface CaptureNote {
  readonly code: CaptureNoteCode;
  readonly message: string;
}

/** The exchange as it happened: the request as received and the upstream's response. */
export interface CaptureInput {
  readonly reservation: CaptureReservation;
  readonly registration: Registration;
  readonly request: {
    readonly method: string;
    /** As received, query included. */
    readonly target: string;
    readonly params: Readonly<Record<string, string>>;
    readonly headers: HeaderMap;
    /** Decoded. */
    readonly body: Uint8Array | null;
    /** The `Content-Encoding` codings removed from `body`, in the order applied. */
    readonly codings?: readonly string[];
  };
  readonly response: {
    readonly status: number;
    readonly headers: readonly HeaderLine[];
    readonly body: Uint8Array;
  };
  /** Wall-clock epoch ms when the request was claimed, and when the response arrived. */
  readonly startedAt: number;
  readonly finishedAt: number;
  /**
   * Set for an exchange the request runner sent: the URL as
   * sent, and the run, step and request ID it belongs to. The registration is
   * then the one the runner derived from the request's route.
   */
  readonly runner?: CaptureRunner;
}

/** A runner capture's origin. */
export interface CaptureRunner {
  readonly url: string;
  readonly run: { readonly id: string; readonly step: number; readonly request: string };
}

/** The response file's name and bytes, and what was noted on the way. */
interface ResponseFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** The media type the file name carries; null for a bodyless status. */
  readonly mediaType: string | null;
  /** The locale the file name carries. */
  readonly locale: string | null;
  readonly notes: readonly CaptureNote[];
  /** Content-Type removed because it is not a usable media type. */
  readonly dropContentType: boolean;
}

/**
 * Plans every file of a captured exchange: the request as
 * received, the response in fixture file format with its header sidecar, the
 * provenance file, and the log line. Values are kept exactly as exchanged.
 */
export function planCapture(input: CaptureInput): CapturePlan {
  const { reservation, registration, request, response } = input;
  const file = responseFile(response.status, response.headers, response.body);
  const sidecar = sidecarHeaders(response.headers, file);
  const durationMs = Math.max(0, Math.round(input.finishedAt - input.startedAt));
  const status = String(response.status);
  const files = [
    { name: 'request.json', bytes: json(requestDocument(input)) },
    { name: file.name, bytes: file.bytes },
    ...(Object.keys(sidecar.headers).length === 0
      ? []
      : [{ name: `${status}.headers.json`, bytes: json(sidecar.headers) }]),
    {
      name: `${status}.meta.json`,
      bytes: json({
        format: CAPTURE_FORMAT,
        source: input.runner === undefined ? 'recording' : 'runner',
        scenario: reservation.scenario,
        exchange: reservation.exchange,
        capturedAt: rfc3339(input.finishedAt),
        durationMs,
        registration: {
          method: registration.endpoint.method,
          path: registration.endpoint.path,
          upstream: registration.endpoint.upstream,
        },
        response: {
          status: response.status,
          file: file.name,
          byteLength: file.bytes.length,
          upstreamByteLength: response.body.length,
          digest: captureDigest(file.bytes),
        },
        removedHeaders: sidecar.removed,
        notes: file.notes,
      }),
    },
  ];
  const log: CaptureLogEntry = {
    exchange: reservation.exchange,
    at: rfc3339(input.finishedAt),
    method: request.method,
    target: request.target,
    registration: registration.endpoint.path,
    outcome: 'captured',
    status: response.status,
    durationMs,
    ...(input.runner === undefined
      ? {}
      : { source: 'runner' as const, run: input.runner.run.id, request: input.runner.run.request }),
  };
  return Object.freeze({ files: Object.freeze(files), log: Object.freeze(log) });
}

/** `sha256:` and the hex digest of a response file's bytes. */
export function captureDigest(bytes: Uint8Array): string {
  return `sha256:${toHex(sha256(bytes))}`;
}

/** `request.json`. */
function requestDocument(input: CaptureInput): unknown {
  const { request, registration } = input;
  const headers: Record<string, readonly string[]> = {};
  for (const [name, values] of Object.entries(request.headers)) headers[name.toLowerCase()] = [...values];
  const { runner } = input;
  return {
    ...(runner === undefined ? {} : { source: 'runner', url: runner.url, run: { ...runner.run } }),
    method: request.method,
    target: request.target,
    registration: { method: registration.endpoint.method, path: registration.endpoint.path },
    params: request.params,
    headers,
    body: bodyDocument(request.body),
    ...(request.codings === undefined || request.codings.length === 0 ? {} : { codings: [...request.codings] }),
  };
}

/** Body bytes as text when they are valid UTF-8, otherwise base64. */
export function bodyDocument(body: Uint8Array | null): { encoding: 'utf8' | 'base64'; data: string } | null {
  if (body === null) return null;
  const text = utf8DecodeStrict(body);
  // A BOM would be dropped by the decoder, so such bodies stay base64 to keep every byte.
  if (text !== null && !(body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)) {
    return { encoding: 'utf8', data: text };
  }
  return { encoding: 'base64', data: toBase64(body) };
}

/** The response file. */
function responseFile(status: number, headers: readonly HeaderLine[], body: Uint8Array): ResponseFile {
  const notes: CaptureNote[] = [];
  const values = (name: string): string[] =>
    headers.filter(([written]) => written.toLowerCase() === name).map(([, value]) => value);
  const encoding = values('content-encoding')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '' && value !== 'identity');
  const contentTypes = values('content-type');
  const parsed = contentTypes.length === 1 ? parseMediaType(contentTypes[0] ?? '') : null;
  const invalidType = contentTypes.length > 0 && parsed === null;

  if (isBodylessStatus(status)) {
    if (body.length > 0) {
      notes.push({
        code: 'bodyless-status-body-discarded',
        message: `status ${String(status)} is bodyless, so the ${String(body.length)}-byte body the upstream sent was not stored`,
      });
    }
    return {
      name: String(status),
      bytes: new Uint8Array(),
      mediaType: null,
      locale: null,
      notes,
      dropContentType: true,
    };
  }
  if (invalidType) {
    notes.push({
      code: 'invalid-content-type',
      message:
        'the upstream Content-Type is not a single media type, so the body is stored as application/octet-stream',
    });
  }

  const languages = values('content-language');
  const tag = languages.length === 1 ? (languages[0] ?? '').trim() : '';
  const locale = tag !== '' && !tag.includes(',') && isLanguageTag(tag) ? tag : null;
  const localePart = locale === null ? '' : `_[${locale}]`;

  let stored = body;
  if (encoding.length > 0) {
    stored = new Uint8Array();
    notes.push({
      code: 'body-encoded',
      message: `the body was sent with Content-Encoding ${encoding.join(', ')}, which fixtures cannot serve, so it was not stored`,
    });
  }

  const candidates: { name: string; mediaType: string }[] = [];
  if (parsed !== null) {
    const essence = `${parsed.type}/${parsed.subtype}`;
    const short = extensionForMediaType(essence);
    if (short !== null) candidates.push({ name: `${String(status)}${localePart}.${short}`, mediaType: essence });
    else {
      const extension =
        parsed.subtype === 'json' || parsed.subtype.endsWith('+json')
          ? 'json'
          : essence === 'text/xml' || parsed.subtype.endsWith('+xml')
            ? 'xml'
            : 'bin';
      candidates.push({
        name: `${String(status)}${localePart}_{${parsed.type}-${parsed.subtype}}.${extension}`,
        mediaType: essence,
      });
    }
  }
  candidates.push({ name: `${String(status)}${localePart}.bin`, mediaType: 'application/octet-stream' });
  // Only a name the fixture grammar reads back as the same response is used; `.bin` always is.
  const chosen =
    candidates.find((candidate) => {
      const read = parseFileName(candidate.name);
      return (
        read.kind === 'response' &&
        read.status === status &&
        read.mediaType === candidate.mediaType &&
        read.locale === locale &&
        read.variant === null
      );
    }) ?? candidates[candidates.length - 1];
  if (chosen === undefined) throw new Error('a .bin name is always available');
  return { name: chosen.name, bytes: stored, mediaType: chosen.mediaType, locale, notes, dropContentType: invalidType };
}

/**
 * `<status>.headers.json` in the sidecar format: the
 * upstream's values as received, without the headers a sidecar cannot or need
 * not hold. Returns the sidecar object and the removed names, sorted.
 */
function sidecarHeaders(
  lines: readonly HeaderLine[],
  file: ResponseFile,
): { readonly headers: Record<string, string | string[]>; readonly removed: readonly string[] } {
  const listed = connectionListed(lines);
  const removed = new Set<string>();
  const kept = new Map<string, string[]>();
  for (const [written, value] of lines) {
    const name = written.toLowerCase();
    const drop =
      HOP_BY_HOP_HEADERS.has(name) ||
      listed.has(name) ||
      name.startsWith(RESERVED_HEADER_PREFIX) ||
      JANUS_COMPUTED_HEADERS.has(name) ||
      !isFieldName(name) ||
      !isFieldValue(value) ||
      (name === 'content-type' && (file.dropContentType || file.mediaType === null)) ||
      (name === 'content-language' && file.locale !== null);
    if (drop) {
      removed.add(name);
      continue;
    }
    kept.set(name, [...(kept.get(name) ?? []), value]);
  }
  // A Content-Type that only repeats the file name's media type is redundant there.
  const contentType = kept.get('content-type');
  if (contentType !== undefined) {
    const parsed = contentType.length === 1 ? parseMediaType(contentType[0] ?? '') : null;
    if (parsed !== null && parsed.parameters.length === 0 && `${parsed.type}/${parsed.subtype}` === file.mediaType) {
      kept.delete('content-type');
      removed.add('content-type');
    }
  }
  const headers: Record<string, string | string[]> = {};
  for (const [name, values] of kept) headers[name] = values.length === 1 ? (values[0] ?? '') : values;
  return { headers, removed: Object.freeze([...removed].sort(compareStrings)) };
}

function json(value: unknown): Uint8Array {
  return utf8Encode(`${JSON.stringify(value, null, 2)}\n`);
}
