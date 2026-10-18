import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BodyView } from './JsonTree.js';
it('keeps upstream HTML/script payloads as text', () => {
  const source = JSON.stringify({
    value: '<img src=x onerror=alert(1)><script>alert(1)</script><svg onload=alert(1) />',
  });
  const { container } = render(
    <BodyView
      preview={{ state: 'available', encoding: 'utf8', value: source, byteLength: source.length, truncated: false }}
      status={200}
      mediaType="application/json"
    />,
  );
  expect(container.querySelector('img,script,svg[onload]')).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
});

import { screen } from '@testing-library/react';
import { FakeAtlas } from '../../../test/fake-atlas.js';
import { App } from '../../app/App.js';
import { createAtlasClient } from '../../atlas/client.js';
import { decodeConfig } from '../../config.js';
it('opens shared requests containing prototype-property header names', async () => {
  const config = decodeConfig({ serverUrl: 'http://janus.test' }, 'http://page.test/');
  if (!config.ok) throw Error(config.message);
  const fake = new FakeAtlas();
  window.location.hash = '#/requests?mode=explore&m=GET&t=/&h=__proto__%3A+x';
  render(<App client={createAtlasClient(config.config, { fetch: fake.fetch })} eventSource={null} />);
  expect(await screen.findByRole('form', { name: 'Request to simulate' })).toBeDefined();
  expect(screen.queryByText('Unexpected Application Error!')).toBeNull();
});
