import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Preview } from '../../atlas/wire.js';
import { BodyView } from './JsonTree.js';

const text = (value: string, truncated = false): Preview => ({
  state: 'available',
  encoding: 'utf8',
  value,
  byteLength: new TextEncoder().encode(value).length,
  truncated,
});

describe('the response body as a JSON tree', () => {
  it('opens the first levels, collapses large deep containers, and saves values', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const body = {
      items: [{ id: 'a', tags: [] }],
      deep: { list: Array.from({ length: 60 }, (_, index) => index), small: { x: true } },
      note: null,
    };
    render(<BodyView preview={text(JSON.stringify(body))} status={200} mediaType={null} onSave={onSave} />);
    const tree = screen.getByRole('list', { name: 'Response body (JSON tree)' });
    expect(within(tree).getByRole('button', { name: 'Collapse $' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(tree).getByRole('button', { name: 'Collapse $.items' })).toBeDefined();
    expect(within(tree).getByRole('button', { name: 'Collapse $.items[0]' })).toBeDefined();
    expect(within(tree).getByRole('button', { name: 'Collapse $.deep.small' })).toBeDefined();
    // Sixty items below the first level start collapsed, and their children are not rendered.
    const list = within(tree).getByRole('button', { name: 'Expand $.deep.list' });
    expect(list.getAttribute('aria-expanded')).toBe('false');
    expect(within(tree).getByText('60 items')).toBeDefined();
    expect(within(tree).queryByRole('button', { name: 'Save $.deep.list[0] as variable' })).toBeNull();
    await user.click(list);
    expect(within(tree).getByRole('button', { name: 'Save $.deep.list[59] as variable' })).toBeDefined();

    await user.click(within(tree).getByRole('button', { name: 'Save $.items[0].id as variable' }));
    expect(onSave).toHaveBeenLastCalledWith('id', '{{$response.body.$.items[0].id}}');
    await user.click(within(tree).getByRole('button', { name: 'Save $.deep.small as variable' }));
    expect(onSave).toHaveBeenLastCalledWith('small', '{{$response.body.$.deep.small}}');
  });

  it('switches to the raw text', async () => {
    const user = userEvent.setup();
    render(<BodyView preview={text('[1, 2]')} status={200} mediaType={null} />);
    expect(screen.getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /as variable/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByLabelText('Body preview (text)').textContent).toBe('[1, 2]');
    expect(screen.queryByRole('list', { name: 'Response body (JSON tree)' })).toBeNull();
  });

  it('keeps the text preview for bodies that are not complete JSON', () => {
    const { rerender } = render(<BodyView preview={text('hello')} status={200} mediaType={null} />);
    expect(screen.getByLabelText('Body preview (text)')).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Body format' })).toBeNull();
    rerender(<BodyView preview={text('{"a":1}', true)} status={200} mediaType={null} />);
    expect(screen.queryByRole('list', { name: 'Response body (JSON tree)' })).toBeNull();
    rerender(<BodyView preview={text('"just a string"')} status={200} mediaType={null} />);
    expect(screen.queryByRole('list', { name: 'Response body (JSON tree)' })).toBeNull();
  });
});

describe('large response rendering', () => {
  it('keeps a flat 20KB JSON body within the 2000-row budget', () => {
    const value = JSON.stringify(Array.from({ length: 10000 }, () => 0));
    const { container } = render(
      <BodyView preview={text(value)} status={200} mediaType="application/json" onSave={() => {}} />,
    );
    const rows = container.querySelectorAll('li').length;
    expect(rows).toBeLessThanOrEqual(2000);
  });
});

it('paginates large root arrays without changing saved JSON paths', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(
    <BodyView
      preview={text(JSON.stringify(Array.from({ length: 450 }, (_, index) => index)))}
      status={200}
      mediaType="application/json"
      onSave={onSave}
    />,
  );
  expect(screen.getByRole('button', { name: 'Previous page $' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Save $[200] as variable' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next page $' }));
  expect(screen.queryByRole('button', { name: 'Save $[0] as variable' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save $[200] as variable' }));
  expect(onSave).toHaveBeenLastCalledWith('value', '{{$response.body.$[200]}}');
  await user.click(screen.getByRole('button', { name: 'Next page $' }));
  expect(screen.getByRole('button', { name: 'Next page $' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Save $[449] as variable' })).toBeDefined();
});

describe('line numbers', () => {
  const numbers = (element: Element): string[] =>
    [...element.querySelectorAll('[data-line]')].map((line) => line.getAttribute('data-line') ?? '');

  it('number the tree as the indented text and the text by its lines, and can be turned off', async () => {
    const user = userEvent.setup();
    render(<BodyView preview={text('{"a":[1,2],"b":{}}')} status={200} mediaType={null} />);
    const tree = screen.getByRole('list', { name: 'Response body (JSON tree)' });
    // {, "a": [, 1, 2, ], "b": {}, }
    expect(numbers(tree)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    await user.click(within(tree).getByRole('button', { name: 'Collapse $.a' }));
    expect(numbers(tree)).toEqual(['1', '2', '6', '7']);
    // The numbers are not part of the text.
    expect(tree.textContent).not.toMatch(/\d{2}/);

    await user.click(screen.getByRole('button', { name: 'Text' }));
    const preview = screen.getByLabelText('Body preview (text)');
    expect(numbers(preview)).toEqual(['1']);
    await user.click(screen.getByRole('button', { name: 'Line numbers' }));
    expect(numbers(screen.getByLabelText('Body preview (text)'))).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Line numbers' }));
  });
});
