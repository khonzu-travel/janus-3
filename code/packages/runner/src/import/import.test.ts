import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { checkFakerPath } from '../../../core/src/dynamic/random.js';
import type { RequestDocument } from '../model.js';
import { isRunnerName, isVariableName } from '../model.js';
import { FAKER_TABLE, detectFormat, importSources, type ImportResult, type ImportSource } from './index.js';
import { extractToken } from './bruno.js';
import { unsupportedCalls } from './scripts.js';
import { pathParamNames } from './url.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const MAX = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function source(path: string, name: string = path.split('/').pop() ?? path): ImportSource {
  return { name, bytes: new Uint8Array(readFileSync(join(FIXTURES, path))) };
}

/** Every file below a fixture folder, named by its path below it, as a folder import sends them. */
function folder(path: string): ImportSource[] {
  const root = join(FIXTURES, path);
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
  return walk(root).map((full) => ({ name: relative(root, full), bytes: new Uint8Array(readFileSync(full)) }));
}

/** A stand-in for the sandbox's compiler: reports unbalanced brackets, as a syntax error would. */
const syntaxCheck = (script: string): { message: string; line: number; column: number } | null => {
  let depth = 0;
  for (const char of script.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '')) {
    if ('({['.includes(char)) depth++;
    if (')}]'.includes(char)) depth--;
  }
  return depth === 0 ? null : { message: 'Unexpected end of input', line: 1, column: 1 };
};

/** The error of a failed result. */
function failure(out: ImportResult): { code: string; message: string } {
  if (out.ok) throw new Error('expected the import to fail');
  return out;
}

/** A stable text form of a result: each file as YAML, then the report. */
function render(result: ImportResult): string {
  if (!result.ok) return `${result.code}: ${result.message}\n`;
  const parts = [`# format: ${result.format}\n# collection: ${result.collection} (${result.name})\n`];
  for (const file of result.files) {
    parts.push(
      `--- ${file.path} (${file.kind})\n` +
        (file.kind === 'body' ? `<${String(file.bytes.length)} bytes>\n` : stringify(file.document, { lineWidth: 0 })),
    );
  }
  parts.push(`--- report\n${stringify(result.report, { lineWidth: 0 })}`);
  if (result.origins !== undefined) parts.push(`--- origins\n${stringify(result.origins, { lineWidth: 0 })}`);
  if (result.transactions !== undefined) {
    parts.push(`--- transactions\n${stringify(result.transactions, { lineWidth: 0 })}`);
  }
  return parts.join('\n');
}

