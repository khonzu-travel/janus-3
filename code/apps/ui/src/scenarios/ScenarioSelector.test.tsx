import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { errorResponse, FakeAtlas, jsonResponse, V1, type ScenarioWorld } from '../../test/fake-atlas.js';
import { App } from '../app/App.js';
import { createAtlasClient } from '../atlas/client.js';
import { decodeConfig } from '../config.js';

// The scenario picker in the top bar.

type Doc = Record<string, unknown>;

const scenario = (name: string, parent: string | null, description: string | null = null): Doc => ({
  name,
  description,
  extends: parent,
  chain: [name],
  ids: [],
  overrides: [],
  removes: [],
  endpoints: { own: 0, inherited: 0, total: 0 },
  endpointsHref: `endpoints?scenario=${name}&at=${V1}`,
});

const inventory = (name: string): Doc => ({ snapshotVersion: V1, scenario: name, items: [] });

function world(items: readonly Doc[]): ScenarioWorld {
  return {
    configuredDefault: 'default',
    scenarios: { snapshotVersion: V1, configuredDefault: 'default', items },
    inventories: Object.fromEntries(items.map((item) => [item['name'] as string, inventory(item['name'] as string)])),
    endpoints: {},
    fixtures: {},
  };
}

const FOUR = [
  scenario('alpha', 'default'),
  scenario('beta', 'alpha'),
  scenario('default', null),
  scenario('payment-declined', 'default', 'The card is declined'),
];

function renderApp(hash = '', items: readonly Doc[] = FOUR) {
  window.location.hash = hash;
  const fake = new FakeAtlas();
  fake.world = world(items);
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch, timeoutMs: 2000 })} />);
  return { fake, user: userEvent.setup() };
}

const trigger = () => screen.findByRole('button', { name: /^Scenario / }, { timeout: 5000 });
const names = () =>
  within(screen.getByRole('listbox', { name: 'Scenarios' }))
    .getAllByRole('option')
    .map((option) => option.getAttribute('aria-labelledby'))
    .map((id) => document.getElementById(id ?? '')?.textContent);
const active = () => {
  const filter = screen.getByRole('combobox', { name: 'Filter scenarios' });
  const option = document.getElementById(filter.getAttribute('aria-activedescendant') ?? '') as HTMLElement;
  return document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent;
};
const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

describe('the scenario list', () => {
  it('lists the configured default first and keeps it on top whatever the filter', async () => {
    const { user } = renderApp('#/endpoints?scenario=beta');
    const button = await trigger();
    expect(button.textContent).toBe('beta');
    await user.click(button);
    const filter = screen.getByRole('combobox', { name: 'Filter scenarios' });
    expect(document.activeElement).toBe(filter);
    expect(names()).toEqual(['default', 'alpha', 'beta', 'payment-declined']);
    const current = screen.getByRole('option', { selected: true });
    expect(current.textContent).toContain('beta');
    expect(current.textContent).toContain('extends alpha');
    expect(screen.getByRole('option', { name: 'payment-declined' }).getAttribute('title')).toBe('The card is declined');
    expect(screen.getByText('4 scenarios')).toBeDefined();

    await user.type(filter, 'PAY');
    expect(names()).toEqual(['default', 'payment-declined']);
    expect(screen.getByText('1 of 4 match')).toBeDefined();
    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(names()).toEqual(['default']);
    expect(screen.getByText('0 of 4 match')).toBeDefined();
  });

  it('switches scenario on a click and closes', async () => {
    const { user } = renderApp();
    await user.click(await trigger());
    await user.click(screen.getByRole('option', { name: 'alpha' }));
    expect(hashParams().get('scenario')).toBe('alpha');
    expect(screen.queryByRole('listbox')).toBeNull();
    await waitFor(async () => {
      expect((await trigger()).textContent).toBe('alpha');
    });
    expect(document.activeElement).toBe(await trigger());
  });

  it('moves with the arrow keys, switches on Enter and closes on Escape', async () => {
    const { user } = renderApp('#/endpoints?scenario=alpha');
    await user.click(await trigger());
    expect(active()).toBe('alpha');
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe('beta');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(active()).toBe('default');
    await user.keyboard('{ArrowUp}');
    expect(active()).toBe('payment-declined');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(await trigger());
    expect(hashParams().get('scenario')).toBe('alpha');

    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('combobox', { name: 'Filter scenarios' }), 'bet');
    expect(active()).toBe('beta');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(hashParams().get('scenario')).toBe('beta');
    });
    await user.click(await trigger());
    await user.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    await waitFor(() => {
      expect(hashParams().get('scenario')).toBeNull();
    });
  });

  it('closes on a click outside', async () => {
    const { user } = renderApp();
    await user.click(await trigger());
    expect(screen.getByRole('listbox')).toBeDefined();
    await user.click(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is shown with a single scenario, so a second can be created', async () => {
    renderApp('', [scenario('default', null)]);
    expect((await trigger()).textContent).toBe('default');
    expect(screen.getByRole('button', { name: 'New scenario' })).toBeDefined();
  });
});

