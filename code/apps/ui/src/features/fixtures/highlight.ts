import { useEffect, useState } from 'react';
import type { GrammarState, HighlighterCore, LanguageInput } from 'shiki/core';

import { measureHighlight } from '../../perf.js';

/** Languages the body preview highlights, and request scripts. Plain text is shown as it is. */
export type HighlightLanguage = 'json' | 'yaml' | 'xml' | 'html' | 'javascript';

/** One highlighted run of text: its colour in the light and the dark theme. */
export interface HighlightToken {
  readonly content: string;
  readonly light?: string;
  readonly dark?: string;
}

/** Past this much tokenizing time, the preview stays plain and offers "Highlight". */
export const HIGHLIGHT_BUDGET_MS = 150;

/** Lines tokenized between two time checks. */
const SLICE_LINES = 64;

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/** Each grammar is its own chunk, fetched the first time a preview needs it. */
const GRAMMARS: Readonly<Record<HighlightLanguage, () => LanguageInput>> = {
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
};

/** The grammar for a media type, or null to show the preview without highlighting. */
export function highlightLanguage(mediaType: string | null): HighlightLanguage | null {
  const essence = (mediaType?.split(';')[0] ?? '').trim().toLowerCase();
  if (essence === 'application/json' || essence.endsWith('+json')) return 'json';
  if (essence === 'application/yaml' || essence === 'application/x-yaml' || essence.endsWith('+yaml')) return 'yaml';
  if (essence === 'text/html' || essence === 'application/xhtml+xml') return 'html';
  if (essence === 'application/xml' || essence === 'text/xml' || essence.endsWith('+xml')) return 'xml';
  return null;
}

let core: Promise<HighlighterCore> | undefined;
const loadedGrammars = new Map<HighlightLanguage, Promise<void>>();

/**
 * Loads shiki on first use only, with the JavaScript regex engine (no
 * WebAssembly) and both themes; grammars load one by one.
 */
async function loadHighlighter(language: HighlightLanguage): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
    });
  })();
  const highlighter = await core;
  let grammar = loadedGrammars.get(language);
  if (grammar === undefined) {
    grammar = highlighter.loadLanguage(GRAMMARS[language]());
    loadedGrammars.set(language, grammar);
  }
  await grammar;
  return highlighter;
}

export interface Tokenized {
  /** Null when the time budget ran out before the end. */
  readonly tokens: HighlightToken[][] | null;
}

/**
 * Tokenizes `code` in slices of lines, carrying the grammar state across
 * slices, and stops once `budgetMs` of tokenizing has passed. A null budget
 * runs to completion. `now` is injectable for tests.
 */
export async function tokenize(
  code: string,
  language: HighlightLanguage,
  budgetMs: number | null,
  now: () => number = () => performance.now(),
): Promise<Tokenized> {
  if (language === 'json') {
    const { tokenizeJson } = await import('./jsonTokens.js');
    const began = now();
    const tokens = tokenizeJson(code);
    if (tokens !== null) {
      measureHighlight(now() - began, { chars: code.length, complete: true });
      return { tokens };
    }
  }
  const highlighter = await loadHighlighter(language);
  const lines = code.split('\n');
  const tokens: HighlightToken[][] = [];
  let state: GrammarState | undefined;
  let spent = 0;
  for (let start = 0; start < lines.length; start += SLICE_LINES) {
    const began = now();
    const result = highlighter.codeToTokens(lines.slice(start, start + SLICE_LINES).join('\n'), {
      lang: language,
      themes: THEMES,
      defaultColor: false,
      ...(state === undefined ? {} : { grammarState: state }),
    });
    state = result.grammarState;
    for (const line of result.tokens) {
      tokens.push(
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
    spent += now() - began;
    if (budgetMs !== null && spent > budgetMs && start + SLICE_LINES < lines.length) {
      measureHighlight(spent, { chars: code.length, complete: false });
      return { tokens: null };
    }
  }
  measureHighlight(spent, { chars: code.length, complete: true });
  return { tokens };
}

export interface Highlighting {
  /** Null while shiki loads, without a grammar, after a failure, or past the time budget. */
  readonly tokens: HighlightToken[][] | null;
  /** True when highlighting stopped at the budget; `highlight()` then runs it to completion. */
  readonly timedOut: boolean;
  readonly highlight: () => void;
}

/**
 * Tokens for `code`: highlighted in time-checked slices, and
 * left plain with a "Highlight" action past the budget. Tokens are text and
 * colours only: nothing in a fixture is ever interpreted as markup.
 */
export function useHighlightedTokens(code: string, language: HighlightLanguage | null): Highlighting {
  const [result, setResult] = useState<{
    code: string;
    language: HighlightLanguage;
    tokens: HighlightToken[][] | null;
  } | null>(null);
  const [forced, setForced] = useState<{ code: string; language: HighlightLanguage } | null>(null);
  const force = forced?.code === code && forced.language === language;
  useEffect(() => {
    // Shiki splits lines on CR LF too; keep such bodies byte-exact by not highlighting them.
    if (language === null || code.includes('\r')) return undefined;
    let cancelled = false;
    tokenize(code, language, force ? null : HIGHLIGHT_BUDGET_MS)
      .then(({ tokens }) => {
        if (!cancelled) setResult({ code, language, tokens });
      })
      .catch(() => {
        // Highlighting is an enhancement: the plain preview stays.
      });
    return () => {
      cancelled = true;
    };
  }, [code, language, force]);
  const current = result !== null && result.code === code && result.language === language ? result : null;
  return {
    tokens: current?.tokens ?? null,
    timedOut: current !== null && current.tokens === null,
    highlight: () => {
      if (language !== null) setForced({ code, language });
    },
  };
}
