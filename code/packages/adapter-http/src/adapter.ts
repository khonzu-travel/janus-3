import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import {
  ACCEPTED_REQUEST_ENCODINGS,
  encodeErrorEnvelope,
  ERROR_CONTENT_TYPE,
  fixtureCorsHeaders,
  formatPath,
  isLoopbackHost,
  isLoopbackIp,
  normalizeTarget,
  parseAuthority,
  parseContentEncoding,
  parseExpect,
  type Engine,
  type FaultTrace,
  type FixtureCorsSettings,
  type HeaderLine,
  type HeaderMap,
  type RecordingTrace,
  type RequestDescription,
  type RequestErrorCode,
  type ResponseDescription,
  type TransportDirective,
  wireHeaders,
} from '@janus/core';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import {
  atlasRoute,
  envelopeLimit,
  EVENT_STREAM_CONTENT_TYPE,
  ENVELOPE_OVERHEAD_BYTES,
  formatEvent,
  formatOpening,
  handleAtlasRequest,
  isAtlasPath,
  type AtlasCaptureService,
  type AtlasContext,
  type AtlasReloadService,
  type SessionWriteRecord,
} from './atlas.js';
import type { AtlasRunnerService } from './runner.js';
import { allowOrigin, isPreflight, NO_CORS, readOrigin, type CorsSettings } from './cors.js';
import { handleUiRequest, isUiPath, type UiAssets } from './ui.js';
import { trackHeaderSizes } from './header-size.js';
import { compressBody, decodeBody, faultBytes } from './transport.js';

/** Default maximum request body size: 1 MiB. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/** Transport limits. Each is enforced before resolution with a classified error. */
export interface RequestLimits {
  /** Longest request target in bytes; longer is `414 url-too-long`. */
  readonly maxUrlBytes: number;
  /** Largest request header section in bytes, request line excluded; larger is `431 headers-too-large`. */
  readonly maxHeaderBytes: number;
  /** Largest request body in bytes; larger is `413 request-too-large`. */
  readonly maxBodyBytes: number;
  /** Largest decoded request body in bytes; larger is `413 decoded-body-too-large`. */
  readonly maxDecodedBodyBytes: number;
}

export const DEFAULT_LIMITS: RequestLimits = Object.freeze({
  maxUrlBytes: 8192,
  maxHeaderBytes: 16384,
  maxBodyBytes: DEFAULT_BODY_LIMIT,
  maxDecodedBodyBytes: 4 * 1024 * 1024,
});

/** No fixture CORS: `cors.fixtures.origins` is empty. */
const NO_FIXTURE_CORS: FixtureCorsSettings = Object.freeze({ origins: [], credentials: false, maxAge: 600 });

/** Room for the method and version around the target in the request line, which Node counts with the headers. */
const REQUEST_LINE_SLACK = 64;

/** How UI requests appear in the request log; their paths are not normalized. */
const UI_LOG_PATH = '/_janus/ui';

/** Response header carrying the adapter-generated correlation value. */
export const REQUEST_ID_HEADER = 'x-janus-request-id';

export interface RequestRecord {
  readonly requestId: string;
  readonly method: string;
  /** Canonical normalised path, or "-" when the target was invalid or never resolved. */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  /** A recorded request: the exchange, its outcome, and the upstream by origin only. */
  readonly recording?: RecordingTrace;
  /** A resolved fixture request: the delay waited, the fault performed, and the codings. */
  readonly transport?: {
    readonly latencyMs: number;
    readonly fault: Pick<FaultTrace, 'kind' | 'rule' | 'step'> | null;
    readonly requestCodings: readonly string[];
    readonly responseCoding: TransportDirective['coding'];
  };
}

/** Bounds of `GET /_janus/events`. */
export interface EventStreamOptions {
  /** Concurrent streams; more get `503 service-unavailable`. */
  readonly maxStreams?: number;
  /** Interval of the keep-alive comment. */
  readonly heartbeatMs?: number;
  /** The reconnect delay sent once when a stream opens. */
  readonly retryMs?: number;
}

export const DEFAULT_EVENT_STREAMS: Required<EventStreamOptions> = Object.freeze({
  maxStreams: 32,
  heartbeatMs: 25_000,
  retryMs: 3000,
});

