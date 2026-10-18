import { STATUS_CODES } from 'node:http';
import zlib from 'node:zlib';

import type { HoldTicket, TransportCapacity, TransportDirective } from '@janus/core';

/**
 * Transport work core decides and the adapter performs:
 * decoding request bodies, compressing response bodies, holding slots for
 * `timeout` faults, and the exact bytes of `truncate` and `malformed`.
 */

/** A `TransportCapacity` with `slots` held connections at once. */
export function createHoldCapacity(slots: number): TransportCapacity & { readonly held: () => number } {
  let held = 0;
  return {
    held: () => held,
    tryHold(): HoldTicket | null {
      if (held >= slots) return null;
      held++;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          held--;
        },
      };
    },
  };
}

export type DecodeResult =
  | { readonly kind: 'decoded'; readonly body: Uint8Array }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid'; readonly coding: string };

/**
 * Removes `codings` (in the order they were applied) from `body`, streaming,
 * and stops as soon as any stage's output passes `limit` bytes. Data that does not decode, ends
 * early, or has bytes after the end of
 * its stream is `invalid`, naming the coding.
 */
export async function decodeBody(body: Uint8Array, codings: readonly string[], limit: number): Promise<DecodeResult> {
  let current = body;
  for (const coding of [...codings].reverse()) {
    const result = await decodeOne(current, coding, limit);
    if (result.kind !== 'decoded') return result;
    current = result.body;
  }
  return { kind: 'decoded', body: current };
}

function decoder(coding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress {
  if (coding === 'br') return zlib.createBrotliDecompress();
  if (coding === 'deflate') return zlib.createInflate();
  return zlib.createGunzip();
}

function decodeOne(input: Uint8Array, coding: string, limit: number): Promise<DecodeResult> {
  return new Promise((resolve) => {
    const stream = decoder(coding);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: DecodeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop at once: a small body that expands to gigabytes is refused here, never after.
        settle({ kind: 'too-large' });
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', () => {
      settle({ kind: 'invalid', coding });
    });
    stream.on('end', () => {
      // `bytesWritten` counts the input the decoder consumed; anything left is trailing data.
      if (stream.bytesWritten < input.length) settle({ kind: 'invalid', coding });
      else settle({ kind: 'decoded', body: new Uint8Array(Buffer.concat(chunks, size)) });
    });
    stream.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

/** Compresses a response body at the fixed levels, so the same body always gives the same bytes. */
export function compressBody(body: Uint8Array, coding: NonNullable<TransportDirective['coding']>): Uint8Array {
  const input = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (coding === 'br') {
    return new Uint8Array(zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }));
  }
  if (coding === 'deflate') return new Uint8Array(zlib.deflateSync(input, { level: 6 }));
  return new Uint8Array(zlib.gzipSync(input, { level: 6 }));
}

/** A response as it goes on the wire: status, header lines in order, body. */
export interface WireResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  /** Null when no body is written (HEAD, a bodyless status). */
  readonly body: Uint8Array | null;
}

/**
 * The bytes a `truncate` or `malformed` fault writes. The
 * headers must carry the full `Content-Length` of the body as it would be sent.
 */
export function faultBytes(
  response: WireResponse,
  fault: Extract<TransportDirective['fault'], { kind: 'truncate' | 'malformed' }>,
): Buffer {
  const statusLine = `HTTP/1.1 ${String(response.status)} ${STATUS_CODES[response.status] ?? ''}\r\n`;
  const line = ([name, value]: readonly [string, string]): string => `${name}: ${value}\r\n`;
  const body = response.body === null ? Buffer.alloc(0) : Buffer.from(response.body);
  if (fault.kind === 'truncate') {
    const head = statusLine + response.headers.map(line).join('');
    if (body.length === 0) return Buffer.from(head, 'latin1');
    const cut = fault.bytes === null ? Math.floor(body.length / 2) : Math.min(fault.bytes, body.length - 1);
    return Buffer.concat([Buffer.from(`${head}\r\n`, 'latin1'), body.subarray(0, cut)]);
  }
  const isLength = ([name]: readonly [string, string]): boolean => name.toLowerCase() === 'content-length';
  let head: string;
  switch (fault.form) {
    case 'status-line':
      head = 'HTTP/1.1 9999 Malformed\r\n' + response.headers.map(line).join('') + '\r\n';
      break;
    case 'header-line':
      head = statusLine + response.headers.map(line).join('') + 'Malformed header line\r\n\r\n';
      break;
    case 'conflicting-length': {
      const length = Number(response.headers.find(isLength)?.[1] ?? body.length);
      const others = response.headers.filter((header) => !isLength(header));
      head =
        statusLine +
        others.map(line).join('') +
        `content-length: ${String(length)}\r\ncontent-length: ${String(length + 1)}\r\n\r\n`;
      break;
    }
    case 'bad-chunk': {
      const others = response.headers.filter((header) => !isLength(header));
      head = statusLine + others.map(line).join('') + 'transfer-encoding: chunked\r\n\r\nzz\r\n';
      break;
    }
  }
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}
