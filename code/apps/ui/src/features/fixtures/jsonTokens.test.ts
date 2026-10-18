import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { describe, expect, it } from 'vitest';

import { tokenize, type HighlightToken } from './highlight.js';
import { tokenizeJson } from './jsonTokens.js';

// The JSON tokenizer matches shiki's colours, character by character.

const SAMPLE = [
  '{',
  '  "name": "Example \\"quoted\\" \\u00e9 \\\\ \\/ \\n",',
  '  "k\\tey": -12.5e+3, "zero": 0, "t": true, "f": false, "n": null,',
  '  "list": [1, 2.25, {"inner": ["a", []]}, {}],',
  '  "unicode": "héllo — ✓"',
  '}',
  '',
].join('\n');

/** One entry per character: its light and dark colours. */
function colours(lines: readonly (readonly HighlightToken[])[]): string[] {
  return lines.flatMap((line, index) => [
    ...(index === 0 ? [] : ['\n']),
    ...line.flatMap((token) => Array.from(token.content, () => `${token.light ?? ''}/${token.dark ?? ''}`)),
  ]);
}

async function shikiTokens(code: string): Promise<HighlightToken[][]> {
  const highlighter = await createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [import('shiki/langs/json.mjs')],
  });
  const result = highlighter.codeToTokens(code, {
    lang: 'json',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  return result.tokens.map((line) =>
    line.map((token) => {
      const style = token.htmlStyle ?? {};
      const light = style['--shiki-light'];
      const dark = style['--shiki-dark'];
      return {
        content: token.content,
        ...(light === undefined ? {} : { light }),
        ...(dark === undefined ? {} : { dark }),
      };
    }),
  );
}

const text = (lines: readonly (readonly HighlightToken[])[]) =>
  lines.map((line) => line.map((token) => token.content).join('')).join('\n');

describe('tokenizeJson', () => {
  it("colours every character as shiki's JSON grammar does, in both themes", async () => {
    const ours = tokenizeJson(SAMPLE);
    expect(ours).not.toBeNull();
    expect(text(ours ?? [])).toBe(SAMPLE);
    expect(colours(ours ?? [])).toEqual(colours(await shikiTokens(SAMPLE)));
  });

  it('keeps a preview cut short inside a string, an escape or a number', () => {
    for (const cut of ['{"a": "unfinished', '{"a": "x\\u00', '{"a": [1, 2.5']) {
      expect(text(tokenizeJson(cut) ?? [])).toBe(cut);
    }
  });

  it('gives up on what is not JSON, so shiki colours it', () => {
    for (const other of ['{a: 1}', "{'a': 1}", '{"a": "line\nbreak"}', '{"a": tru}', '{"a": "\\x"} ']) {
      expect(tokenizeJson(other)).toBeNull();
    }
  });

  it('is what tokenize uses for JSON, falling back to shiki otherwise', async () => {
    expect((await tokenize(SAMPLE, 'json', 150)).tokens).toEqual(tokenizeJson(SAMPLE));
    const notJson = '{a: 1}';
    expect(text((await tokenize(notJson, 'json', null)).tokens ?? [])).toBe(notJson);
  });

  it('scans 64 KiB in a few milliseconds', () => {
    const body = JSON.stringify(
      Array.from({ length: 700 }, (_, index) => ({ id: `item-${String(index)}`, price: index / 2, ok: true })),
      null,
      2,
    ).slice(0, 64 * 1024);
    const started = performance.now();
    expect(tokenizeJson(body)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