export interface HttpAdapterOptions {
  /** Serves fixtures through `resolve` and the reserved `/_janus` routes through `atlas`. */
  readonly engine: Engine;
  /** `atlas.resolve`: false leaves `POST /_janus/resolve` unmounted. Defaults to true. */
  readonly resolve?: boolean;
  /** Mounts `/_janus/reload` and `/_janus/events`. */
  readonly reload?: AtlasReloadService;
  readonly events?: EventStreamOptions;
  /** `cors.origins` and `cors.maxAge`. Defaults to no CORS. */
  readonly cors?: CorsSettings;
  /** `cors.fixtures`: CORS for fixture paths, never for `/_janus`. Defaults to none. */
  readonly fixtureCors?: FixtureCorsSettings;
  /**
   * The loaded UI: mounts `/_janus/ui`. Absent when the UI is
   * disabled or not built; the path is then an unknown Atlas path.
   */
  readonly ui?: UiAssets | null;
  /** The captures directory, read by `/_janus/captures` and announced on `/_janus/events`. */
  readonly captures?: AtlasCaptureService | null;
  /** The request runner: mounts its routes and announces `requests` and `run` events. */
  readonly runner?: AtlasRunnerService | null;
  /**
   * The configured listen host (`server.host`). On a loopback listener, a
   * `Host` naming it is accepted besides localhost names.
   */
  readonly host?: string;
  /** Request limits; each defaults to `DEFAULT_LIMITS`. */
  readonly limits?: Partial<RequestLimits>;
  /**
   * Called with each fixture request Janus resolved and the response it
   * chose, before the response is written. The request runner reads its
   * mock-mode decisions from it (the merged Requests view's "Why").
   */
  readonly onResolved?: (requestId: string, request: RequestDescription, response: ResponseDescription) => void;
  /** Called once per completed request. Receives no header values or bodies. */
  readonly onRequestComplete?: (record: RequestRecord) => void;
  /** Called after each session write. */
  readonly onSessionWrite?: (record: SessionWriteRecord) => void;
  /** Called for unexpected failures that become `500 internal-error`. */
  readonly onInternalError?: (requestId: string, error: unknown) => void;
}

/**
 * Builds the Fastify application that serves an engine over HTTP. Fastify
 * routes nothing: every request reaches one catch-all handler, which passes the
 * raw target to the engine and writes out whatever response it describes.
 * The adapter owns only transport concerns: framing, request limits, request
 * IDs, the reserved Atlas routes (`./atlas.ts`), and `413`/`414`/`431`/`500` errors.
 */
