import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { CodeEditor } from './CodeEditor.js';

describe('the code editor', () => {
  it('folds JSON from the gutter and copies the text as it is now', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CodeEditor label="Body" language="json" value={'{\n  "a": [1, 2]\n}\n'} onChange={() => undefined} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.cm-foldGutter')).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Copy body' }));
    expect(await navigator.clipboard.readText()).toBe('{\n  "a": [1, 2]\n}\n');
  });

  it('has neither a fold gutter nor a copy button for a script', async () => {
    const { container } = render(<CodeEditor label="Script" value="test();" onChange={() => undefined} />);
    await waitFor(() => {
      expect(container.querySelector('.cm-content')).not.toBeNull();
    });
    expect(container.querySelector('.cm-foldGutter')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Copy/ })).toBeNull();
  });

  it('finds with Ctrl + F and replaces with Ctrl + H while the editor has focus', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    const { container } = render(
      <CodeEditor
        label="Body"
        language="text"
        value={'one cat\ntwo cat\nthree dog\n'}
        onChange={(next) => {
          changes.push(next);
        }}
      />,
    );
    const content = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.cm-content');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await user.click(content);

    await user.keyboard('{Control>}f{/Control}');
    const find = await screen.findByRole('textbox', { name: 'Find' });
    await waitFor(() => {
      expect(document.activeElement).toBe(find);
    });
    expect(screen.queryByRole('textbox', { name: 'Replace' })).toBeNull();
    await user.type(find, 'cat');
    await screen.findByText('1 of 2');
    await user.keyboard('{Enter}');
    await screen.findByText('2 of 2');

    await user.keyboard('{Control>}h{/Control}');
    const replace = await screen.findByRole('textbox', { name: 'Replace' });
    await waitFor(() => {
      expect(document.activeElement).toBe(replace);
    });
    await user.type(replace, 'bird');
    await user.click(screen.getByRole('button', { name: 'Replace all' }));
    expect(changes.at(-1)).toBe('one bird\ntwo bird\nthree dog\n');
    await screen.findByText('No results');

    await user.click(replace);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull();
    });
    expect(document.activeElement).toBe(content);
  });
});

describe('select all in the code editor', () => {
  it('selects only the editor text when Ctrl + A is pressed on its copy button', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CodeEditor label="Body" language="json" value={'{"a": 1}'} onChange={() => undefined} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.cm-content')).not.toBeNull();
    });
    screen.getByRole('button', { name: 'Copy body' }).focus();
    await user.keyboard('{Control>}a{/Control}');
    const content = container.querySelector('.cm-content');
    expect(document.activeElement).toBe(content);
    const { EditorView } = await import('@codemirror/view');
    const view = EditorView.findFromDOM(content as HTMLElement);
    expect(view?.state.selection.main.from).toBe(0);
    expect(view?.state.selection.main.to).toBe('{"a": 1}'.length);
  });
});
