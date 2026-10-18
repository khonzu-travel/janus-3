/**
 * Minimal runtime decoders. Every Atlas payload passes through one of these
 * before it reaches a view; a TypeScript assertion alone is not a decoder.
 */

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
  ) {
    super(`${path === '' ? 'response' : path}: expected ${expected}`);
    this.name = 'DecodeError';
  }
}

export type Decoder<T> = (value: unknown, path: string) => T;

export const string: Decoder<string> = (value, path) => {
  if (typeof value !== 'string') throw new DecodeError(path, 'a string');
  return value;
};

export const count: Decoder<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DecodeError(path, 'a non-negative integer');
  }
  return value;
};

export const boolean: Decoder<boolean> = (value, path) => {
  if (typeof value !== 'boolean') throw new DecodeError(path, 'a boolean');
  return value;
};

export function literal<const T extends string | boolean>(expected: T): Decoder<T> {
  return (value, path) => {
    if (value !== expected) throw new DecodeError(path, JSON.stringify(expected));
    return expected;
  };
}

export function pattern(regex: RegExp, description: string): Decoder<string> {
  return (value, path) => {
    const text = string(value, path);
    if (!regex.test(text)) throw new DecodeError(path, description);
    return text;
  };
}

export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null ? null : decoder(value, path));
}

export function array<T>(decoder: Decoder<T>): Decoder<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new DecodeError(path, 'an array');
    return value.map((item: unknown, index) => decoder(item, `${path}[${String(index)}]`));
  };
}

type Shape<T> = { readonly [K in keyof T]: Decoder<T[K]> };

/** Decodes the listed fields; unlisted fields are ignored so the server can add fields compatibly. */
export function object<T>(shape: Shape<T>): Decoder<T> {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecodeError(path, 'an object');
    const record = value as Record<string, unknown>;
    const out: Partial<T> = {};
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      out[key] = shape[key](record[key], path === '' ? key : `${path}.${key}`);
    }
    return out as T;
  };
}

/** Tries each decoder in turn; the first that succeeds wins. */
export function oneOf<T>(description: string, ...decoders: readonly Decoder<T>[]): Decoder<T> {
  return (value, path) => {
    for (const decoder of decoders) {
      try {
        return decoder(value, path);
      } catch (error) {
        if (!(error instanceof DecodeError)) throw error;
      }
    }
    throw new DecodeError(path, description);
  };
}

/** A field an older server may omit: `fallback` stands in for it, so absence is never a decode error. */
export function optional<T>(decoder: Decoder<T>, fallback: T): Decoder<T> {
  return (value, path) => (value === undefined ? fallback : decoder(value, path));
}