export function createHttpAdapter(options: HttpAdapterOptions): FastifyInstance {
  const { engine, onRequestComplete, onInternalError } = options;
  const limits: RequestLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const streamLimits = { ...DEFAULT_EVENT_STREAMS, ...options.events };
  const atlasContext: AtlasContext = {
    atlas: engine.atlas,
    resolve: { enabled: options.resolve ?? true, maxBodyBytes: limits.maxBodyBytes },
    reload: options.reload ?? null,
    ui: (options.ui ?? null) !== null,
    cors: options.cors ?? NO_CORS,
    sessions: engine.sessions,
    captures: options.captures ?? null,
    promotions: engine.promotions,
    runner: options.runner ?? null,
    ...(options.onSessionWrite === undefined ? {} : { onSessionWrite: options.onSessionWrite }),
  };
  const { cors } = atlasContext;
  /** Requests answered by an Atlas route: they get CORS headers. */
  const atlasRequests = new WeakSet<FastifyRequest>();
  const resolvedPaths = new WeakMap<FastifyRequest, string>();
  const recordings = new WeakMap<FastifyRequest, RecordingTrace>();
  /**
   * The `Content-Type` lines core chose for an engine response. Fastify adds
   * `application/octet-stream` to a body without a valid single type; a relayed
   * response keeps the upstream's lines exactly.
   */
  const contentTypes = new WeakMap<FastifyRequest, readonly string[]>();
  /** Closers of the open event streams; shutdown runs them all without waiting for clients. */
  const streams = new Set<() => void>();
  const fixtureCors = options.fixtureCors ?? NO_FIXTURE_CORS;
  /** Requests to fixture paths: they get fixture CORS headers, unless listed in `noCors`. */
  const fixtureRequests = new WeakSet<FastifyRequest>();
  const noCors = new WeakSet<FastifyRequest>();
  const transports = new WeakMap<FastifyRequest, NonNullable<RequestRecord['transport']>>();
  /** What `Expect` asked of a request Node handed over early. */
  const expectations = new WeakMap<IncomingMessage, 'continue' | 'unsupported'>();
  /**
   * Closers of connections waiting out a delay or held by a `timeout` fault;
   * shutdown runs them all, so neither delays exit.
   */
  const waiting = new Set<() => void>();

  const complete = (request: FastifyRequest, reply: FastifyReply, status = reply.statusCode): void => {
    const recording = recordings.get(request);
    const transport = transports.get(request);
    onRequestComplete?.({
      requestId: request.id,
      method: request.raw.method ?? request.method,
      path: resolvedPaths.get(request) ?? '-',
      status,
      durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
      ...(recording === undefined ? {} : { recording }),
      ...(transport === undefined ? {} : { transport }),
    });
  };

  /**
   * DNS rebinding: on a loopback listener, a request must name
   * this machine or `server.host` in `Host`, or a page on any site could rebind
   * its name to 127.0.0.1 and pass the `Origin` check as same-authority.
   * A request without `Host` (HTTP/1.0) is allowed.
   */
  const configuredHost = options.host?.toLowerCase();
  const isAllowedHost = (raw: IncomingMessage): boolean => {
    const address = app.server.address();
    if (address === null || typeof address === 'string' || !isLoopbackIp(address.address)) return true;
    const hosts = toHeaderMap(raw)['host'];
    if (hosts === undefined || hosts.length === 0) return true;
    if (hosts.length > 1) return false;
    const authority = parseAuthority(hosts[0] ?? '');
    if (authority === null) return false;
    return isLoopbackHost(authority.host) || authority.host === configuredHost;
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if ((receivedHeaderBytes(request.raw) ?? headerBytes(request.raw)) > limits.maxHeaderBytes) {
      reply.header('connection', 'close');
      writeError(request, reply, 431, 'headers-too-large', 'The request headers exceed the configured limit');
      return;
    }
    if (!isAllowedHost(request.raw)) {
      writeError(request, reply, 421, 'host-not-allowed', 'The Host header does not name this loopback server');
      return;
    }
    const target = request.raw.url ?? '';
    // Node keeps the target as one character per received byte, so length is the byte count.
    if (target.length > limits.maxUrlBytes) {
      writeError(request, reply, 414, 'url-too-long', 'The request target exceeds the configured limit');
      return;
    }
    const normalized = normalizeTarget(target);
    const method = (request.raw.method ?? request.method).toUpperCase();
    const ui = options.ui ?? null;
    const isUi = ui !== null && isUiPath(target.split('?', 1)[0] ?? '');
    const isAtlas = !isUi && normalized.ok && isAtlasPath(normalized.segments);
    // An Atlas request refused for its body is still an Atlas response, with CORS headers.
    if (isAtlas) atlasRequests.add(request);
    const isFixture = !isUi && !isAtlas;
    if (isFixture) fixtureRequests.add(request);
    // The resolve envelope carries a simulated body, so it gets a larger, envelope-sized limit.
    const isEnvelope = isAtlas && method === 'POST' && atlasRoute(normalized.segments, atlasContext) === 'resolve';
    // Imports are bounded by runner.maxImportBytes, decoded; base64 adds a third.
    const isImport = isAtlas && method === 'POST' && atlasRoute(normalized.segments, atlasContext) === 'runner:imports';
    // A promotion may carry an edited response as large as a captured one.
    const isPromotion = isAtlas && method === 'POST' && atlasRoute(normalized.segments, atlasContext) === 'promotions';
    const bodyLimit = isEnvelope
      ? envelopeLimit(limits.maxBodyBytes)
      : isImport
        ? Math.ceil(((options.runner?.maxImportBytes ?? 0) * 4) / 3) + ENVELOPE_OVERHEAD_BYTES
        : isPromotion
          ? Math.max(limits.maxBodyBytes, engine.promotions.bodyLimit)
          : limits.maxBodyBytes;
    const headDescription = (): RequestDescription => ({
      method: request.raw.method ?? request.method,
      target,
      headers: toHeaderMap(request.raw),
      headerLines: toHeaderLines(request.raw),
      requestId: request.id,
    });
    const expectation = expectations.get(request.raw);
    if (expectation === 'unsupported') {
      reply.header('connection', 'close');
      writeError(request, reply, 417, 'unsupported-expectation', 'Only "Expect: 100-continue" is supported');
      return;
    }
    if (expectation === 'continue') {
      // Refuse from the head what the head decides, without asking for the body.
      if (Number(request.raw.headers['content-length']) > bodyLimit) {
        reply.header('connection', 'close');
        writeError(request, reply, 413, 'request-too-large', 'The request body exceeds the configured limit');
        return;
      }
      if (isFixture) {
        if (!checkCodings(request, reply, true)) return;
        const refusal = engine.checkHead(headDescription());
        if (refusal !== null) {
          reply.header('connection', 'close');
          await writeEngineResponse(request, reply, refusal);
          return;
        }
      }
      reply.raw.writeContinue();
    }
    const read = await readBody(request.raw, bodyLimit);
    if (read === 'too-large') {
      writeError(request, reply, 413, 'request-too-large', 'The request body exceeds the configured limit');
      return;
    }
    if (read === 'failed') {
      writeError(request, reply, 400, 'invalid-request', 'Invalid request');
      return;
    }
    const body = read === null ? null : toBytes(read);
    if (ui !== null && isUi) {
      resolvedPaths.set(request, UI_LOG_PATH);
      const response = handleUiRequest(ui, {
        method,
        target,
        headers: toHeaderMap(request.raw),
      });
      reply.code(response.status).headers(response.headers);
      void reply.send(response.body === null ? undefined : toBuffer(response.body));
      return;
    }
    if (isAtlas) {
      if (method === 'GET' && atlasRoute(normalized.segments, atlasContext) === 'events') {
        streamEvents(request, reply, formatPath(normalized.segments));
        return;
      }
      await writeAtlas(request, reply, normalized.segments, normalized.query, body);
      return;
    }
    // Decode the body before resolution; core sees the decoded bytes and the codings removed.
    let decoded = body;
    let codings: readonly string[] = [];
    if (body !== null && body.length > 0) {
      const parsed = checkCodings(request, reply, false);
      if (parsed === null) return;
      if (parsed.length > 0) {
        const result = await decodeBody(body, parsed, limits.maxDecodedBodyBytes);
        if (result.kind === 'too-large') {
          writeError(
            request,
            reply,
            413,
            'decoded-body-too-large',
            'The decoded request body exceeds the configured limit (limits.maxDecodedBodyBytes)',
          );
          return;
        }
        if (result.kind === 'invalid') {
          writeError(request, reply, 400, 'invalid-request', `The request body is not valid ${result.coding} data`);
          return;
        }
        decoded = result.body;
        codings = parsed;
      }
    }
    const description: RequestDescription = {
      ...headDescription(),
      ...(decoded === null ? {} : { body: decoded }),
      ...(codings.length === 0 || body === null ? {} : { bodyCodings: codings, receivedBody: body }),
    };
    // Plan the delay, wait it out, then resolve; a client gone during the wait consumes nothing.
    if (!(await waitFor(request, engine.planDelay(description)))) return;
    const response = await engine.resolve(description);
    options.onResolved?.(request.id, description, response);
    await writeEngineResponse(request, reply, response);
  };

  /**
   * Reads a fixture request's `Content-Encoding`: the codings
   * to remove, or null once `415` or `400` was written. With `head`, a request
   * that frames no body ignores it.
   */
  const checkCodings = (request: FastifyRequest, reply: FastifyReply, head: boolean): readonly string[] | null => {
    if (head) {
      const length = request.raw.headers['content-length'];
      if (request.raw.headers['transfer-encoding'] === undefined && (length === undefined || length === '0')) return [];
    }
    const parsed = parseContentEncoding(toHeaderMap(request.raw)['content-encoding']);
    if (parsed.kind === 'unsupported') {
      if (head) reply.header('connection', 'close');
      reply.header('accept-encoding', ACCEPTED_REQUEST_ENCODINGS);
      writeError(
        request,
        reply,
        415,
        'unsupported-content-encoding',
        `The request Content-Encoding is not supported; use ${ACCEPTED_REQUEST_ENCODINGS}`,
      );
      return null;
    }
    if (parsed.kind === 'malformed') {
      if (head) reply.header('connection', 'close');
      writeError(request, reply, 400, 'invalid-request', 'Invalid request: malformed Content-Encoding');
      return null;
    }
    return parsed.codings;
  };

  /** Waits `ms` before the first byte; false when the client closed the connection first. */
  const waitFor = (request: FastifyRequest, ms: number): Promise<boolean> => {
    const socket = request.raw.socket;
    if (ms <= 0) return Promise.resolve(true);
    if (socket.destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (done: boolean): void => {
        clearTimeout(timer);
        socket.off('close', onClose);
        waiting.delete(onClose);
        resolve(done);
      };
      const onClose = (): void => {
        finish(false);
        if (!socket.destroyed) socket.destroy();
      };
      const timer = setTimeout(() => {
        finish(true);
      }, ms);
      socket.once('close', onClose);
      waiting.add(onClose);
    });
  };

  /** Writes what core decided: the delay already waited, then the fault, coding and CORS. */
  const writeEngineResponse = async (
    request: FastifyRequest,
    reply: FastifyReply,
    response: ResponseDescription,
  ): Promise<void> => {
    resolvedPaths.set(request, response.trace.normalizedPath === '' ? '-' : response.trace.normalizedPath);
    if (response.trace.recording !== undefined) recordings.set(request, response.trace.recording);
    const directive = response.transport;
    if (directive?.noCors === true) noCors.add(request);
    if (directive !== undefined) {
      const trace = response.trace.transport;
      const fault = directive.fault === null ? null : trace?.fault;
      transports.set(request, {
        latencyMs: directive.delayMs,
        fault:
          fault === null || fault === undefined
            ? null
            : { kind: fault.kind, rule: fault.rule, ...(fault.step === undefined ? {} : { step: fault.step }) },
        requestCodings: trace?.requestCodings ?? [],
        responseCoding: directive.coding,
      });
    }
    const socket = request.raw.socket;
    const fault = directive?.fault ?? null;
    if (fault?.kind === 'reset') {
      reply.hijack();
      complete(request, reply, 0);
      socket.resetAndDestroy();
      return;
    }
    if (fault?.kind === 'timeout') {
      reply.hijack();
      complete(request, reply, 0);
      hold(socket, fault);
      return;
    }
    const headers = wireHeaders(response);
    let body = response.body;
    let length: string | undefined;
    if (directive?.coding != null) {
      if (body !== null) body = compressBody(body, directive.coding);
      else if (directive.headBody !== undefined)
        length = String(compressBody(directive.headBody, directive.coding).length);
    }
    if (fault?.kind === 'truncate' || fault?.kind === 'malformed') {
      const lines: [string, string][] = [];
      for (const [name, values] of Object.entries(headers)) {
        if (name === 'content-length' && length === undefined) length = values[0];
        else if (name !== 'content-length' && name !== 'connection')
          for (const value of values) lines.push([name, value]);
      }
      lines.push([REQUEST_ID_HEADER, request.id]);
      if (!noCors.has(request)) {
        for (const [name, value] of Object.entries(
          fixtureCorsFor(
            request,
            lines.map(([name]) => name),
          ),
        )) {
          lines.push([name, value]);
        }
      }
      lines.push(['content-length', length ?? String(body?.length ?? 0)], ['connection', 'close']);
      reply.hijack();
      complete(request, reply, response.status);
      socket.end(faultBytes({ status: response.status, headers: lines, body }, fault), () => {
        socket.destroy();
      });
      return;
    }
    contentTypes.set(request, headers['content-type'] ?? []);
    reply.code(response.status);
    // Fixture header text goes out as its UTF-8 bytes; relayed headers are already bytes.
    for (const [name, values] of Object.entries(headers)) {
      reply.header(name, values.length === 1 ? values[0] : [...values]);
    }
    if (length !== undefined) reply.header('content-length', length);
    if (directive?.close === true) reply.header('connection', 'close');
    void reply.send(body === null ? undefined : toBuffer(body));
  };

  /** A `timeout` fault: write nothing, close after `holdMs` or on client close, release once. */
  const hold = (socket: Socket, fault: Extract<TransportDirective['fault'], { kind: 'timeout' }>): void => {
    let open = true;
    const close = (): void => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      waiting.delete(close);
      fault.ticket.release();
      if (!socket.destroyed) socket.destroy();
    };
    const timer = setTimeout(close, fault.holdMs);
    socket.once('close', close);
    waiting.add(close);
    if (socket.destroyed) close();
  };

  /**
   * Fixture CORS: `Vary: Origin` whenever it is on, and for a
   * listed origin the allow, credentials and expose headers.
   */
  const fixtureCorsFor = (request: FastifyRequest, names: readonly string[]): Record<string, string> => {
    if (fixtureCors.origins.length === 0) return {};
    return fixtureCorsHeaders(fixtureCors, toHeaderMap(request.raw), names);
  };

  const writeAtlas = async (
    request: FastifyRequest,
    reply: FastifyReply,
    segments: readonly string[],
    query: readonly (readonly [string, string])[],
    body: Uint8Array | null,
  ): Promise<void> => {
    reply.header('cache-control', 'no-store');
    // Aborted when the client goes away first; a simulation then stops, a reload does not.
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    let response;
    try {
      response = await handleAtlasRequest(atlasContext, {
        method: (request.raw.method ?? request.method).toUpperCase(),
        segments,
        query,
        headers: toHeaderMap(request.raw),
        requestId: request.id,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      writeInternalError(request, reply, error, onInternalError);
      return;
    }
    resolvedPaths.set(request, response.path);
    reply.code(response.status).headers(response.headers);
    void reply.send(response.body === null ? undefined : toBuffer(response.body));
  };

  /**
   * `GET /_janus/events`: the opening state, then each change
   * while the connection lasts, with a heartbeat comment. Written straight to
   * the socket so nothing buffers or compresses it.
   */
  const streamEvents = (request: FastifyRequest, reply: FastifyReply, path: string): void => {
    const reload = options.reload;
    resolvedPaths.set(request, path);
    if (reload === undefined) return;
    if (streams.size >= streamLimits.maxStreams) {
      reply.code(503).header('cache-control', 'no-store').header('content-type', ERROR_CONTENT_TYPE);
      void reply.send(
        toBuffer(
          encodeErrorEnvelope({
            code: 'service-unavailable',
            message: `Too many open event streams (at most ${String(streamLimits.maxStreams)})`,
            requestId: request.id,
          }),
        ),
      );
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': EVENT_STREAM_CONTENT_TYPE,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      [REQUEST_ID_HEADER]: request.id,
      ...corsHeaders(request),
    });
    res.socket?.setNoDelay(true);
    let open = true;
    const write = (text: string): void => {
      if (!open) return;
      if (res.destroyed || res.writableEnded) {
        close();
        return;
      }
      res.write(text, (error) => {
        if (error) close();
      });
    };
    // Subscribing and reading the state are one step, so no change falls between them.
    const subscription = reload.subscribe((event) => {
      write(formatEvent(event));
    });
    // Published after the log line is written.
    const unsubscribeCaptures =
      options.captures?.subscribe((event) => {
        write(formatEvent({ type: 'capture', ...event }));
      }) ?? (() => undefined);
    // Published after each promotion, auto promotion and review.
    const unsubscribePromotions = engine.promotions.subscribe((event) => {
      write(formatEvent({ type: 'promotion', ...event }));
    });
    const unsubscribeRunner =
      options.runner?.subscribe((event) => {
        write(formatEvent(event));
      }) ?? (() => undefined);
    const heartbeat = setInterval(() => {
      write(': keep-alive\n\n');
    }, streamLimits.heartbeatMs);
    const close = (): void => {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      subscription.unsubscribe();
      unsubscribeCaptures();
      unsubscribePromotions();
      unsubscribeRunner();
      streams.delete(close);
      if (!res.writableEnded) res.end();
    };
    streams.add(close);
    res.once('close', close);
    res.once('error', close);
    write(formatOpening(subscription.state, streamLimits.retryMs));
  };

  const app = Fastify({
    logger: false,
    // Node's limit covers the request line too, so it gets room for the longest target;
    // Janus then counts the header lines alone (`headerBytes`). Node rejects
    // anything larger before Fastify sees the request; see `clientErrorHandler`.
    http: { maxHeaderSize: limits.maxHeaderBytes + limits.maxUrlBytes + REQUEST_LINE_SLACK },
    clientErrorHandler: (error, socket) => {
      handleClientError(error, socket, onRequestComplete);
    },
    exposeHeadRoutes: false,
    genReqId: () => randomUUID(),
    // Idle keep-alive sockets are closed on shutdown; the server bounds the rest.
    forceCloseConnections: 'idle',
    // Fastify rejects some targets (e.g. malformed escapes) before routing; core classifies them instead.
    frameworkErrors: (error, request, reply) => {
      // Hooks do not run for these requests, so do their work here.
      reply.header(REQUEST_ID_HEADER, request.id);
      reply.raw.once('finish', () => {
        complete(request, reply);
      });
      if (error.code === 'FST_ERR_BAD_URL') {
        handle(request, reply).catch((cause: unknown) => {
          writeInternalError(request, reply, cause, onInternalError);
        });
        return;
      }
      writeError(request, reply, 400, 'invalid-request', 'Invalid request');
    },
  });

  const receivedHeaderBytes = trackHeaderSizes(app.server, limits.maxHeaderBytes);

  // Event streams never hold up shutdown: close them before the server waits for connections.
  app.addHook('preClose', (done) => {
    for (const close of [...streams]) close();
    for (const close of [...waiting]) close();
    done();
  });

  // Node hands over a request with `Expect` before reading its body; the handler decides.
  app.server.on('checkContinue', (raw: IncomingMessage, res) => {
    expectations.set(raw, parseExpect(toHeaderMap(raw)).kind === 'continue' ? 'continue' : 'unsupported');
    app.server.emit('request', raw, res);
  });
  app.server.on('checkExpectation', (raw: IncomingMessage, res) => {
    expectations.set(raw, 'unsupported');
    app.server.emit('request', raw, res);
  });

  // Fastify reads no body for GET, HEAD and TRACE, and rejects a malformed
  // `Content-Type` before routing. Janus reads every body itself (`readBody`),
  // so serving, the explorer and recording see the same bytes whatever the
  // method or media type, and core classifies the type.
  for (const method of app.supportedMethods) app.addHttpMethod(method, { hasBody: false, overrideExisting: true });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
  /**
   * CORS on Atlas responses: `Vary: Origin` on every one while
   * `cors.origins` is non-empty, and `Access-Control-Allow-Origin` for a listed
   * origin. A failed preflight gets none of the `Access-Control-*` headers.
   */
  const corsHeaders = (request: FastifyRequest): Record<string, string> => {
    if (cors.origins.length === 0) return {};
    const headers = toHeaderMap(request.raw);
    const method = (request.raw.method ?? request.method).toUpperCase();
    const allow = isPreflight(method, headers) ? null : allowOrigin(readOrigin(headers), cors);
    return { vary: 'Origin', ...(allow === null ? {} : { 'access-control-allow-origin': allow }) };
  };
  app.addHook('onSend', (request, reply, payload, done) => {
    const contentType = contentTypes.get(request);
    if (contentType !== undefined) {
      if (contentType.length === 0) reply.removeHeader('content-type');
      else reply.header('content-type', contentType.length === 1 ? contentType[0] : [...contentType]);
    }
    // A successful preflight already carries its own, longer set.
    if (atlasRequests.has(request) && !reply.hasHeader('access-control-allow-methods')) {
      reply.headers(corsHeaders(request));
    }
    if (
      fixtureCors.origins.length > 0 &&
      fixtureRequests.has(request) &&
      !noCors.has(request) &&
      !reply.hasHeader('access-control-allow-methods')
    ) {
      reply.headers(fixtureCorsFor(request, Object.keys(reply.getHeaders())));
      appendVary(reply, 'Origin');
    }
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    complete(request, reply);
    done();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    // An Atlas request that fails in Fastify is still an Atlas response.
    const normalized = normalizeTarget(request.raw.url ?? '');
    if (normalized.ok && isAtlasPath(normalized.segments)) atlasRequests.add(request);
    if (status === 413) {
      writeError(request, reply, 413, 'request-too-large', 'The request body exceeds the configured limit');
    } else if (status >= 400 && status < 500) {
      writeError(request, reply, 400, 'invalid-request', 'Invalid request');
    } else {
      writeInternalError(request, reply, error, onInternalError);
    }
  });

  // Fastify-known methods get a real route; any other method token Node
  // accepts falls through to the same handler.
  app.route({ method: app.supportedMethods.filter((method) => method !== 'CONNECT'), url: '*', handler: handle });
  app.setNotFoundHandler(handle);
  return app;
}

