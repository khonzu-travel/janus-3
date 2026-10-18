import { isToken } from './token.js';

/**
 * The cookies of a request's `Cookie` field lines (RFC 6265 §4.2.1, §5.4), in
 * request order across lines. A pair that is not `name=value` with a token
 * name and cookie-octets is skipped, never an error. A value
 * in double quotes is returned without them.
 */
export function parseCookies(lines: readonly string[] | undefined): readonly (readonly [string, string])[] {
  const cookies: [string, string][] = [];
  for (const line of lines ?? []) {
    for (const pair of line.split(';')) {
      const equals = pair.indexOf('=');
      if (equals === -1) continue;
      const name = pair.slice(0, equals).trim();
      let value = pair.slice(equals + 1).trim();
      if (!isToken(name)) continue;
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!isCookieValue(value)) continue;
      cookies.push([name, value]);
    }
  }
  return cookies;
}

/** The first cookie named `name` (case-sensitively), or undefined. */
export function cookieNamed(lines: readonly string[] | undefined, name: string): string | undefined {
  return parseCookies(lines).find(([key]) => key === name)?.[1];
}

/** cookie-octet: visible ASCII except DQUOTE, comma, semicolon and backslash. */
function isCookieValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const allowed =
      code === 0x21 ||
      (code >= 0x23 && code <= 0x2b) ||
      (code >= 0x2d && code <= 0x3a) ||
      (code >= 0x3c && code <= 0x5b) ||
      (code >= 0x5d && code <= 0x7e);
    if (!allowed) return false;
  }
  return true;
}
