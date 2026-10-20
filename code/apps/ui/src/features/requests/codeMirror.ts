import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type Command,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * The script editor's CodeMirror setup, loaded only when a script editor
 * opens. Tab types an indent, or indents every selected line; Shift + Tab
 * outdents. Escape then Tab moves focus on, as in any CodeMirror editor.
 */

const INDENT = '  ';

/** Tab: an indent at the cursor, or the selected lines one step in. */
const tab: Command = (view) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  view.dispatch(view.state.replaceSelection(INDENT), { scrollIntoView: true, userEvent: 'input' });
  return true;
};

// Colours from the design tokens, so both themes follow.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--m-put)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--m-post)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--m-get)' },
  { tag: [tags.propertyName], color: 'var(--fg)' },
  { tag: [tags.definition(tags.variableName)], color: 'var(--accent)' },
  { tag: [tags.invalid], color: 'var(--bad)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--fg)', fontSize: 'var(--text-mono)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', minHeight: '10rem', maxHeight: '32rem' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '4px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--faint)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--fg)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--hover)',
    border: '1px solid var(--line)',
    color: 'var(--muted)',
    margin: '0 2px',
    padding: '0 4px',
  },
});

export interface ScriptEditorOptions {
  readonly value: string;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly onChange: (value: string) => void;
  /** JavaScript unless given. */
  readonly language?: EditorLanguage;
}

/** What an editor holds: a script, a JSON body, or any other text. */
export type EditorLanguage = 'javascript' | 'json' | 'text';

// JSON folds at each object and array, from the gutter or with Ctrl + Shift + [ and ].
const LANGUAGES = {
  javascript: () => [javascript()],
  json: () => [json(), foldGutter()],
  text: () => [],
} as const;

export function createScriptEditor(parent: HTMLElement, options: ScriptEditorOptions): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        indentUnit.of(INDENT),
        EditorState.tabSize.of(2),
        ...LANGUAGES[options.language ?? 'javascript'](),
        syntaxHighlighting(highlight),
        keymap.of([
          { key: 'Tab', run: tab, shift: indentLess },
          ...closeBracketsKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        theme,
        EditorView.contentAttributes.of({
          'aria-labelledby': options.labelledBy,
          ...(options.describedBy === undefined ? {} : { 'aria-describedby': options.describedBy }),
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}

/** Puts `value` in the editor unless it is there already (a change from outside: a reload, a revert). */
export function setScriptValue(view: EditorView, value: string): void {
  const current = view.state.doc.toString();
  if (current === value) return;
  view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
}
