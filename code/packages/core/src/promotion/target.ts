import { compareStrings } from '../canonical.js';
import { parseFileName, isVariantName } from '../fixtures/filename.js';
import type { RouteNode } from '../fixtures/snapshot.js';
import { decodePathSegment, encodePathSegment, formatTemplate, type RouteSegment } from '../http/target.js';
import { parseTemplate } from '../recording/registrations.js';
import type { FixtureFiles } from '../types/index.js';
import { PromotionError } from './errors.js';

/** A route template laid onto the target scenario's own directory. */
export interface PlacedTemplate {
  readonly segments: readonly RouteSegment[];
  /** The directory names below the scenario root, existing spellings reused. */
  readonly dirs: readonly string[];
  /** Parameter name → the value it bound in the capture. */
  readonly bindings: readonly (readonly [name: string, value: string])[];
}

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${String(i + 1)}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${String(i + 1)}`),
]);

/**
 * The template the response is filed under: the
 * registration's, or a `path` with as many segments that keeps each
 * registration literal or makes it a parameter, and keeps each registration
 * parameter a parameter, possibly renamed. Returns the template and the value
 * each of its parameters bound.
 */
export function resolveTemplate(
  registration: string,
  params: Readonly<Record<string, string>>,
  path: string | undefined,
): { readonly segments: readonly RouteSegment[]; readonly bindings: readonly (readonly [string, string])[] } {
  const base = parseTemplate(registration);
  if (typeof base === 'string') {
    throw new PromotionError(422, 'capture-unreadable', `the capture's registration ${registration} is not a template`);
  }
  const valueOf = (segment: RouteSegment): string => {
    if (segment.kind === 'literal') return segment.value;
    const value = params[segment.name];
    if (value === undefined) {
      throw new PromotionError(422, 'capture-unreadable', `the capture has no value for {${segment.name}}`);
    }
    return value;
  };
  if (path === undefined) {
    return {
      segments: base,
      bindings: base.flatMap((segment) =>
        segment.kind === 'param' ? [[segment.name, valueOf(segment)] as const] : [],
      ),
    };
  }
  const invalid = (reason: string): never => {
    throw new PromotionError(422, 'promotion-invalid-path', `"path" ${path} ${reason}`, { field: 'path' });
  };
  const chosen = parseTemplate(path);
  if (typeof chosen === 'string') return invalid(`is not a route template: ${chosen}`);
  if (chosen.length !== base.length) {
    return invalid(
      `has ${String(chosen.length)} segments, but the registration ${registration} has ${String(base.length)}`,
    );
  }
  const bindings: [string, string][] = [];
  chosen.forEach((segment, index) => {
    const original = base[index] as RouteSegment;
    if (segment.kind === 'param') {
      bindings.push([segment.name, valueOf(original)]);
      return;
    }
    if (original.kind === 'param') {
      invalid(
        `makes the registration's {${original.name}} the literal "${segment.value}"; a parameter stays a parameter`,
      );
    } else if (original.value !== segment.value) {
      invalid(
        `changes the literal "${original.value}" at segment ${String(index + 1)}; keep it or make it a parameter`,
      );
    }
  });
  return { segments: chosen, bindings };
}

/**
 * The directory name of a new literal segment: the Atlas's
 * percent-encoding, then `*`, `:`, a trailing `.` and a reserved Windows device
 * name encoded too, so the name is valid on every common filesystem and
 * decodes back to the segment.
 */
export function canonicalSegmentName(value: string): string {
  if (value.includes('{') || value.includes('}')) {
    throw new PromotionError(
      422,
      'promotion-invalid-path',
      `the literal segment "${value}" contains a brace, which a fixture directory cannot express`,
      { field: 'path' },
    );
  }
  let name = encodePathSegment(value.normalize('NFC')).replaceAll('*', '%2A').replaceAll(':', '%3A');
  if (name.endsWith('.')) name = `${name.slice(0, -1)}%2E`;
  const base = (value.split('.')[0] ?? '').toLowerCase();
  if (DEVICE_NAMES.has(base)) {
    const first = name.charCodeAt(0);
    name = `%${first.toString(16).toUpperCase().padStart(2, '0')}${name.slice(1)}`;
  }
  return name;
}

