/**
 * A JSON document kept in source order, with every string's location, so
 * dynamic JSON fixtures can be scanned by JSON Pointer and re-serialised
 * without reordering keys or respelling numbers.
 * Callers validate the text first (`parseJson`); this assumes it is valid.
 */
export type JsonNode =
  | { readonly kind: 'object'; readonly entries: readonly (readonly [key: string, value: JsonNode])[] }
  | { readonly kind: 'array'; readonly items: readonly JsonNode[] }
  | { readonly kind: 'string'; readonly value: string; readonly location: StringLocation }
  /** A number, `true`, `false` or `null`, exactly as written. */
  | { readonly kind: 'literal'; readonly text: string };

export interface StringLocation {
  /** UTF-16 offset of the opening quote in the text. */
  readonly offset: number;
  /**
   * For each decoded UTF-16 index (plus one past the end), the offset in the
   * text of the source character it came from. Escapes make these differ.
   */
  readonly sourceIndex: readonly number[];
}

export function parseJsonTree(text: string): JsonNode {
  let index = 0;
  const whitespace = (): void => {
    while (index < text.length && ' \t\n\r'.includes(text.charAt(index))) index++;
  };
  const string = (): JsonNode & { kind: 'string' } => {
    const offset = index;
    index++;
    let value = '';
    const sourceIndex: number[] = [];
    while (text.charAt(index) !== '"') {
      const start = index;
      const char = text.charAt(index);
      if (char === '\\') {
        const escape = text.charAt(index + 1);
        if (escape === 'u') {
          value += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16));
          index += 6;
        } else {
          value += ESCAPES[escape] ?? escape;
          index += 2;
        }
      } else {
        value += char;
        index++;
      }
      sourceIndex.push(start);
    }
    sourceIndex.push(index);
    index++;
    return { kind: 'string', value, location: { offset, sourceIndex } };
  };
  const value = (): JsonNode => {
    whitespace();
    const char = text.charAt(index);
    if (char === '{') {
      index++;
      const entries: [string, JsonNode][] = [];
      whitespace();
      if (text.charAt(index) === '}') {
        index++;
        return { kind: 'object', entries };
      }
      for (;;) {
        whitespace();
        const key = string().value;
        whitespace();
        index++; // ':'
        entries.push([key, value()]);
        whitespace();
        if (text.charAt(index++) === '}') return { kind: 'object', entries };
      }
    }
    if (char === '[') {
      index++;
      const items: JsonNode[] = [];
      whitespace();
      if (text.charAt(index) === ']') {
        index++;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(value());
        whitespace();
        if (text.charAt(index++) === ']') return { kind: 'array', items };
      }
    }
    if (char === '"') return string();
    const start = index;
    while (index < text.length && !',]} \t\n\r'.includes(text.charAt(index))) index++;
    return { kind: 'literal', text: text.slice(start, index) };
  };
  return value();
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Every string value (never an object key) in document order, with its JSON Pointer. */
export function jsonStrings(
  root: JsonNode,
): { readonly pointer: string; readonly node: JsonNode & { kind: 'string' } }[] {
  const out: { pointer: string; node: JsonNode & { kind: 'string' } }[] = [];
  const visit = (node: JsonNode, pointer: string): void => {
    if (node.kind === 'string') out.push({ pointer, node });
    else if (node.kind === 'object') {
      for (const [key, child] of node.entries) visit(child, `${pointer}/${escapePointer(key)}`);
    } else if (node.kind === 'array') {
      node.items.forEach((child, i) => {
        visit(child, `${pointer}/${String(i)}`);
      });
    }
  };
  visit(root, '');
  return out;
}

/** RFC 6901: "~" is "~0" and "/" is "~1". */
export function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Compact serialisation in source order. `string` supplies the JSON text of
 * each string value by pointer, so a caller can replace it with any JSON value.
 */
export function serializeJsonTree(
  root: JsonNode,
  string: (node: JsonNode & { kind: 'string' }, pointer: string, out: JsonWriter) => void,
): string {
  const out = new JsonWriter();
  const visit = (node: JsonNode, pointer: string): void => {
    switch (node.kind) {
      case 'literal':
        out.write(node.text);
        return;
      case 'string':
        string(node, pointer, out);
        return;
      case 'array':
        out.write('[');
        node.items.forEach((child, i) => {
          if (i > 0) out.write(',');
          visit(child, `${pointer}/${String(i)}`);
        });
        out.write(']');
        return;
      case 'object':
        out.write('{');
        node.entries.forEach(([key, child], i) => {
          if (i > 0) out.write(',');
          out.write(`${JSON.stringify(key)}:`);
          visit(child, `${pointer}/${escapePointer(key)}`);
        });
        out.write('}');
        return;
    }
  };
  visit(root, '');
  return out.text;
}

/** Accumulates output and knows its current length, so callers can record spans. */
export class JsonWriter {
  #parts: string[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  get text(): string {
    return this.#parts.join('');
  }

  write(text: string): void {
    this.#parts.push(text);
    this.#length += text.length;
  }
}
