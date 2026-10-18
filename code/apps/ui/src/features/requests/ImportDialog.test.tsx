import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createAtlasClient } from '../../atlas/client.js';
import { decodeConfig } from '../../config.js';
import { AtlasProvider } from '../../hooks/AtlasProvider.js';
import { ImportDialog } from './ImportDialog.js';

it('previews revised files with the same name', async () => {
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw Error(config.message);
  const client = createAtlasClient(config.config);
  const preview = vi.spyOn(client.runner, 'importFiles').mockResolvedValue({
    collection: 'orders',
    name: 'Orders',
    format: 'postman',
    exists: false,
    existingEnvironments: [],
    files: [{ path: 'orders/010-get.request.yaml', kind: 'request' }],
    report: [],
    origins: [],
    transactions: [],
    problems: [],
    preview: true,
    written: false,
  });
  render(
    <AtlasProvider client={client} eventSource={null}>
      <ImportDialog onClose={() => {}} onImported={() => {}} />
    </AtlasProvider>,
  );
  const user = userEvent.setup();
  const file = (content: string): File => {
    const value = new File([content], 'orders.json', { type: 'application/json' });
    Object.defineProperty(value, 'arrayBuffer', {
      value: () => Promise.resolve(new TextEncoder().encode(content).buffer),
    });
    return value;
  };
  await user.upload(screen.getByLabelText('Files or a zip'), file('version1'));
  await waitFor(() => {
    expect(preview).toHaveBeenCalledTimes(1);
  });
  await screen.findByLabelText('Collection name');
  await user.upload(screen.getByLabelText('Files or a zip'), file('version2'));
  await waitFor(() => {
    expect(preview).toHaveBeenCalledTimes(2);
  });
});
