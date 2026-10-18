import { connect } from 'node:net';

import { buildSnapshot, createEngine } from '@janus/core';
import { describe, expect, it } from 'vitest';

import { createHttpAdapter } from './adapter.js';

const limit = 1024;
const snapshot = buildSnapshot(
  new Map(['GET', 'POST'].map((method) => [`default/note/${method}/200.txt`, new TextEncoder().encode('ok')])),
);
if (!snapshot.ok) throw new Error('Invalid test fixtures');
const fixtures = snapshot.snapshot;

async function exchange(parts: readonly string[]): Promise<string> {
  const app = createHttpAdapter({ engine: createEngine({ snapshot: fixtures }), limits: { maxHeaderBytes: limit } });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('No TCP address');
    return await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1', () => {
        let next = 0;
        const write = (): void => {
          const part = parts[next++];
          if (part === undefined || socket.destroyed) return;
          socket.write(part);
          if (next < parts.length) setTimeout(write, 5);
        };
        write();
      });
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        received += chunk;
      });
      socket.on('close', () => {
        resolve(received);
      });
      socket.on('error', reject);
    });
  } finally {
    await app.close();
  }
}

const good = 'GET /note HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';
const padded = `GET /note HTTP/1.1\r\nHost: localhost\r\nX-Pad:${' '.repeat(2000)}a\r\nConnection: close\r\n\r\n`;
const body = `GET /note HTTP/1.1\r\nX-Fake:${' '.repeat(2000)}a\r\n\r\n`;

describe('original header sizes over HTTP connections', () => {
  it('excludes a long request line after leading empty lines', async () => {
    const request = `\r\n\r\nGET /note?q=${'a'.repeat(2000)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
    expect(await exchange([request])).toMatch(/^HTTP\/1\.1 200/);
  });

  it('counts whitespace across socket reads', async () => {
    const response = await exchange([
      'GET /note HTTP/1.1\r\nHost: localhost\r\nX-Pad:',
      ' '.repeat(700),
      ' '.repeat(700),
      'a\r\nConnection: close\r\n\r\n',
    ]);
    expect(response).toMatch(/^HTTP\/1\.1 431/);
  });

  it('counts trailing whitespace', async () => {
    const response = await exchange([
      `GET /note HTTP/1.1\r\nHost: localhost\r\nX-Pad: a${'\t'.repeat(2000)}\r\nConnection: close\r\n\r\n`,
    ]);
    expect(response).toMatch(/^HTTP\/1\.1 431/);
  });

  it('accepts exactly the configured header-line budget, even without a space after the colon', async () => {
    const headers = 'Host:localhost\r\nConnection:close\r\nX-Pad:';
    const request = `GET /note HTTP/1.1\r\n${headers}${'a'.repeat(limit - headers.length - 2)}\r\n\r\n`;
    expect(await exchange([request])).toMatch(/^HTTP\/1\.1 200/);
  });

  it.each(['length', 'chunked'] as const)('skips a %s body before counting the next request', async (framing) => {
    const prefix =
      framing === 'length'
        ? `POST /note HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`
        : `POST /note HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)};x=y\r\n${body}\r\n0\r\nX-Trailer: ignored\r\n\r\n`;
    const response = await exchange([prefix + good]);
    expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
  });

  it.each(['length', 'chunked'] as const)(
    'enforces the next request limit after a fragmented %s body',
    async (framing) => {
      const headers =
        framing === 'length'
          ? `POST /note HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n`
          : `POST /note HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n`;
      const suffix = framing === 'length' ? '' : '\r\n0\r\n\r\n';
      const response = await exchange([headers, body.slice(0, 500), body.slice(500), suffix + padded]);
      expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(1);
      expect(response).toContain('HTTP/1.1 431');
    },
  );
});
