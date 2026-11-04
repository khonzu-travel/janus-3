import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton.js';

describe('the copy button', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the copy command when the Clipboard API refuses', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    let copied = '';
    const execCommand = vi.fn(() => {
      copied = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    render(<CopyButton label="Copy body" text={() => '{"a":1}'} />);
    await user.click(screen.getByRole('button', { name: 'Copy body' }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toBe('{"a":1}');
    expect((await screen.findByRole('status')).textContent).toBe('Copied');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy body' }));
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('says it could not copy, with a cross, when both ways fail', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    render(<CopyButton label="Copy body" text={() => 'x'} />);
    const button = screen.getByRole('button', { name: 'Copy body' });
    await user.click(button);
    expect((await screen.findByRole('status')).textContent).toBe('Could not copy');
    expect(button.getAttribute('title')).toBe('Could not copy');
    expect(button.querySelector('svg path')?.getAttribute('d')).toBe('M6 6l12 12M18 6L6 18');
  });
});
