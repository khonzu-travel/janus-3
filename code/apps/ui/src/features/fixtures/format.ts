import type { Endpoint, FixtureItem } from '../../atlas/client.js';

/**
 * "200", "200 (fr)", or, when the response has several media types,
 * "200 (application/json)" and "200 (fr, text/html)", so every representation
 * of an endpoint has a distinct name. A named variant is part of the
 * name: "200.empty (application/json)".
 */
export function describeFixture(
  fixture: Pick<FixtureItem, 'status' | 'locale' | 'mediaType'> & { readonly identity?: string },
  withMediaType = false,
): string {
  const parts = [
    ...(fixture.locale === null ? [] : [fixture.locale]),
    ...(withMediaType && fixture.mediaType !== null ? [fixture.mediaType] : []),
  ];
  return `${fixture.identity ?? String(fixture.status)}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`;
}

/** True when the fixture's representation group offers more than one media type. */
export function hasSiblingRepresentations(endpoint: Endpoint, fixtureId: string): boolean {
  const group = endpoint.representationGroups.find((entry) =>
    entry.representations.some((representation) => representation.id === fixtureId),
  );
  return (group?.representations.length ?? 0) > 1;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
