import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

/** Counts original header bytes before Node trims optional whitespace. */
export function trackHeaderSizes(server: Server, limit: number): (request: IncomingMessage) => number | undefined {
  const sockets = new WeakMap<Socket, HeaderSizes>();
  server.on('connection', (socket) => {
    const sizes = new HeaderSizes(limit);
    sockets.set(socket, sizes);
    socket.prependListener('data', (chunk: Buffer) => {
      sizes.read(chunk);
    });
  });
  return (request) => sockets.get(request.socket)?.next();
}

/**
 * Observes framing only; Node remains responsible for parsing and validating
 * HTTP. Body bytes are skipped so keep-alive and pipelined requests each get
 * their own count. Neither bodies nor complete header sections are retained.
 */
class HeaderSizes {
  private state: 'request' | 'headers' | 'body' | 'chunk-size' | 'chunk' | 'chunk-end' | 'trailers' = 'request';
  private line = '';
  private requestLineBytes = 0;
  private bytes = 0;
  private remaining = 0;
  private length = 0;
  private chunked = false;
  private stopped = false;
  private readonly ready: number[] = [];

  constructor(private readonly limit: number) {}

  next(): number | undefined {
    return this.ready.shift() ?? (this.stopped ? this.limit + 1 : undefined);
  }

  read(chunk: Buffer): void {
    for (let offset = 0; offset < chunk.length && !this.stopped; offset++) {
      if (this.state === 'body' || this.state === 'chunk') {
        const consumed = Math.min(this.remaining, chunk.length - offset);
        this.remaining -= consumed;
        offset += consumed - 1;
        if (this.remaining === 0) this.state = this.state === 'body' ? 'request' : 'chunk-end';
        continue;
      }
      if (this.state === 'headers') {
        this.bytes++;
        // The final empty line is not part of the configured header-line budget.
        if (this.bytes > this.limit + 2) {
          this.ready.push(this.limit + 1);
          this.stopped = true;
          continue;
        }
      }
      const byte = chunk[offset];
      if (byte === undefined) return;
      this.line += String.fromCharCode(byte);
      // Only the request line's terminator matters; its target is bounded by
      // the adapter separately, without retaining another copy here.
      if (this.state === 'request') {
        this.requestLineBytes++;
        this.line = this.line.slice(-2);
      }
      // Node bounds the request line; chunk extensions and trailers are also
      // bounded here to avoid retaining arbitrary data in this observer.
      if (this.line.length > 64 * 1024 && this.state !== 'headers') {
        this.stopped = true;
        return;
      }
      if (byte !== 10) continue;
      const terminator = this.line.endsWith('\r\n') ? 2 : 1;
      const line = this.line.slice(0, -terminator);
      this.line = '';
      this.endLine(line, terminator);
    }
  }

  private endLine(line: string, terminator: number): void {
    switch (this.state) {
      case 'request':
        // Node ignores empty lines before a request, including on keep-alive.
        if (this.requestLineBytes === terminator) {
          this.requestLineBytes = 0;
          break;
        }
        this.requestLineBytes = 0;
        this.bytes = 0;
        this.length = 0;
        this.chunked = false;
        this.state = 'headers';
        break;
      case 'headers': {
        if (line === '') {
          this.ready.push(this.bytes - terminator);
          this.remaining = this.length;
          this.state = this.chunked ? 'chunk-size' : this.length > 0 ? 'body' : 'request';
          break;
        }
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'content-length') this.length = Number(value);
        if (name === 'transfer-encoding') this.chunked = true;
        break;
      }
      case 'chunk-size': {
        const size = line.split(';', 1)[0] ?? '';
        if (!/^[0-9a-f]+$/i.test(size)) {
          this.stopped = true;
          break;
        }
        this.remaining = parseInt(size, 16);
        this.state = this.remaining === 0 ? 'trailers' : 'chunk';
        break;
      }
      case 'chunk-end':
        if (line !== '') this.stopped = true;
        else this.state = 'chunk-size';
        break;
      case 'trailers':
        if (line === '') this.state = 'request';
        break;
      case 'body':
      case 'chunk':
        break;
    }
  }
}
