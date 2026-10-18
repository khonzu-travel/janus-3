import type {
  HeaderLine,
  Upstream,
  UpstreamFailureKind,
  UpstreamFailureReason,
  UpstreamRequest,
  UpstreamResponse,
} from '@janus/core';
import { rootCertificates } from 'node:tls';

import { Agent, request, type Dispatcher } from 'undici';

export interface UpstreamOptions {
  /** `recording.timeoutMs`: the bound over the whole exchange, from connecting to the last body byte. */
  readonly timeoutMs: number;
  /** `recording.maxResponseBytes`: a longer body is abandoned as `too-large`. */
  readonly maxResponseBytes: number;
  /** `runner.extraCaCerts`: PEM certificates trusted besides the default ones. */
  readonly extraCaCerts?: readonly string[];
  /** `runner.skipTlsVerify`: accept any certificate, unverified. */
  readonly skipTlsVerify?: boolean;
  /** Where each failure is logged with the underlying error text, which responses never carry. */
  readonly logger?: UpstreamLogger;
}

export interface UpstreamLogger {
  error(event: string, fields?: Readonly<Record<string, string | number>>): void;
}

export interface ClosableUpstream extends Upstream {
  /** Closes pooled connections; requests in progress are cut. */
  close(): Promise<void>;
}

/**
 * The recording upstream over `undici`: no redirect is
 * followed, no content is decoded, TLS is verified by the platform (unless
 * `skipTlsVerify` turns that off), and every
 * failure is reported by its kind and a reason from a fixed list, never by its
 * text. The text goes to the server log only.
 */
export function createUpstream(options: UpstreamOptions): ClosableUpstream {
  const extra = options.extraCaCerts ?? [];
  const agent = new Agent({
    connections: 16,
    pipelining: 1,
    connect: {
      ...(extra.length === 0 ? {} : { ca: [...rootCertificates, ...extra] }),
      ...(options.skipTlsVerify === true ? { rejectUnauthorized: false } : {}),
    },
  });
  return {
    send: (upstreamRequest, signal) => send(agent, upstreamRequest, signal, options),
    close: () => agent.close(),
  };
}

async function send(
  dispatcher: Dispatcher,
  upstreamRequest: UpstreamRequest,
  signal: AbortSignal,
  options: UpstreamOptions,
): Promise<UpstreamResponse> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, options.timeoutMs);
  const combined = AbortSignal.any([signal, timeout.signal]);
  const fail = (failure: UpstreamFailureKind, error?: unknown): UpstreamResponse => {
    const classified = failure === 'connect' ? classifyUpstreamError(error) : undefined;
    // A send the caller cancelled did not fail.
    if (!signal.aborted || timeout.signal.aborted)
      options.logger?.error('upstream-failed', {
        method: upstreamRequest.method,
        ...target(upstreamRequest.url),
        failure,
        ...(classified === undefined
          ? {}
          : { reason: classified.reason, code: classified.code ?? '-', error: classified.text }),
        ...(failure === 'timeout' ? { timeoutMs: options.timeoutMs } : {}),
        ...(failure === 'too-large' ? { maxResponseBytes: options.maxResponseBytes } : {}),
      });
    return classified === undefined
      ? { kind: 'failure', failure }
      : { kind: 'failure', failure, reason: classified.reason };
  };
  try {
    const response = await request(upstreamRequest.url, {
      dispatcher,
      method: upstreamRequest.method,
      headers: upstreamRequest.headers.flatMap(([name, value]) => [name, value]),
      body: upstreamRequest.body === null ? null : Buffer.from(upstreamRequest.body),
      signal: combined,
      // The exchange-wide timer decides; these only keep undici's own defaults out of the way.
      headersTimeout: options.timeoutMs + 1000,
      bodyTimeout: options.timeoutMs + 1000,
    });
    // A 304 has no body: Content-Length describes the corresponding 200 representation.
    // Do not consume it as a body length; undici also checks it while draining the stream.
    if (response.statusCode === 304) {
      response.body.destroy();
      return { kind: 'response', status: 304, headers: headerLines(response.headers), body: new Uint8Array() };
    }
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
      response.body.destroy();
      return fail('too-large');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response.body as AsyncIterable<Buffer>) {
      length += chunk.length;
      if (length > options.maxResponseBytes) {
        response.body.destroy();
        return fail('too-large');
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks, length);
    return {
      kind: 'response',
      status: response.statusCode,
      headers: headerLines(response.headers),
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    };
  } catch (error) {
    return fail(timeout.signal.aborted ? 'timeout' : 'connect', error);
  } finally {
    clearTimeout(timer);
  }
}

