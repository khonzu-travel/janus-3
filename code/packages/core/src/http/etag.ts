/**
 * Entity tags and `If-None-Match` (RFC 9110 §8.8.3, §13.1.2). Janus never
 * computes a tag; it only compares one an author wrote with what a client sent.
 */
export interface EntityTag {
  readonly weak: boolean;
  /** The opaque tag without its quotes. */
  readonly opaque: string;
}

const ENTITY_TAG = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/;

/** Parses one entity tag such as `"v2"` or `W/"v2"`, or returns null. */
export function parseEntityTag(text: string): EntityTag | null {
  const match = ENTITY_TAG.exec(text);
  if (match === null) return null;
  return { weak: match[1] !== undefined, opaque: match[2] ?? '' };
}

/** Weak comparison: the opaque tags are equal, whether or not either is weak. */
export function weakMatch(a: EntityTag, b: EntityTag): boolean {
  return a.opaque === b.opaque;
}

/**
 * `If-None-Match` across every field line: `*`, a list of entity tags, or
 * null when a line is malformed (which then matches nothing).
 */
export function parseIfNoneMatch(lines: readonly string[] | undefined): '*' | readonly EntityTag[] | null {
  if (lines === undefined || lines.length === 0) return null;
  const tags: EntityTag[] = [];
  let any = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '*') {
      any = true;
      continue;
    }
    for (const member of splitTags(trimmed)) {
      if (member === '') continue;
      const tag = parseEntityTag(member);
      if (tag === null) return null;
      tags.push(tag);
    }
  }
  if (any) return tags.length === 0 && lines.length === 1 ? '*' : null;
  return tags.length === 0 ? null : tags;
}

/** True when `If-None-Match` is `*` or lists a tag matching `tag` by weak comparison. */
export function ifNoneMatchMatches(lines: readonly string[] | undefined, tag: EntityTag): boolean {
  const parsed = parseIfNoneMatch(lines);
  if (parsed === null) return false;
  if (parsed === '*') return true;
  return parsed.some((candidate) => weakMatch(candidate, tag));
}

/** Splits on commas outside quotes, trimming each member. */
function splitTags(value: string): string[] {
  const members: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      members.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  members.push(current.trim());
  return members;
}