describe('creating a scenario', () => {
  it('posts the name and parent, refetches the scenarios and switches to the new one', async () => {
    const { fake, user } = renderApp('#/endpoints?scenario=alpha');
    const posted: Doc[] = [];
    fake.extraPost = (path, body) => {
      if (path !== 'scenarios') return null;
      posted.push(body);
      const current = fake.world as ScenarioWorld;
      const name = body['name'] as string;
      fake.world = {
        ...current,
        scenarios: {
          ...current.scenarios,
          items: [...(current.scenarios['items'] as Doc[]), scenario(name, body['extends'] as string)],
        },
        inventories: { ...current.inventories, [name]: inventory(name) },
      };
      return jsonResponse(201, { apiVersion: 'atlas.v1', name, extends: body['extends'] });
    };
    await user.click(await trigger());
    await user.click(screen.getByRole('button', { name: 'New scenario' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'New scenario name' });
    expect(document.activeElement).toBe(input);
    expect(screen.getByLabelText<HTMLSelectElement>('Inherits from').value).toBe('alpha');
    expect(screen.getByText(/Enter creates it and switches to it; Esc cancels\./)).toBeDefined();
    await user.selectOptions(screen.getByLabelText('Inherits from'), 'beta');
    await user.type(input, 'gamma{Enter}');

    await waitFor(() => {
      expect(hashParams().get('scenario')).toBe('gamma');
    });
    expect(posted).toEqual([{ name: 'gamma', extends: 'beta' }]);
    await waitFor(async () => {
      expect((await trigger()).textContent).toBe('gamma');
    });
    expect(fake.requests.filter((request) => request === '/_janus/scenarios').length).toBeGreaterThan(1);
    await user.click(await trigger());
    expect(names()).toContain('gamma');
  });

  it('refuses an invalid or taken name, and Escape goes back to the button', async () => {
    const { user } = renderApp();
    await user.click(await trigger());
    await user.click(screen.getByRole('button', { name: 'New scenario' }));
    const input = screen.getByRole('textbox', { name: 'New scenario name' });
    const create = screen.getByRole('button', { name: 'Create scenario' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(input, 'Bad_Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('lower-case letters');
    await user.clear(input);
    await user.type(input, 'alpha');
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Scenario alpha already exists.');
    await user.clear(input);
    await user.type(input, 'fine-name');
    expect((create as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New scenario name' })).toBeNull();
    expect(document.activeElement).toBe(await trigger());
  });

  it('shows the server’s error and stays open', async () => {
    const { fake, user } = renderApp();
    fake.extraPost = (path) =>
      path === 'scenarios' ? errorResponse(409, 'scenario-exists', 'Scenario gamma already exists on disk.') : null;
    await user.click(await trigger());
    await user.click(screen.getByRole('button', { name: 'New scenario' }));
    await user.type(screen.getByRole('textbox', { name: 'New scenario name' }), 'gamma');
    await user.click(screen.getByRole('button', { name: 'Create scenario' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Scenario gamma already exists on disk.');
    expect(screen.getByRole('textbox', { name: 'New scenario name' })).toBeDefined();
    expect(hashParams().get('scenario')).toBeNull();
  });
});