/** Response headers as field lines; repeated fields keep their order. */
function headerLines(headers: Readonly<Record<string, string | string[] | undefined>>): HeaderLine[] {
  const lines: HeaderLine[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) lines.push([name, item]);
  }
  return lines;
}

/** The URL as logged: origin and path, never the query. */
function target(url: string): { upstream: string; path: string } {
  try {
    const parsed = new URL(url);
    return { upstream: parsed.origin, path: parsed.pathname };
  } catch {
    return { upstream: '-', path: '-' };
  }
}

/** Node and undici error codes, by the reason Janus reports for them. */
const CODE_REASONS: Readonly<Record<string, UpstreamFailureReason>> = {
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_FAIL: 'dns',
  EAI_NODATA: 'dns',
  EAI_NONAME: 'dns',
  ECONNREFUSED: 'refused',
  EHOSTUNREACH: 'unreachable',
  EHOSTDOWN: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENETDOWN: 'unreachable',
  EADDRNOTAVAIL: 'unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connect-timeout',
  ETIMEDOUT: 'connect-timeout',
  ECONNRESET: 'reset',
  ECONNABORTED: 'reset',
  EPIPE: 'reset',
  UND_ERR_SOCKET: 'reset',
  UND_ERR_CLOSED: 'reset',
  EPROTO: 'tls',
  UND_ERR_INFO: 'invalid-response',
  UND_ERR_HEADERS_OVERFLOW: 'invalid-response',
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: 'invalid-response',
  UND_ERR_INVALID_ARG: 'invalid-request',
  UND_ERR_NOT_SUPPORTED: 'invalid-request',
  UND_ERR_REQ_CONTENT_LENGTH_MISMATCH: 'invalid-request',
  ERR_INVALID_URL: 'invalid-request',
  ERR_INVALID_ARG_TYPE: 'invalid-request',
  ERR_INVALID_ARG_VALUE: 'invalid-request',
  ERR_INVALID_HTTP_TOKEN: 'invalid-request',
  ERR_INVALID_CHAR: 'invalid-request',
  ERR_UNESCAPED_CHARACTERS: 'invalid-request',
};

function reasonForCode(code: string): UpstreamFailureReason | undefined {
  const known = CODE_REASONS[code];
  if (known !== undefined) return known;
  // OpenSSL's verification codes, e.g. DEPTH_ZERO_SELF_SIGNED_CERT, and Node's hostname check.
  if (/CERT|^UNABLE_TO_|^HOSTNAME_MISMATCH$/.test(code)) return 'certificate';
  if (/^ERR_(SSL|TLS)_/.test(code)) return 'tls';
  if (code.startsWith('HPE_')) return 'invalid-response';
  return undefined;
}

/**
 * Classifies a failed send by the error codes on the error, its causes and,
 * for an AggregateError (each address tried), its errors. The text joins
 * every message found, for the server log only.
 */
export function classifyUpstreamError(error: unknown): {
  readonly reason: UpstreamFailureReason;
  readonly code: string | undefined;
  readonly text: string;
} {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let first: { reason: UpstreamFailureReason; code: string } | undefined;
  let firstCode: string | undefined;
  while (queue.length > 0 && seen.size < 20) {
    const item = queue.shift();
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const record = item as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.message === 'string' && record.message !== '' && !messages.includes(record.message))
      messages.push(record.message);
    if (typeof record.code === 'string') {
      firstCode ??= record.code;
      const reason = reasonForCode(record.code);
      if (reason !== undefined) first ??= { reason, code: record.code };
    }
    if (record.cause !== undefined) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...(record.errors as unknown[]));
  }
  const text = messages.length === 0 ? (typeof error === 'string' ? error : 'unknown') : messages.join(' <- ');
  return { reason: first?.reason ?? 'unknown', code: first?.code ?? firstCode, text };
}