/** The rules every produced request must keep. */
function expectValidRequests(result: ImportResult): void {
  if (!result.ok) throw new Error(result.message);
  const allowed = new Set([
    'name',
    'method',
    'url',
    'pathParams',
    'headers',
    'body',
    'vars',
    'extract',
    'scripts',
    'route',
    'docs',
    'source',
  ]);
  for (const file of result.files) {
    const parts = file.path.split('/');
    const last = parts.pop() ?? '';
    const stem = last.replace(/(\.request\.yaml|\.local\.yaml|\.yaml|\.body\.bin)$/, '');
    expect(parts.length, file.path).toBeLessThanOrEqual(8);
    for (const part of [...parts, ...(last === 'folder.yaml' ? [] : [stem])])
      expect(isRunnerName(part), file.path).toBe(true);
    if (file.kind !== 'request') continue;
    const doc: RequestDocument = file.document;
    for (const key of Object.keys(doc)) expect(allowed.has(key), `${file.path}: ${key}`).toBe(true);
    expect(doc.method).toMatch(/^[A-Z]+$/);
    expect(doc.url, file.path).toMatch(/^(\{\{|https?:\/\/)/);
    expect(Object.keys(doc.pathParams ?? {}).sort()).toEqual(pathParamNames(doc.url).sort());
    expect(doc.source).toBeDefined();
  }
}

function result(
  sources: readonly ImportSource[],
  options: Partial<Parameters<typeof importSources>[1]> = {},
): ImportResult {
  return importSources(sources, { maxBytes: MAX, ...options }, syntaxCheck);
}

function okResult(sources: readonly ImportSource[], options: Partial<Parameters<typeof importSources>[1]> = {}) {
  const out = result(sources, options);
  if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
  return out;
}

function requestAt(out: Extract<ImportResult, { ok: true }>, path: string): RequestDocument {
  const file = out.files.find((candidate) => candidate.path === path);
  if (file?.kind !== 'request') throw new Error(`no request at ${path}: ${out.files.map((f) => f.path).join(', ')}`);
  return file.document;
}

describe('Postman', () => {
  const v21 = [
    source('postman/checkout-v21.postman_collection.json'),
    source('postman/staging.postman_environment.json'),
    source('postman/globals.postman_globals.json'),
  ];
  const v20 = [source('postman/users-v20.postman_collection.json'), source('postman/users.postman_environment.json')];

  it('converts a v2.1 collection with environments', async () => {
    const out = result(v21);
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/postman-v21.txt');
  });

  it('converts a v2.0 collection with an environment', async () => {
    const out = result(v20);
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/postman-v20.txt');
  });
});

/** The .bru collection; its `.env` is added here because the repository ignores `.env` files. */
function brunoSources(): ImportSource[] {
  return [{ name: '.env', bytes: encoder.encode('API_KEY=local-key\n') }, ...folder('bruno/shop-api')];
}

describe('Bruno .bru', () => {
  it('converts a collection folder', async () => {
    const out = result(brunoSources());
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/bruno.txt');
  });

  it('converts the same collection from a zip with a top-level folder', () => {
    const zippable: Zippable = {};
    for (const file of brunoSources()) zippable[`shop-api/${file.name}`] = file.bytes;
    const zipped = importSources([{ name: 'shop-api.zip', bytes: zipSync(zippable) }], { maxBytes: MAX }, syntaxCheck);
    const plain = result(brunoSources());
    expect(render(zipped)).toBe(render(plain));
  });
});

describe('Bruno YAML', () => {
  it('converts an OpenCollection folder', async () => {
    const out = result(folder('bruno-yaml/shop-api'));
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/bruno-yaml.txt');
  });
});

describe('Charles', () => {
  const session = [source('charles/shop-session.chlsj')];

  it('converts a JSON session', async () => {
    const out = result(session);
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/charles.txt');
  });
});

describe('HAR', () => {
  it('converts a Chrome export', async () => {
    const out = result([source('har/chrome.har')]);
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/har-chrome.txt');
  });

  it('converts a Firefox export', async () => {
    const out = result([source('har/firefox.har')]);
    expectValidRequests(out);
    await expect(render(out)).toMatchFileSnapshot('fixtures/expected/har-firefox.txt');
  });
});

describe('Charles and HAR filters', () => {
  const session = [source('charles/shop-session.chlsj')];

  it('keeps static assets when asked', () => {
    const out = okResult(session, { includeStatic: true });
    const paths = out.files.map((file) => file.path);
    expect(paths).toContain('020-cdn-example-com/010-get-app-js.request.yaml');
    expect(paths).toContain('020-cdn-example-com/020-get-logo-png.request.yaml');
    expect(out.transactions?.filter((tx) => tx.static && tx.included)).toHaveLength(2);
  });

  it('imports only the selected origins and positions', () => {
    const byOrigin = okResult(session, { origins: ['http://localhost:8080'] });
    expect(byOrigin.files.filter((file) => file.kind === 'request').map((file) => file.path)).toEqual([
      '010-localhost-8080/010-post-upload.request.yaml',
    ]);
    const environment = byOrigin.files.find((file) => file.path === 'environments/imported.yaml');
    expect(environment?.kind === 'environment' && environment.document.vars).toEqual({
      localhost8080BaseUrl: 'http://localhost:8080',
    });
    // Variables do not depend on the filters, so a preview and the import agree.
    expect(byOrigin.origins?.map((origin) => origin.variable)).toEqual([
      'apiExampleComBaseUrl',
      'cdnExampleComBaseUrl',
      'localhost8080BaseUrl',
      'apiExampleCom2BaseUrl',
    ]);
    const byPosition = okResult(session, { positions: [2, 9] });
    expect(byPosition.transactions?.filter((tx) => tx.included).map((tx) => tx.position)).toEqual([2, 9]);
    expect(byPosition.report.find((item) => item.location === '[0]')?.notes).toEqual([
      'not imported: its position is not among the selected transactions',
    ]);
  });

  it('names a request <position>-<method>-<last path segment> and writes URLs against the origin variable', () => {
    const out = okResult(session);
    expect(requestAt(out, '010-api-example-com/030-get-c-91.request.yaml').url).toBe(
      '{{apiExampleComBaseUrl}}/v1/carts/c-91',
    );
  });
});

describe('refused and invalid sources', () => {
  it('refuses Charles binary and XML sessions, naming the JSON export', () => {
    const binary = result([
      { name: 'session.chls', bytes: new Uint8Array([0xac, 0xed, 0x00, 0x05, 0x73, 0x72, 0xff]) },
    ]);
    const xml = result([
      {
        name: 'session.chlsx',
        bytes: encoder.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<?charles serialisation-version=\'2.0\' ?>\n<charles-session><transaction/></charles-session>',
        ),
      },
    ]);
    for (const out of [binary, xml]) {
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.code).toBe('import-unsupported-format');
      expect(out.message).toContain('File › Export Session… › JSON Session File (.chlsj)');
    }
  });

  it('refuses unrecognised content whatever its extension', () => {
    const out = result([{ name: 'collection.json', bytes: encoder.encode('{"hello":"world"}') }]);
    expect(failure(out).code).toBe('import-unsupported-format');
    const har = result([{ name: 'capture.har', bytes: encoder.encode('not json') }]);
    expect(failure(har).code).toBe('import-unsupported-format');
    const v1 = result([
      { name: 'old.json', bytes: encoder.encode('{"id":"x","name":"Old","order":[],"requests":[]}') },
    ]);
    expect(failure(v1).message).toContain('v2.1');
    const envOnly = result([source('postman/staging.postman_environment.json')]);
    expect(failure(envOnly).message).toContain('collection');
  });

  it('detects formats from content', () => {
    expect(detectFormat([source('postman/users-v20.postman_collection.json', 'export.txt')])).toBe('postman');
    expect(detectFormat(folder('bruno/shop-api'))).toBe('bruno');
    expect(detectFormat(folder('bruno-yaml/shop-api'))).toBe('bruno-yaml');
    expect(detectFormat([source('charles/shop-session.chlsj', 'session.json')])).toBe('charles');
    expect(detectFormat([source('har/chrome.har', 'capture.json')])).toBe('har');
    expect(detectFormat([{ name: 'a.txt', bytes: encoder.encode('hello') }])).toBeNull();
  });

  it('bounds the input size', () => {
    const out = importSources(folder('bruno/shop-api'), { maxBytes: 100 });
    expect(failure(out).code).toBe('import-too-large');
  });

  it('checks the destination name', () => {
    expect(okResult([source('har/chrome.har')], { into: 'web-session' }).collection).toBe('web-session');
    const out = result([source('har/chrome.har')], { into: 'Web Session' });
    expect(failure(out).code).toBe('import-invalid');
    // The shared environments directory is never a collection.
    const reserved = result([source('har/chrome.har')], { into: 'environments' });
    expect(failure(reserved).message).toContain('shared environments');
  });

  it('writes environments as shared ones, below the requests root', () => {
    const out = okResult([
      source('postman/checkout-v21.postman_collection.json'),
      source('postman/staging.postman_environment.json'),
    ]);
    const environments = out.files.filter((file) => file.kind === 'environment').map((file) => file.path);
    expect(environments.length).toBeGreaterThan(0);
    for (const path of environments) expect(path).toMatch(/^environments\/[a-z0-9-]+(\.local)?\.yaml$/);
  });
});

