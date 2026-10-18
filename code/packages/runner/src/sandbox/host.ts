import { METHOD_PATTERN, REFUSED_METHODS } from '../model.js';
import {
  addHeader,
  addQuery,
  brunoBody,
  formFields,
  headersObject,
  headerValue,
  postmanBody,
  queryJson,
  queryString,
  removeHeader,
  removeQuery,
  setBodyText,
  setBrunoBody,
  upsertHeader,
} from './request-edit.js';
import type { ConsoleLevel, ConsoleLine, ScriptInput, TestResult } from './types.js';

/**
 * The host side of the sandbox: the operations the prelude
 * calls with JSON-serialized arguments, and what a run records. Every value
 * that crosses into the context is plain JSON; nothing here hands the
 * context a host object.
 */

/** At most 1 000 console lines of at most 4 KiB each. */
export const MAX_CONSOLE_LINES = 1000;
export const MAX_CONSOLE_LINE_BYTES = 4096;

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error'];

const REFUSED_AFTER = 'the request cannot be changed in an after script: it has already been sent';

/** A call the sandbox does not support, with the script line when known. */
export interface UnsupportedCall {
  readonly name: string;
  readonly line?: number;
}

interface RecordedTest {
  readonly name: string;
  passed: boolean | null;
  message?: string;
  /** Recorded through the `tests` object, so a later write of the same name replaces it. */
  readonly fromTestsObject: boolean;
}

/** The first `script.js:<line>` in a QuickJS stack. */
export function scriptLine(stack: unknown): number | undefined {
  if (typeof stack !== 'string') return undefined;
  const match = /\bscript\.js:(\d+)/.exec(stack);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) return text.slice(0, end);
    bytes += size;
    end += char.length;
  }
  return text;
}