/**
 * Node's HTTP parser rejects some requests before any handler runs: oversize
 * headers, and a malformed request line or header section such
 * as an unknown or lowercase method. Both get the same JSON
 * envelope as every other Janus error, and the connection is closed.
 */
function handleClientError(
  error: Error & { code?: string },
  socket: Socket,
  onRequestComplete: HttpAdapterOptions['onRequestComplete'],
): void {
  if (error.code === 'ECONNRESET' || socket.destroyed) return;
  if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    if (socket.writable) {
      const body = '{"error":"Request Timeout","message":"Client Timeout","statusCode":408}';
      socket.write(
        `HTTP/1.1 408 Request Timeout\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n` +
          `Content-Type: ${ERROR_CONTENT_TYPE}\r\n\r\n${body}`,
      );
    }
    socket.destroy(error);
    return;
  }
  const requestId = randomUUID();
  const [status, code, message]: [number, RequestErrorCode, string] =
    error.code === 'HPE_HEADER_OVERFLOW'
      ? [431, 'headers-too-large', 'The request headers exceed the configured limit']
      : [400, 'invalid-request', 'Invalid request'];
  const body = encodeErrorEnvelope({ code, message, requestId });
  if (socket.writable) {
    const headers = [
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
      `Content-Length: ${String(body.byteLength)}`,
      `Content-Type: ${ERROR_CONTENT_TYPE}`,
      `${REQUEST_ID_HEADER}: ${requestId}`,
      'Connection: close',
    ];
    socket.write(Buffer.concat([Buffer.from(`${headers.join('\r\n')}\r\n\r\n`), toBuffer(body)]));
  }
  socket.destroy(error);
  onRequestComplete?.({ requestId, method: '-', path: '-', status, durationMs: 0 });
}