describe('zip limits', () => {
  const zip = (files: Zippable): ImportSource => ({ name: 'collection.zip', bytes: zipSync(files) });
  const bruno = encoder.encode('{"version":"1","name":"Z","type":"collection"}');

  it('expands a valid zip', () => {
    expect(okResult([zip({ 'bruno.json': bruno, '__MACOSX/._bruno.json': new Uint8Array(4) })]).name).toBe('Z');
  });

  it('refuses more than 10 000 entries', () => {
    const files: Zippable = { 'bruno.json': bruno };
    for (let i = 0; i < 10_000; i++) files[`f/${String(i)}.txt`] = new Uint8Array(0);
    const out = result([zip(files)]);
    expect(failure(out).code).toBe('import-too-large');
    expect(failure(out).message).toContain('10001 entries');
  });

  it('refuses archives that expand beyond four times the limit', () => {
    const big = zip({ 'bruno.json': bruno, 'big.bru': new Uint8Array(100_000) });
    expect(big.bytes.length).toBeLessThan(2_000);
    const out = importSources([big], { maxBytes: 20_000 });
    expect(failure(out).code).toBe('import-too-large');
    expect(failure(out).message).toContain('80000 bytes');
  });

  it.each(['../evil.bru', '/etc/passwd', 'a\\..\\b.bru', 'C:/x.bru', 'a/../../b.bru'])(
    'refuses the entry name %s',
    (name) => {
      const out = result([zip({ 'bruno.json': bruno, [name]: encoder.encode('x') })]);
      expect(failure(out).code).toBe('import-invalid');
      expect(failure(out).message).toContain(name);
    },
  );

  it('refuses symbolic links', () => {
    const link: Zippable = {
      'bruno.json': bruno,
      'linked.bru': [encoder.encode('/etc/passwd'), { os: 3, attrs: 0o120777 << 16 }],
    };
    const out = result([zip(link)]);
    expect(failure(out).code).toBe('import-invalid');
    expect(failure(out).message).toContain('symbolic link');
  });

  it('refuses a zip mixed with other sources and a damaged zip', () => {
    const mixed = result([zip({ 'bruno.json': bruno }), source('har/chrome.har')]);
    expect(failure(mixed).code).toBe('import-invalid');
    const damaged = result([{ name: 'x.zip', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) }]);
    expect(failure(damaged).code).toBe('import-invalid');
  });
});

