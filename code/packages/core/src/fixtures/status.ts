/** Statuses that never carry content. */
export const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export function isBodylessStatus(status: number): boolean {
  return BODYLESS_STATUSES.has(status);
}

/** Redirects that must name a target: 3xx except 304 Not Modified. */
export function requiresLocation(status: number): boolean {
  return status >= 300 && status <= 399 && status !== 304;
}