/**
 * Reads the request body for any method, at most `limit` bytes.
 * Null when the request frames no body and names no `Content-Type`, as for a
 * bodyless `POST`; `too-large` past the limit, before reading when
 * `Content-Length` already says so; `failed` when the client goes away.
 */
function readBody(raw: IncomingMessage, limit: number): Promise<Buffer | null | 'too-large' | 'failed'> {
  const length = raw.headers['content-length'];
  const framed = raw.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
  if (!framed && raw.headers['content-type'] === undefined) return Promise.resolve(null);
  if (Number(length) > limit) return Promise.resolve('too-large');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const stop = (): void => {
      raw.off('data', onData);
      raw.off('end', onEnd);
      raw.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > limit) {
        // The rest still flows and is discarded, so the 413 can be written.
        stop();
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      resolve(Buffer.concat(chunks, received));
    };
    const onError = (): void => {
      stop();
      resolve('failed');
    };
    raw.on('data', onData);
    raw.on('end', onEnd);
    raw.on('error', onError);
  });
}

/** Adds `token` to `Vary` after the names already there, unless it or `*` is listed. */
function appendVary(reply: FastifyReply, token: string): void {
  const current = reply.getHeader('vary');
  const values = current === undefined ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
  const tokens = values.flatMap((value) => value.split(',')).map((name) => name.trim().toLowerCase());
  if (tokens.includes('*') || tokens.includes(token.toLowerCase())) return;
  if (values.length === 0) reply.header('vary', token);
  else reply.header('vary', [...values.slice(0, -1), `${values.at(-1) ?? ''}, ${token}`]);
}