describe('names and structure', () => {
  const collection = (items: unknown[], name = 'Deep'): ImportSource => ({
    name: 'c.json',
    bytes: encoder.encode(
      JSON.stringify({
        info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: items,
      }),
    ),
  });
  const request = (name: string): unknown => ({ name, request: { method: 'GET', url: 'https://x.example/a' } });

  it('flattens folders deeper than 8 into the deepest allowed folder', () => {
    let items: unknown[] = [request('Leaf')];
    for (let depth = 10; depth >= 1; depth--) items = [{ name: `Level ${String(depth)}`, item: items }];
    const out = okResult([collection(items)]);
    expectValidRequests(out);
    const leaf = out.files.find((file) => file.kind === 'request');
    expect(leaf?.path).toBe(
      '010-level-1/010-level-2/010-level-3/010-level-4/010-level-5/010-level-6/010-level-7/010-level-8/010-leaf.request.yaml',
    );
    const report = out.report.find((item) => item.name === 'Leaf');
    expect(report?.notes).toEqual([
      'folder "Level 9 / Level 10" is deeper than 8 levels; the request was moved into "Level 8"',
    ]);
    expect(out.report.find((item) => item.name === 'Level 9')?.notes[0]).toContain('deeper than 8 levels');
  });

  it('makes names unique with a numeric suffix and keeps them within 64 bytes', () => {
    const long = 'A very long request name that goes on and on and on beyond sixty four bytes';
    const out = okResult([
      collection(
        [request('Get user'), request('Get user!'), request('Get   USER'), request(long), request('☃')],
        'Ünïcode Collection',
      ),
    ]);
    expect(out.collection).toBe('unicode-collection');
    expect(out.files.filter((file) => file.kind === 'request').map((file) => file.path)).toEqual([
      '010-get-user.request.yaml',
      '020-get-user-2.request.yaml',
      '030-get-user-3.request.yaml',
      '040-a-very-long-request-name-that-goes-on-and-on-and-on-beyond-s.request.yaml',
      '050-request.request.yaml',
    ]);
    expect(requestAt(out, '020-get-user-2.request.yaml').name).toBe('Get user!');
  });

  it('widens position prefixes past 99 entries so name order stays source order', () => {
    const items = Array.from({ length: 120 }, (_, index) => request(`R${String(index)}`));
    const out = okResult([collection(items)]);
    const names = out.files.filter((file) => file.kind === 'request').map((file) => file.path);
    expect(names[0]).toBe('0010-r0.request.yaml');
    expect(names[119]).toBe('1200-r119.request.yaml');
    expect([...names].sort()).toEqual(names);
  });

  it('notes scripts that do not compile, without dropping the request', () => {
    const out = okResult([
      collection([
        {
          name: 'Bad',
          event: [{ listen: 'test', script: { exec: ['pm.test("x", function () {'] } }],
          request: { method: 'GET', url: 'https://x.example/a' },
        },
      ]),
    ]);
    const item = out.report.find((entry) => entry.name === 'Bad');
    expect(item?.outcome).toBe('converted-with-notes');
    expect(item?.notes[0]).toMatch(/^the test script does not compile: .* \(line 1, column 1\)$/);
  });
});

