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
});
