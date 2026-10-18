/** A 1-based position in a text. Columns count UTF-16 code units, as editors do. */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

export type JsonScanResult =
  | {
      readonly ok: true;
      /** Top-level object member name → position of its key (first occurrence). Empty for non-objects. */
      readonly members: ReadonlyMap<string, TextPosition>;
    }
  | {
      readonly ok: false;
      /** Engine-independent, e.g. `unexpected "}"` or `unexpected end of input`. */
      readonly message: string;
      readonly position: TextPosition;
      /** The offending character, when there is one. */
      readonly token?: string;
    };

export interface JsonScanOptions {
  /** Also fail on a key repeated within one object, which `JSON.parse` silently collapses. */
  readonly rejectDuplicateKeys?: boolean;
}

/**
 * Validates JSON text (RFC 8259) and locates the first syntax error, so
 * startup errors carry the same line, column and message on every JavaScript
 * engine. It accepts exactly what `JSON.parse` accepts, unless asked to reject
 * duplicate keys; use `JSON.parse` for the value.
 */
export function scanJson(text: string, options: JsonScanOptions = {}): JsonScanResult {
  const members = new Map<string, TextPosition>();
  const scanner = new Scanner(text, options.rejectDuplicateKeys === true);
  try {
    scanner.whitespace();
    scanner.value(0, members);
    scanner.whitespace();
    if (!scanner.atEnd()) scanner.fail();
    return { ok: true, members };
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return {
        ok: false,
        message: error.message,
        position: positionAt(text, error.offset),
        ...(error.token === undefined ? {} : { token: error.token }),
      };
    }
    throw error;
  }
}

/** The 1-based line and column of a UTF-16 offset. */
export function positionAt(text: string, offset: number): TextPosition {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text.charCodeAt(index) === 0x0a) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly token: string | undefined,
  ) {
    super(message);
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX4 = /^[0-9a-fA-F]{4}$/;
/** Nesting deeper than this is reported rather than risking the call stack. */
const MAX_DEPTH = 512;

class Scanner {
  #index = 0;

  constructor(
    private readonly text: string,
    private readonly rejectDuplicateKeys: boolean,
  ) {}

  atEnd(): boolean {
    return this.#index >= this.text.length;
  }

  fail(): never {
    if (this.atEnd()) throw new JsonSyntaxError('unexpected end of input', this.#index, undefined);
    const char = String.fromCodePoint(this.text.codePointAt(this.#index) ?? 0);
    const shown = char.charCodeAt(0) < 0x20 ? 'control character' : JSON.stringify(char);
    throw new JsonSyntaxError(`unexpected ${shown}`, this.#index, char);
  }

  whitespace(): void {
    while (!this.atEnd() && ' \t\n\r'.includes(this.text.charAt(this.#index))) this.#index++;
  }

  value(depth: number, members?: Map<string, TextPosition>): void {
    const char = this.text.charAt(this.#index);
    if (char === '{') this.object(depth, members);
    else if (char === '[') this.array(depth);
    else if (char === '"') this.string();
    else if (char === 't') this.word('true');
    else if (char === 'f') this.word('false');
    else if (char === 'n') this.word('null');
    else this.number();
  }

  private object(depth: number, members: Map<string, TextPosition> | undefined): void {
    this.enter(depth);
    this.#index++;
    this.whitespace();
    if (this.text.charAt(this.#index) === '}') {
      this.#index++;
      return;
    }
    const seen = new Set<string>();
    for (;;) {
      if (this.text.charAt(this.#index) !== '"') this.fail();
      const start = this.#index;
      const name = this.string();
      if (this.rejectDuplicateKeys && seen.has(name)) {
        const message = `duplicate key ${JSON.stringify(name)}; each key may appear only once per object`;
        throw new JsonSyntaxError(message, start, name);
      }
      seen.add(name);
      if (members !== undefined && !members.has(name)) members.set(name, positionAt(this.text, start));
      this.whitespace();
      this.expect(':');
      this.whitespace();
      this.value(depth + 1);
      this.whitespace();
      if (this.text.charAt(this.#index) === '}') {
        this.#index++;
        return;
      }
      this.expect(',');
      this.whitespace();
    }
  }

  private array(depth: number): void {
    this.enter(depth);
    this.#index++;
    this.whitespace();
    if (this.text.charAt(this.#index) === ']') {
      this.#index++;
      return;
    }
    for (;;) {
      this.value(depth + 1);
      this.whitespace();
      if (this.text.charAt(this.#index) === ']') {
        this.#index++;
        return;
      }
      this.expect(',');
      this.whitespace();
    }
  }

  /** Scans a string literal and returns its decoded value. */
  private string(): string {
    const start = this.#index;
    this.#index++;
    for (;;) {
      if (this.atEnd()) this.fail();
      const char = this.text.charAt(this.#index);
      if (char === '"') break;
      if (char.charCodeAt(0) < 0x20) this.fail();
      if (char === '\\') {
        this.#index++;
        const escape = this.text.charAt(this.#index);
        if (escape === 'u') {
          if (!HEX4.test(this.text.slice(this.#index + 1, this.#index + 5))) {
            this.#index++;
            while (/[0-9a-fA-F]/.test(this.text.charAt(this.#index))) this.#index++;
            this.fail();
          }
          this.#index += 4;
        } else if (!ESCAPES.has(escape)) {
          this.fail();
        }
      }
      this.#index++;
    }
    this.#index++;
    return JSON.parse(this.text.slice(start, this.#index)) as string;
  }

  private number(): void {
    NUMBER.lastIndex = this.#index;
    const match = NUMBER.exec(this.text);
    if (match === null) {
      if (this.text.charAt(this.#index) === '-') this.#index++;
      this.fail();
    }
    this.#index += match[0].length;
    // A partial match such as "01", "1." or "1e+" stops before the offending character.
    const next = this.text.charAt(this.#index);
    if (/[0-9]/.test(next)) this.fail();
    if (next === '.' || next === 'e' || next === 'E') {
      this.#index++;
      if (next !== '.' && '+-'.includes(this.text.charAt(this.#index))) this.#index++;
      this.fail();
    }
  }

  private word(word: string): void {
    for (const expected of word) {
      if (this.text.charAt(this.#index) !== expected) this.fail();
      this.#index++;
    }
  }

  private expect(char: string): void {
    if (this.text.charAt(this.#index) !== char) this.fail();
    this.#index++;
  }

  private enter(depth: number): void {
    if (depth >= MAX_DEPTH) throw new JsonSyntaxError('nesting is too deep to check', this.#index, undefined);
  }
}
