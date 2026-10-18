import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  visit,
  type Node as YamlNode,
  type YAMLMap,
} from 'yaml';

/**
 * Writing documents back to YAML: the change is applied to
 * the existing file's document model, so comments, key order and quoting of
 * untouched values survive. Multi-line strings are written as block literals,
 * so scripts and bodies stay readable.
 */

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };

/** The YAML text for `value`, keeping what it can of `existing`. */
export function writeYamlDocument(existing: string | null, value: Readonly<Record<string, unknown>>): string {
  const plain = JSON.parse(JSON.stringify(value)) as Record<string, Json>;
  if (existing === null || existing.trim() === '') return finish(fresh(plain));
  const document = parseDocument(existing);
  if (document.errors.length > 0 || !isMap(document.contents)) return finish(fresh(plain));
  mergeMap(document, document.contents, plain);
  return finish(document);
}

function fresh(value: Record<string, Json>): Document {
  return new Document(value);
}

function finish(document: Document): string {
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && node.value.includes('\n') && node.type !== Scalar.BLOCK_LITERAL) {
        // A block literal cannot hold trailing spaces on a line or carriage returns faithfully.
        if (!/[ \t]\n|\r/.test(node.value)) node.type = Scalar.BLOCK_LITERAL;
      }
    },
  });
  if (isMap(document.contents)) document.contents.flow = false;
  return document.toString({ lineWidth: 0 });
}

function mergeMap(document: Document, map: YAMLMap, value: Readonly<Record<string, Json | undefined>>): void {
  for (const pair of [...map.items]) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (!Object.hasOwn(value, key) || value[key] === undefined) map.delete(pair.key);
  }
  for (const [key, next] of Object.entries(value)) {
    if (next === undefined) continue;
    const current = map.get(key, true) as YamlNode | undefined;
    if (current !== undefined && isMap(current) && isRecord(next)) {
      mergeMap(document, current, next);
      continue;
    }
    if (current !== undefined && isSeq(current) && Array.isArray(next)) {
      if (equal((current as { toJSON(): unknown }).toJSON(), next)) continue;
    } else if (current !== undefined && isScalar(current)) {
      if (equal(current.value, next)) continue;
      if (!isObject(next)) {
        current.value = next;
        continue;
      }
    }
    map.set(key, document.createNode(next));
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, Json> {
  return isObject(value) && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
