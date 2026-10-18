import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_BUDGET_MS, tokenize, useHighlightedTokens, type HighlightLanguage } from './highlight.js';

// Highlighting in time-checked slices. JSON has its own linear
// tokenizer (jsonTokens.test.ts), so the slicing runs on YAML: JSON is YAML too.

const big = JSON.stringify(
  Array.from({ length: 200 }, (_, index) => ({ id: index, name: `item ${String(index)}`, tags: ['a', 'b'] })),
  null,
  2,
);

const text = (tokens: { content: string }[][]) =>
  tokens.map((line) => line.map((token) => token.content).join('')).join('\n');

describe('tokenize', () => {
  it('keeps the text exact across slices and carries the grammar state', async () => {
    const { tokens } = await tokenize(big, 'yaml', null);
    expect(tokens).not.toBeNull();
    expect(text(tokens ?? [])).toBe(big);
    // A value after the first slice is still coloured, in both themes.
    const late = tokens
      ?.slice(700)
      .flat()
      .find((token) => token.content.includes('item'));
    expect(late?.light).toMatch(/^#/);
    expect(late?.dark).toMatch(/^#/);
    expect(late?.light).not.toBe(late?.dark);
  });

  it('stops and returns nothing once the budget has passed', async () => {
    let clock = 0;
    const now = () => (clock += HIGHLIGHT_BUDGET_MS);
    expect((await tokenize(big, 'yaml', HIGHLIGHT_BUDGET_MS, now)).tokens).toBeNull();
  });

  it('finishes a short preview within one slice whatever the clock says', async () => {
    let clock = 0;
    const now = () => (clock += 10 * HIGHLIGHT_BUDGET_MS);
    expect((await tokenize('{"a": 1}', 'yaml', HIGHLIGHT_BUDGET_MS, now)).tokens).not.toBeNull();
  });
});

describe('useHighlightedTokens', () => {
  it('does not reuse tokens when only the language changes', async () => {
    const code = '{"answer": 42}';
    const { result, rerender } = renderHook(
      ({ language }: { readonly language: HighlightLanguage }) => useHighlightedTokens(code, language),
      { initialProps: { language: 'json' as HighlightLanguage } },
    );
    await waitFor(() => {
      expect(result.current.tokens).not.toBeNull();
    });

    rerender({ language: 'yaml' });
    expect(result.current.tokens).toBeNull();
  });
});
