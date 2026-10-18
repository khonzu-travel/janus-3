import type { HighlightToken } from './highlight.js';

/**
 * A JSON tokenizer for previews. Shiki's JavaScript regex
 * engine takes several hundred milliseconds on a 64 KiB JSON body under the
 * reference profile; JSON's grammar is small enough to scan in one linear
 * pass instead. The colours are github-light's and github-dark's for the same
 * scopes, so the result looks as shiki's would (jsonTokens.test.ts compares
 * them). Anything that is not JSON returns null, and shiki takes over.
 */

type Kind = 'plain' | 'key' | 'string' | 'escape' | 'constant';

const COLOURS: Readonly<Record<Kind, { readonly light: string; readonly dark: string }>> = {
  plain: { light: '#24292E', dark: '#E1E4E8' },
  key: { light: '#005CC5', dark: '#79B8FF' },
  string: { light: '#032F62', dark: '#9ECBFF' },
  escape: { light: '#005CC5', dark: '#79B8FF' },
  constant: { light: '#005CC5', dark: '#79B8FF' },
};

const sameColour = (a: Kind, b: Kind): boolean =>
  COLOURS[a].light === COLOURS[b].light && COLOURS[a].dark === COLOURS[b].dark;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;
const WHITESPACE = /[ \t\r]+/y;

export function tokenizeJson(code: string): HighlightToken[][] | null {
  const lines: HighlightToken[][] = [[]];
  let line = lines[0] ?? [];
  let pending: { kind: Kind; text: string } | null = null;
  const emit = (kind: Kind, text: string): void => {
    // Adjacent runs of one colour become one token.
    const merged = kind === 'escape' ? 'constant' : kind;
    if (pending !== null && sameColour(pending.kind, merged)) {
      pending.text += text;
      return;
    }
    flush();
    pending = { kind: merged, text };
  };
  const flush = (): void => {
    if (pending === null) return;
    const { light, dark } = COLOURS[pending.kind];
    line.push({ content: pending.text, light, dark });
    pending = null;
  };

  // Containers open, innermost last: in an object, a string before ':' is a key.
  const stack: ('object' | 'array')[] = [];
  let expectKey = false;
  let index = 0;
  while (index < code.length) {
    const char = code[index] ?? '';
    if (char === '\n') {
      flush();
      line = [];
      lines.push(line);
      index++;
      continue;
    }
    WHITESPACE.lastIndex = index;
    const space = WHITESPACE.exec(code);
    if (space !== null) {
      emit('plain', space[0]);
      index += space[0].length;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? 'object' : 'array');
      expectKey = char === '{';
      emit('plain', char);
      index++;
    } else if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
      emit('plain', char);
      index++;
    } else if (char === ',') {
      expectKey = stack.at(-1) === 'object';
      emit('plain', char);
      index++;
    } else if (char === ':') {
      expectKey = false;
      emit('plain', char);
      index++;
    } else if (char === '"') {
      const kind: Kind = expectKey ? 'key' : 'string';
      let start = index;
      index++;
      for (;;) {
        if (index >= code.length) {
          // A preview cut short inside a string: the rest is that string.
          emit(kind, code.slice(start));
          break;
        }
        const next = code[index];
        if (next === '"') {
          emit(kind, code.slice(start, index + 1));
          index++;
          break;
        }
        if (next === '\n' || (next !== undefined && next < ' ')) return null;
        if (next === '\\') {
          ESCAPE.lastIndex = index;
          const escape = ESCAPE.exec(code);
          if (escape === null) {
            // A cut preview may end inside an escape; anywhere else it is not JSON.
            if (/^\\(?:u[0-9a-fA-F]{0,3})?$/.test(code.slice(index))) {
              emit(kind, code.slice(start));
              index = code.length;
              break;
            }
            return null;
          }
          emit(kind, code.slice(start, index));
          // Shiki colours an escape in a key like the key, and in a value like a constant.
          emit(kind === 'key' ? 'key' : 'escape', escape[0]);
          index += escape[0].length;
          start = index;
          continue;
        }
        index++;
      }
    } else {
      NUMBER.lastIndex = index;
      const number = NUMBER.exec(code);
      const literal = ['true', 'false', 'null'].find((word) => code.startsWith(word, index));
      const token = number?.[0] ?? literal;
      if (token === undefined) return null;
      emit('constant', token);
      index += token.length;
    }
  }
  flush();
  return lines;
}