describe('templates and dynamic variables', () => {
  it('maps every faker table entry to a generator core accepts', () => {
    for (const [name, path] of Object.entries(FAKER_TABLE)) {
      const [module = '', method = ''] = path.split('.');
      expect(checkFakerPath(module, method), `${name} → faker.${path}`).toBeNull();
    }
  });

  it('keeps variable names of the grammar and Postman spellings', () => {
    expect(isVariableName('api.key')).toBe(true);
    const out = okResult([
      {
        name: 'c.json',
        bytes: encoder.encode(
          JSON.stringify({
            info: { name: 'T', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
            item: [
              {
                name: 'T',
                request: {
                  method: 'POST',
                  url: 'https://x.example/{{api.key}}',
                  body: { mode: 'raw', raw: '{{ token }} {{$randomUUID}} {{$unknownThing}} {{1abc}} {{$ unterminated' },
                },
              },
            ],
          }),
        ),
      },
    ]);
    const doc = requestAt(out, '010-t.request.yaml');
    expect(doc.url).toBe('https://x.example/{{api.key}}');
    expect(doc.body).toEqual({
      type: 'text',
      text: '{{ token }} {{$uuid}} {{$$unknownThing}} {{_1abc}} {{$$ unterminated',
    });
  });
});

describe('script and extract helpers', () => {
  it('turns plain response paths into extract tokens and leaves the rest to scripts', () => {
    expect(extractToken('res.body')).toBe('{{$response.body.$}}');
    expect(extractToken('res.body.a.b[0].c')).toBe('{{$response.body.$.a.b[0].c}}');
    expect(extractToken('res.body["a b"]')).toBe("{{$response.body.$['a b']}}");
    expect(extractToken("res('data.items[2].id')")).toBe('{{$response.body.$.data.items[2].id}}');
    expect(extractToken('res("..items[?(@.qty > 1)]")')).toBeNull();
    expect(extractToken('res.headers.etag')).toBeNull();
    expect(extractToken('res.body.id.toUpperCase()')).toBeNull();
  });

  it('finds every call that scripts cannot make', () => {
    const script = [
      'pm.sendRequest(x);',
      'bru.sendRequest(x); bru.runRequest("a");',
      'postman.setNextRequest(null); pm.execution.setNextRequest(null); bru.setNextRequest(null);',
      'pm.visualizer.set(t); pm.cookies.jar();',
      "const m = require('moment'); import('x');",
    ].join('\n');
    expect(unsupportedCalls(script)).toEqual([
      'pm.sendRequest',
      'bru.sendRequest',
      'bru.runRequest',
      'postman.setNextRequest',
      'pm.execution.setNextRequest',
      'bru.setNextRequest',
      'pm.visualizer',
      'pm.cookies.jar',
      'require',
      'dynamic import',
    ]);
    expect(unsupportedCalls('pm.test("ok", () => expect(pm.response.code).to.equal(200)); obj.require(1);')).toEqual(
      [],
    );
  });
});
