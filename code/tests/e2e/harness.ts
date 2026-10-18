import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/** The workspace root (`code/`). */
export const WORKSPACE = resolve(import.meta.dirname, '../..');
const BIN = join(WORKSPACE, 'apps/server/src/bin.ts');
const UI_DIST = join(WORKSPACE, 'apps/ui/dist');

export interface Janus {
  readonly url: string;
  readonly port: number;
  readonly output: { stdout: string; stderr: string };
  stop(): Promise<void>;
}

/** Starts `janus serve` from source, as the acceptance test does. */
export async function startJanus(data: string, port = 0): Promise<Janus> {
  return startJanusWith(['--data', data, '--host', '127.0.0.1', '--port', String(port)]);
}

/** Starts `janus serve <args>` from source in the workspace directory. */
export async function startJanusWith(args: readonly string[]): Promise<Janus> {
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@janus/source', BIN, 'serve', ...args],
    { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = { stdout: '', stderr: '' };
  proc.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  proc.stderr.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
  const exited = new Promise<void>((done) =>
    proc.once('exit', () => {
      done();
    }),
  );

  for (let i = 0; i < 400; i++) {
    const url = /listening on (\S+)/.exec(output.stdout)?.[1];
    if (url !== undefined) {
      return {
        url,
        port: Number(new URL(url).port),
        output,
        stop: async () => {
          if (proc.exitCode === null) proc.kill('SIGTERM');
          await exited;
        },
      };
    }
    if (proc.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  proc.kill('SIGKILL');
  throw new Error(`janus did not start:\n${output.stdout}\n${output.stderr}`);
}

export interface Proxy {
  readonly url: string;
  /** Every Atlas response body the proxy relayed. */
  readonly atlasBodies: string[];
  close(): Promise<void>;
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * The documented deployment: one origin serves the built UI at
 * `/ui/` and forwards `/mock/_janus/` to Janus, which is mounted below a path
 * and sends no CORS headers. The UI's `serverUrl` is the relative `/mock`.
 */
export async function startProxy(janusPort: () => number): Promise<Proxy> {
  const atlasBodies: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy');
    if (url.pathname.startsWith('/mock/_janus/')) {
      forward(req, res, janusPort(), req.url?.slice('/mock'.length) ?? '/', atlasBodies);
    } else if (url.pathname === '/ui/atlas-config.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      res.end("globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: '/mock' };\n");
    } else if (url.pathname.startsWith('/ui/')) {
      void serveStatic(res, url.pathname.slice('/ui/'.length) || 'index.html');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    atlasBodies,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

function forward(req: IncomingMessage, res: ServerResponse, port: number, path: string, bodies: string[]): void {
  const upstream = request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path,
      // Host passes through unchanged, as the documented proxies do:
      // Janus compares it with Origin before a reload or resolve.
      headers: req.headers,
    },
    (answer) => {
      // Server-sent events are relayed as they arrive, unbuffered, as a real proxy must.
      if (answer.headers['content-type']?.startsWith('text/event-stream') === true) {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        res.flushHeaders();
        answer.pipe(res);
        res.on('close', () => {
          answer.destroy();
        });
        return;
      }
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        const body = Buffer.concat(chunks);
        bodies.push(body.toString('utf8'));
        res.writeHead(answer.statusCode ?? 502, answer.headers).end(body);
      });
    },
  );
  upstream.on('error', () => {
    // Janus is down: a proxy error page that is deliberately not JSON.
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html' }).end('<h1>502 Bad Gateway</h1>');
  });
  req.pipe(upstream);
}

async function serveStatic(res: ServerResponse, relative: string): Promise<void> {
  const file = normalize(join(UI_DIST, relative));
  if (!file.startsWith(UI_DIST + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}

export interface StaticSite {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A second origin serving the built UI at its root with its own
 * `atlas-config.js` (journey 7): the shared static host of the
 * cross-origin deployment. `serverUrl` is read per request, so it can name a
 * server started later. Listens on `port`, or a free one.
 */
export async function startStaticSite(serverUrl: () => string, port = 0): Promise<StaticSite> {
  const server: Server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://static');
    if (pathname === '/atlas-config.js') {
      const config = `globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: ${JSON.stringify(serverUrl())} };\n`;
      res.writeHead(200, { 'content-type': TYPES['.js'] }).end(config);
    } else {
      void serveStatic(res, pathname.slice(1) || 'index.html');
    }
  });
  return listen(server, port);
}

/**
 * A reverse proxy that mounts all of Janus at `/mock/`, strips the prefix and
 * passes `Host` through (journey 9). Anything else is a 404.
 */
export async function startMountProxy(janusPort: () => number): Promise<StaticSite> {
  const server: Server = createServer((req, res) => {
    const target = req.url ?? '/';
    if (target.startsWith('/mock/')) {
      forward(req, res, janusPort(), target.slice('/mock'.length), []);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return listen(server, 0);
}

async function listen(server: Server, port: number): Promise<StaticSite> {
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}
