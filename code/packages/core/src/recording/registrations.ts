import { RESERVED_SEGMENT } from '../fixtures/build.js';
import { formatPath, type RouteSegment } from '../http/target.js';

/** Methods a registration may name. `HEAD` is never recordable. */
export const RECORDABLE_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const);

/** At most this many registrations. */
export const MAX_REGISTRATIONS = 256;

/** One entry of `recording.endpoints`, as written in the configuration. */
export interface RecordingEndpoint {
  readonly method: string;
  readonly path: string;
  readonly upstream: string;
}

/** A validated registration: the endpoint as written, its template segments and its upstream parts. */
export interface Registration {
  /** Position in `recording.endpoints`. */
  readonly index: number;
  readonly endpoint: RecordingEndpoint;
  readonly segments: readonly RouteSegment[];
  /** `https://staging.api.example.com`: scheme, host and port only, from trusted configuration. */
  readonly origin: string;
  /** The upstream's base path, encoded, without a trailing "/"; "" for none. */
  readonly basePath: string;
}

export interface RegistrationProblem {
  readonly code: 'recording-invalid-endpoint' | 'recording-overlap';
  /** The entry the problem is reported at. */
  readonly index: number;
  readonly message: string;
}

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Validates registrations: each template against the
 * grammar and the rules, each upstream URL, and every pair for
 * overlap. Every problem is returned; only entries without one are compiled.
 */
export function compileRegistrations(endpoints: readonly RecordingEndpoint[]): {
  readonly registrations: readonly Registration[];
  readonly problems: readonly RegistrationProblem[];
} {
  const problems: RegistrationProblem[] = [];
  const registrations: Registration[] = [];
  for (const [index, endpoint] of endpoints.entries()) {
    const label = `${endpoint.method} ${endpoint.path}`;
    const segments = parseTemplate(endpoint.path);
    if (typeof segments === 'string') {
      problems.push({ code: 'recording-invalid-endpoint', index, message: `${label}: ${segments}` });
    }
    const upstream = parseUpstream(endpoint.upstream);
    if (typeof upstream === 'string') {
      problems.push({ code: 'recording-invalid-endpoint', index, message: `${label}: ${upstream}` });
    }
    if (typeof segments === 'string' || typeof upstream === 'string') continue;
    registrations.push(Object.freeze({ index, endpoint, segments: Object.freeze(segments), ...upstream }));
  }
  for (const [position, a] of registrations.entries()) {
    for (const b of registrations.slice(position + 1)) {
      if (!overlaps(a, b)) continue;
      problems.push({
        code: 'recording-overlap',
        index: b.index,
        message: `${b.endpoint.method} ${b.endpoint.path} and ${a.endpoint.method} ${a.endpoint.path} can both match one request; make one of them more specific or remove one`,
      });
    }
  }
  return { registrations: Object.freeze(registrations), problems: Object.freeze(problems) };
}

/**
 * The registration a runner capture is filed under: the
 * route derived from the request, checked against the template rules, with
 * the request's origin and removed prefix as its upstream. Returns why it
 * cannot be one.
 */
export function runnerRegistration(endpoint: RecordingEndpoint): Registration | string {
  if (!(RECORDABLE_METHODS as readonly string[]).includes(endpoint.method)) {
    return `${endpoint.method} exchanges cannot be captured; captures take ${RECORDABLE_METHODS.join(', ')}`;
  }
  const { registrations, problems } = compileRegistrations([endpoint]);
  const [problem] = problems;
  if (problem !== undefined) return problem.message.slice(`${endpoint.method} ${endpoint.path}: `.length);
  const [registration] = registrations;
  return registration ?? 'the route cannot be compiled';
}

const compiled = new WeakMap<readonly RecordingEndpoint[], readonly Registration[]>();

/**
 * The compiled registrations of a validated `recording.endpoints`, cached per
 * list. Throws for an invalid list: the configuration was validated at startup.
 */