function text(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${what} must be a string`);
}

function name(value: unknown, what: string): string {
  const result = text(value, what);
  if (result === '') throw new TypeError(`${what} must not be empty`);
  return result;
}

/** A header from Postman's `{ key, value }`, `{ name, value }` or `"Name: value"`. */
function headerArg(value: unknown): { name: string; value: string } {
  if (typeof value === 'string') {
    const colon = value.indexOf(':');
    if (colon <= 0) throw new TypeError('a header string must look like "Name: value"');
    return { name: value.slice(0, colon).trim(), value: value.slice(colon + 1).trim() };
  }
  if (typeof value === 'object' && value !== null) {
    const header = value as { key?: unknown; name?: unknown; value?: unknown };
    return {
      name: name(header.key ?? header.name, 'a header name'),
      value: header.value === undefined || header.value === null ? '' : text(header.value, 'a header value'),
    };
  }
  throw new TypeError('a header must be an object with a key and a value');
}

export class ScriptHost {
  readonly #input: ScriptInput;
  readonly #tests: RecordedTest[] = [];
  readonly #console: ConsoleLine[] = [];
  #unsupported: UnsupportedCall | null = null;
  #responseJson: { readonly parsed: boolean; readonly value?: unknown } | undefined;

  constructor(input: ScriptInput) {
    this.#input = input;
  }

  /** The first unsupported call the script made, even if it caught the error. */
  get unsupported(): UnsupportedCall | null {
    return this.#unsupported;
  }

  get console(): readonly ConsoleLine[] {
    return this.#console;
  }

  recordUnsupported(call: string, line?: number): void {
    this.#unsupported ??= line === undefined ? { name: call } : { name: call, line };
  }

  /** The tests in the order they started; one still pending failed with `unfinished`. */
  tests(unfinished: string): TestResult[] {
    return this.#tests.map((test) =>
      test.passed === null
        ? { name: test.name, passed: false, message: unfinished }
        : test.message === undefined
          ? { name: test.name, passed: test.passed }
          : { name: test.name, passed: test.passed, message: test.message },
    );
  }

  /** Runs one operation; a thrown error becomes an error thrown in the script. */
  call(op: string, args: readonly unknown[]): unknown {
    const { request, variables, info } = this.#input;
    const arg = (index: number): unknown => args[index];
    switch (op) {
      case 'info':
        return { requestName: info.requestName, requestId: info.requestId };
      case 'unsupported': {
        const call = text(arg(0), 'the call');
        this.recordUnsupported(call, scriptLine(arg(1)));
        throw new Error(`${call} is not supported in Janus scripts`);
      }
      case 'console':
        return this.#log(arg(0), arg(1));
      case 'test.begin':
        this.#tests.push({ name: text(arg(0), 'a test name'), passed: null, fromTestsObject: false });
        return this.#tests.length - 1;
      case 'test.end': {
        const test = typeof arg(0) === 'number' ? this.#tests[arg(0) as number] : undefined;
        if (test === undefined || test.passed !== null) return undefined;
        test.passed = arg(1) === true;
        if (!test.passed) test.message = typeof arg(2) === 'string' ? (arg(2) as string) : 'the test failed';
        return undefined;
      }
      case 'tests.set': {
        const testName = text(arg(0), 'a test name');
        const passed = arg(1) === true;
        const at = this.#tests.findIndex((test) => test.fromTestsObject && test.name === testName);
        const test: RecordedTest = { name: testName, passed, fromTestsObject: true };
        if (at < 0) this.#tests.push(test);
        else this.#tests[at] = test;
        return undefined;
      }

      case 'var.get':
        return variables.get(name(arg(0), 'a variable name'));
      case 'var.set':
        variables.set(name(arg(0), 'a variable name'), arg(1) ?? null);
        return undefined;
      case 'var.unset':
        variables.unset(name(arg(0), 'a variable name'));
        return undefined;
      case 'var.has':
        return variables.has(name(arg(0), 'a variable name'));
      case 'var.scope': {
        const scope = arg(0);
        if (scope !== 'request' && scope !== 'folder' && scope !== 'collection' && scope !== 'environment') {
          throw new TypeError('unknown variable scope');
        }
        return variables.scope(scope, name(arg(1), 'a variable name'));
      }
      case 'var.interpolate':
        return variables.interpolate(arg(0) === undefined || arg(0) === null ? '' : text(arg(0), 'the text'));
      case 'env.name':
        return variables.environmentName;

      case 'req.get':
        return {
          method: request.method,
          url: request.url,
          headers: request.headers.map((header) => ({ name: header.name, value: header.value })),
          body: request.body,
        };
      case 'req.queryString':
        return queryString(request.url);
      case 'req.header':
        return headerValue(request.headers, text(arg(0), 'a header name'));
      case 'req.headersObject':
        return headersObject(request.headers);
      case 'req.postmanBody':
        return postmanBody(request.body);
      case 'req.brunoBody':
        return brunoBody(request.body);

      case 'res.get': {
        const response = this.#response();
        return {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          text: response.text,
          timeMs: response.timeMs,
        };
      }
      case 'res.query': {
        const json = this.#json();
        if (!json.parsed) return { found: false };
        return queryJson(json.value, arg(0) === undefined || arg(0) === null ? '' : text(arg(0), 'the path'));
      }

      default:
        this.#change(op, args);
        return undefined;
    }
  }

  /** Request changes: `before` scripts only. */
  #change(op: string, args: readonly unknown[]): void {
    const { request, phase } = this.#input;
    const arg = (index: number): unknown => args[index];
    const isChange = op.startsWith('req.');
    if (!isChange) throw new Error(`unknown sandbox operation ${op}`);
    if (phase === 'after') throw new Error(REFUSED_AFTER);
    switch (op) {
      case 'req.setMethod': {
        const method = name(arg(0), 'the method').trim().toUpperCase();
        if (!METHOD_PATTERN.test(method)) throw new TypeError(`${method} is not an HTTP method`);
        if (REFUSED_METHODS.has(method)) throw new TypeError(`a request cannot use ${method}`);
        request.method = method;
        return;
      }
      case 'req.setUrl':
        request.url = text(arg(0), 'the URL');
        return;
      case 'req.addQuery': {
        const param = arg(0);
        if (typeof param === 'string') {
          request.url = addQuery(request.url, param, null);
          return;
        }
        if (typeof param !== 'object' || param === null) throw new TypeError('a query parameter must have a key');
        const { key, value } = param as { key?: unknown; value?: unknown };
        request.url = addQuery(
          request.url,
          name(key, 'a query parameter key'),
          value === undefined || value === null ? null : text(value, 'a query parameter value'),
        );
        return;
      }
      case 'req.removeQuery': {
        const param = arg(0);
        const key = typeof param === 'object' && param !== null ? (param as { key?: unknown }).key : param;
        request.url = removeQuery(request.url, name(key, 'a query parameter key'));
        return;
      }
      case 'req.addHeader': {
        const header = headerArg(arg(0));
        request.headers = addHeader(request.headers, header.name, header.value);
        return;
      }
      case 'req.upsertHeader': {
        const header = headerArg(arg(0));
        request.headers = upsertHeader(request.headers, header.name, header.value);
        return;
      }
      case 'req.setHeader':
        request.headers = upsertHeader(
          request.headers,
          name(arg(0), 'a header name'),
          arg(1) === undefined || arg(1) === null ? '' : text(arg(1), 'a header value'),
        );
        return;
      case 'req.removeHeader':
        request.headers = removeHeader(request.headers, name(arg(0), 'a header name'));
        return;
      case 'req.setHeaders': {
        const headers = arg(0);
        if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
          throw new TypeError('headers must be an object of names and values');
        }
        request.headers = Object.entries(headers).map(([key, value]) => ({
          name: name(key, 'a header name'),
          value: value === null ? '' : text(value, 'a header value'),
        }));
        return;
      }
      case 'req.updateBody': {
        const update = arg(0);
        if (typeof update === 'string') {
          request.body = setBodyText(request.body, update);
          return;
        }
        const { mode, raw, urlencoded } = (update ?? {}) as { mode?: unknown; raw?: unknown; urlencoded?: unknown };
        if (mode === 'raw') request.body = setBodyText(request.body, raw === undefined ? '' : text(raw, 'raw'));
        else if (mode === 'urlencoded' && Array.isArray(urlencoded)) {
          request.body = { type: 'form', fields: formFields(urlencoded) };
        } else
          throw new TypeError('body.update takes text, { mode: "raw", raw } or { mode: "urlencoded", urlencoded }');
        return;
      }
      case 'req.setBody':
        request.body = setBrunoBody(request.body, arg(0));
        return;
      default:
        throw new Error(`unknown sandbox operation ${op}`);
    }
  }

  #log(level: unknown, line: unknown): boolean {
    if (this.#console.length >= MAX_CONSOLE_LINES) return false;
    const consoleLevel = CONSOLE_LEVELS.find((candidate) => candidate === level) ?? 'log';
    this.#console.push({
      level: consoleLevel,
      text: truncateUtf8(typeof line === 'string' ? line : String(line), MAX_CONSOLE_LINE_BYTES),
    });
    return this.#console.length < MAX_CONSOLE_LINES;
  }

  #response(): NonNullable<ScriptInput['response']> {
    const response = this.#input.response;
    if (this.#input.phase === 'before' || response === undefined) {
      throw new Error('the response is not available in a before script');
    }
    return response;
  }

  #json(): { readonly parsed: boolean; readonly value?: unknown } {
    if (this.#responseJson === undefined) {
      try {
        this.#responseJson = { parsed: true, value: JSON.parse(this.#response().text) as unknown };
      } catch {
        this.#responseJson = { parsed: false };
      }
    }
    return this.#responseJson;
  }
}
