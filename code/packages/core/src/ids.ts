import { toHex } from './bytes.js';
import { CanonicalWriter } from './canonical.js';
import type { HttpMethod } from './types/index.js';

/**
 * `ep_` + 64 bits of a domain-tagged digest of scenario, method, and the
 * canonical path template. `template` holds decoded
 * literal segments and `{name}` for parameters; literal segments can never
 * contain braces, so the two cannot collide.
 */
export function endpointId(scenario: string, method: HttpMethod, template: readonly string[]): string {
  const writer = new CanonicalWriter().string('janus-atlas-endpoint/1').string(scenario).string(method);
  writer.number(template.length);
  for (const segment of template) writer.string(segment);
  return `ep_${toHex(writer.digest()).slice(0, 16)}`;
}

/**
 * `fx_` + 64 bits of a domain-tagged digest of the endpoint ID, the normalized
 * locale (or neutral), and the file's media type, by either form of name (or a
 * bodyless marker), and for a named variant only, its name.
 * Status is not an input, so changing only a status keeps the ID; plain
 * fixtures keep the IDs they had before variants existed.
 */
export function fixtureId(
  endpoint: string,
  locale: string | null,
  mediaType: string | null,
  variant: string | null = null,
): string {
  const writer = new CanonicalWriter().string('janus-atlas-fixture/2').string(endpoint);
  if (locale === null) writer.string('neutral');
  else writer.string('locale').string(locale.toLowerCase());
  if (mediaType === null) writer.string('bodyless');
  else writer.string('media').string(mediaType.toLowerCase());
  if (variant !== null) writer.string('variant').string(variant);
  return `fx_${toHex(writer.digest()).slice(0, 16)}`;
}