export function registrationsOf(endpoints: readonly RecordingEndpoint[]): readonly Registration[] {
  let registrations = compiled.get(endpoints);
  if (registrations === undefined) {
    const result = compileRegistrations(endpoints);
    const [problem] = result.problems;
    if (problem !== undefined) throw new Error(`invalid recording.endpoints: ${problem.message}`);
    registrations = result.registrations;
    compiled.set(endpoints, registrations);
  }
  return registrations;
}

/** The registration a request matches, with its bound parameters; null for none. */
export function matchRegistration(
  registrations: readonly Registration[],
  method: string,
  segments: readonly string[],
): { readonly registration: Registration; readonly params: Readonly<Record<string, string>> } | null {
  if (method === 'HEAD') return null;
  for (const registration of registrations) {
    if (registration.endpoint.method !== method || registration.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matched = registration.segments.every((segment, index) => {
      const value = segments[index] ?? '';
      if (segment.kind === 'literal') return segment.value === value;
      if (value === '') return false;
      params[segment.name] = value;
      return true;
    });
    if (matched) return { registration, params: Object.freeze(params) };
  }
  return null;
}

/**
 * The upstream URL for a request: the configured origin
 * and base path, the canonical path as encoded segments, then the query
 * exactly as received. Caller text is never resolved as a URL.
 */
export function upstreamUrl(registration: Registration, segments: readonly string[], rawTarget: string): string {
  const queryStart = rawTarget.indexOf('?');
  const query = queryStart === -1 ? '' : rawTarget.slice(queryStart);
  return `${registration.origin}${registration.basePath}${formatPath(segments)}${query}`;
}

/** The template's segments, or why it breaks the grammar. */
export function parseTemplate(path: string): RouteSegment[] | string {
  if (!path.startsWith('/')) return 'the path must start with "/"';
  if (path === '/') return [];
  const parts = path.slice(1).split('/');
  const segments: RouteSegment[] = [];
  const bound = new Set<string>();
  for (const [index, part] of parts.entries()) {
    if (part === '') {
      return index === parts.length - 1
        ? 'the path must not end with "/"'
        : `segment ${String(index + 1)} is empty; remove the doubled "/"`;
    }
    if (part.includes('{') || part.includes('}')) {
      const name = PARAMETER.exec(part)?.[1];
      if (name === undefined) {
        return `"${part}" is not a path parameter: write the whole segment as {name}, where name is a letter or "_" followed by letters, digits or "_"`;
      }
      if (bound.has(name)) return `the path binds {${name}} twice; give each parameter a distinct name`;
      bound.add(name);
      segments.push({ kind: 'param', name });
      continue;
    }
    if (part === '.' || part === '..') return `segment ${String(index + 1)} is a dot-segment`;
    if (part.includes('\0')) return `segment ${String(index + 1)} contains NUL`;
    if (index === 0 && part === RESERVED_SEGMENT) {
      return `"/${RESERVED_SEGMENT}" is reserved for Janus operational APIs and cannot be recorded`;
    }
    segments.push({ kind: 'literal', value: part.normalize('NFC') });
  }
  return segments;
}

/** The origin and base path of an upstream URL, or why it is not one Janus forwards to. */
function parseUpstream(upstream: string): { origin: string; basePath: string } | string {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return `"${upstream}" is not an absolute URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the upstream must be an http or https URL';
  if (url.username !== '' || url.password !== '' || /^[a-z]+:\/\/[^/?#]*@/i.test(upstream)) {
    return 'the upstream URL must not contain a user name or password';
  }
  if (upstream.includes('?')) return 'the upstream URL must not have a query';
  if (upstream.includes('#')) return 'the upstream URL must not have a fragment';
  if (url.host === '') return 'the upstream URL must name a host';
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
}

/** Same method and length, and at every position equal literals or at least one parameter. */
function overlaps(a: Registration, b: Registration): boolean {
  if (a.endpoint.method !== b.endpoint.method || a.segments.length !== b.segments.length) return false;
  return a.segments.every((segment, index) => {
    const other = b.segments[index];
    if (other === undefined) return false;
    return segment.kind === 'param' || other.kind === 'param' || segment.value === other.value;
  });
}