/**
 * Lays a template onto the target scenario: literal segments
 * reuse an existing directory of the same decoded name, parameters reuse the
 * template directory at that position, and a template directory with another
 * name, in the scenario's own tree or its effective tree, is a conflict.
 */
export function placeTemplate(
  scenario: string,
  segments: readonly RouteSegment[],
  bindings: readonly (readonly [string, string])[],
  tree: FixtureFiles,
  effective: RouteNode,
): PlacedTemplate {
  // Own directories: raw prefix below the scenario root → its child directory names.
  const children = new Map<string, Set<string>>();
  for (const key of tree.keys()) {
    const parts = key.split('/');
    if (parts[0] !== scenario) continue;
    for (let end = 1; end < parts.length - 1; end++) {
      const prefix = parts.slice(1, end).join('/');
      const set = children.get(prefix) ?? new Set<string>();
      set.add(parts[end] ?? '');
      children.set(prefix, set);
    }
  }
  const conflict = (existing: string, wanted: string, where: readonly RouteSegment[]): never => {
    throw new PromotionError(
      422,
      'promotion-template-conflict',
      `${formatTemplate(where)} already has the template directory {${existing}}, so it cannot also have {${wanted}}; use {${existing}} in "path" or rename the directory by hand`,
      { field: 'path', existing, wanted },
    );
  };

  const dirs: string[] = [];
  let node: RouteNode | undefined = effective;
  segments.forEach((segment, index) => {
    const prefix = dirs.join('/');
    const names = [...(children.get(prefix) ?? [])].sort(compareStrings);
    const here = segments.slice(0, index);
    if (segment.kind === 'param') {
      const own = names.find((name) => PARAMETER.test(name));
      const ownName = own === undefined ? undefined : PARAMETER.exec(own)?.[1];
      if (ownName !== undefined && ownName !== segment.name) conflict(ownName, segment.name, here);
      const inherited = node?.param?.name;
      if (inherited !== undefined && inherited !== segment.name) conflict(inherited, segment.name, here);
      dirs.push(own ?? `{${segment.name}}`);
      node = node?.param?.node;
      return;
    }
    const existing = names.find((name) => {
      const decoded = decodePathSegment(name);
      return decoded.ok && !PARAMETER.test(decoded.value) && decoded.value === segment.value;
    });
    dirs.push(existing ?? canonicalSegmentName(segment.value));
    node = node?.children.get(segment.value);
  });
  return { segments, dirs, bindings };
}

/** A capture response file name with a variant added before the extension. */
export function withVariant(name: string, variant: string | null): string {
  if (variant === null) return name;
  if (!isVariantName(variant)) {
    throw new PromotionError(
      400,
      'invalid-request',
      `"variant" "${variant}" is not a variant name: lowercase letters and digits in words joined by "-", at most 32 bytes, and not "headers", "meta" or a file extension`,
      { field: 'variant' },
    );
  }
  const parsed = parseFileName(name);
  if (parsed.kind !== 'response')
    throw new PromotionError(422, 'capture-unreadable', 'the capture has no response file');
  const dot = parsed.mediaType === null ? -1 : name.lastIndexOf('.');
  const named = dot === -1 ? `${name}.${variant}` : `${name.slice(0, dot)}.${variant}${name.slice(dot)}`;
  const check = parseFileName(named);
  if (
    check.kind !== 'response' ||
    check.variant !== variant ||
    check.status !== parsed.status ||
    check.mediaType !== parsed.mediaType ||
    check.locale !== parsed.locale
  ) {
    throw new PromotionError(400, 'invalid-request', `"variant" "${variant}" cannot be added to ${name}`, {
      field: 'variant',
    });
  }
  return named;
}

/** Status, variant, locale and media type, case-insensitively; null for a non-response name. */
export function representationKey(name: string): string | null {
  const parsed = parseFileName(name);
  if (parsed.kind !== 'response') return null;
  return [
    parsed.status,
    parsed.variant ?? '',
    parsed.locale?.toLowerCase() ?? '',
    parsed.mediaType?.toLowerCase() ?? '',
  ].join('\0');
}
