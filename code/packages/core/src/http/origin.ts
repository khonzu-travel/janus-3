/**
 * Serialized origins and request authorities. Pure
 * string handling: the configuration normalizes `cors.origins` with it, and the
 * HTTP adapter matches `Origin` and `Host` headers with it.
 */

export type OriginScheme = 'http' | 'https';

/** A valid, normalized origin. */
export interface Origin {
  readonly scheme: OriginScheme;
  /** Lowercased; IPv6 literals keep their brackets. */
  readonly host: string;
  /** The explicit port, or the scheme's default. */
  readonly port: number;
  /** `scheme://host[:port]`, without a default port. */
  readonly serialized: string;
}

/** A request authority as the `Host` header gives it. */
export interface Authority {
  /** Lowercased; IPv6 literals keep their brackets. */
  readonly host: string;
  /** Null when the header names no port. */
  readonly port: number | null;
}

export const DEFAULT_PORTS: Readonly<Record<OriginScheme, number>> = { http: 80, https: 443 };

/** The wildcard entry of `cors.origins`; it must be the only entry. */
export const ANY_ORIGIN = '*';

const ORIGIN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#@]*)$/;
const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?';
const REG_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const IPV6_LITERAL = /^\[([0-9A-Fa-f:.]+)\]$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Parses a serialized origin: `http` or `https`, a host, an optional port, and
 * nothing else. Returns null for anything malformed, including `null`, a list,
 * a path or trailing slash, userinfo, a query, a fragment, and IPv6 zone
 * identifiers.
 */
export function parseOrigin(value: string): Origin | null {
  const match = ORIGIN.exec(value);
  if (match === null) return null;
  const scheme = (match[1] ?? '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const authority = parseAuthority(match[2] ?? '');
  if (authority === null) return null;
  const port = authority.port ?? DEFAULT_PORTS[scheme];
  const serialized = `${scheme}://${authority.host}${port === DEFAULT_PORTS[scheme] ? '' : `:${String(port)}`}`;
  return { scheme, host: authority.host, port, serialized };
}

/** Parses a `Host` header value: a host and an optional port. Returns null when malformed. */
export function parseAuthority(value: string): Authority | null {
  let host: string;
  let rest: string;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    host = value.slice(0, end + 1);
    rest = value.slice(end + 1);
    const literal = IPV6_LITERAL.exec(host)?.[1];
    if (literal === undefined || !isIpv6(literal)) return null;
  } else {
    const colon = value.indexOf(':');
    host = colon === -1 ? value : value.slice(0, colon);
    rest = colon === -1 ? '' : value.slice(colon);
    if (host.length > 253 || !REG_NAME.test(host)) return null;
  }
  let port: number | null = null;
  if (rest !== '') {
    if (!/^:\d{1,5}$/.test(rest)) return null;
    port = Number(rest.slice(1));
    if (port > 65535) return null;
  }
  return { host: host.toLowerCase(), port };
}

/**
 * Whether an origin names the same host and port as the request authority.
 * The scheme is not compared: a `Host` without a port stands
 * for the default port of the origin's scheme.
 */
export function isSameAuthority(origin: Origin, authority: Authority): boolean {
  return origin.host === authority.host && origin.port === (authority.port ?? DEFAULT_PORTS[origin.scheme]);
}

/**
 * Whether a `Host` authority's host names this machine:
 * `localhost`, a `*.localhost` name, or a loopback IP literal. Lowercased, as
 * `parseAuthority` gives it.
 */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const literal = IPV6_LITERAL.exec(host)?.[1];
  return literal === undefined ? IPV4.test(host) && host.startsWith('127.') : isLoopbackIp(literal);
}

/** Whether an IP address without brackets is a loopback address: 127.0.0.0/8, `::1`, or IPv4-mapped 127.0.0.0/8. */
export function isLoopbackIp(address: string): boolean {
  if (IPV4.test(address)) return address.startsWith('127.');
  if (!isIpv6(address)) return false;
  const groups = ipv6Groups(address.toLowerCase());
  if (groups.slice(0, 5).some((group) => group !== 0)) return false;
  if (groups[5] === 0 && groups[6] === 0) return groups[7] === 1;
  // IPv4-mapped: ::ffff:a.b.c.d, as Node reports a dual-stack listener's IPv4 peer.
  return groups[5] === 0xffff && (groups[6] ?? 0) >> 8 === 127;
}

/** A `cors.origins` entry as Janus stores it: the wildcard, or the normalized origin. */
export function normalizeOriginEntry(entry: string): string {
  if (entry === ANY_ORIGIN) return entry;
  return parseOrigin(entry)?.serialized ?? entry;
}

/** True for a value `cors.origins` accepts as one entry. */
export function isValidOriginEntry(entry: string): boolean {
  return entry === ANY_ORIGIN || parseOrigin(entry) !== null;
}

/** RFC 4291 text form: up to eight hex groups, at most one `::`, optionally ending in IPv4. */
function isIpv6(text: string): boolean {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const all = [...groups(halves[0] ?? ''), ...(halves.length === 2 ? groups(halves[1] ?? '') : [])];
  let count = all.length;
  const last = all.at(-1);
  if (last !== undefined && last.includes('.')) {
    if (!IPV4.test(last)) return false;
    all.pop();
    count += 1;
  }
  if (!all.every((group) => HEX_GROUP.test(group))) return false;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(text: string): number[] {
  const parse = (half: string): number[] =>
    half === ''
      ? []
      : half.split(':').flatMap((group) => {
          if (!group.includes('.')) return [parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const halves = text.split('::');
  const head = parse(halves[0] ?? '');
  if (halves.length === 1) return head;
  const tail = parse(halves[1] ?? '');
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
