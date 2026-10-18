const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** RFC 9110 §5.6.2 `token`: used for methods, field names, and media type parts. */
export function isToken(value: string): boolean {
  return TOKEN.test(value);
}

/**
 * Uppercases and validates a request method token. Returns null for an invalid
 * token (the caller answers `400 invalid-request`).
 */
export function normalizeMethod(method: string): string | null {
  const upper = method.toUpperCase();
  return isToken(upper) ? upper : null;
}

/** True when `method` is already an uppercase method token, as fixture method directories must be. */
export function isUppercaseMethodToken(method: string): boolean {
  return isToken(method) && method === method.toUpperCase();
}