function writeError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: RequestErrorCode,
  message: string,
): void {
  const body = encodeErrorEnvelope({ code, message, requestId: request.id });
  reply.code(status).header('content-type', ERROR_CONTENT_TYPE);
  if (request.raw.method === 'HEAD') {
    // The length of the envelope GET would get.
    void reply.header('content-length', String(body.length)).send();
    return;
  }
  void reply.send(toBuffer(body));
}

function writeInternalError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  onInternalError: HttpAdapterOptions['onInternalError'],
): void {
  onInternalError?.(request.id, error);
  writeError(request, reply, 500, 'internal-error', 'Janus failed to handle the request');
}

/**
 * Lower-cased name → values. Node's `headersDistinct` already has this shape;
 * injected test requests lack it, so fall back to the combined `headers`.
 */
function toHeaderMap(raw: IncomingMessage): HeaderMap {
  // Typed as always present, but injected requests omit it.
  const distinct = raw.headersDistinct as IncomingMessage['headersDistinct'] | undefined;
  if (distinct !== undefined) return distinct as HeaderMap;
  const headers: Record<string, readonly string[]> = {};
  for (const [name, value] of Object.entries(raw.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value : [value];
  }
  return headers;
}

/** The header lines in the order received, names as written. */
function toHeaderLines(raw: IncomingMessage): HeaderLine[] {
  const lines: HeaderLine[] = [];
  const flat = raw.rawHeaders;
  for (let index = 0; index + 1 < flat.length; index += 2) lines.push([flat[index] ?? '', flat[index + 1] ?? '']);
  return lines;
}

/** The header section's size as sent: each `name: value` line with its CRLF. */
function headerBytes(raw: IncomingMessage): number {
  let bytes = 0;
  const lines = raw.rawHeaders;
  // Node keeps each received byte as one character, so length is the byte count.
  for (let index = 0; index + 1 < lines.length; index += 2) {
    bytes += (lines[index] ?? '').length + 2 + (lines[index + 1] ?? '').length + 2;
  }
  return bytes;
}

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
