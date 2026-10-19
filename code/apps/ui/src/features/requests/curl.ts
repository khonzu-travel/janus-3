import type { MultipartPart, NameValue, RequestBody, RequestDocument } from '../../atlas/runner.js';

/**
 * Reads a curl command, as browsers and API tools copy it, into a request.
 * Bash quoting (what "Copy as cURL" gives on macOS and Linux, and in
 * Chrome's "(bash)" choice) and Windows cmd quoting (Chrome's "(cmd)"
 * choice, with `^` escapes) are understood. Options that change only what
 * curl prints or how it waits are dropped; any other option the request
 * cannot hold is named in `notes`.
 */

export type CurlRequest = Pick<RequestDocument, 'method' | 'url' | 'headers' | 'body'>;

export type CurlResult =
  | { readonly ok: true; readonly request: CurlRequest; readonly notes: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** True when the text starts with a curl command, so a paste can be read as one. */
export function looksLikeCurl(text: string): boolean {
  return /^\s*(\$\s+)?curl(\.exe)?\s/i.test(text);
}

class CurlError extends Error {}

/** Words of a cmd command line: `^` escapes the next character, and a `^` at a line end joins lines. */
function cmdWords(text: string): string[] {
  let plain = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? '';
    if (char !== '^') {
      plain += char;
      continue;
    }
    const next = text[at + 1] ?? '';
    if (next === '\r' && text[at + 2] === '\n') at += 2;
    else if (next === '\n') at += 1;
    else {
      plain += next;
      at += 1;
    }
  }
  // Then the program's own argument rules: quotes group, \" is a quote.
  const words: string[] = [];
  let word: string | null = null;
  let quoted = false;
  for (let at = 0; at < plain.length; at++) {
    const char = plain[at] ?? '';
    if (char === '\\' && plain[at + 1] === '"') {
      word = (word ?? '') + '"';
      at += 1;
    } else if (char === '"') {
      if (quoted && plain[at + 1] === '"') {
        word = (word ?? '') + '"';
        at += 1;
      } else {
        quoted = !quoted;
        word ??= '';
      }
    } else if (!quoted && /\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quoted) throw new CurlError('A quote is not closed');
  if (word !== null) words.push(word);
  return words;
}

const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** The body of a `$'…'` string from `start` (just after the opening quote); returns the text and the index of the closing quote. */
function ansiString(text: string, start: number): [string, number] {
  let out = '';
  for (let at = start; at < text.length; at++) {
    const char = text[at] ?? '';
    if (char === "'") return [out, at];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[at + 1] ?? '';
    const simple = ANSI_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      at += 1;
      continue;
    }
    const hex = /^(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/.exec(text.slice(at + 1));
    if (hex !== null) {
      out += String.fromCodePoint(Number.parseInt(hex[0].slice(1), 16));
      at += hex[0].length;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1));
    if (octal !== null) {
      out += String.fromCharCode(Number.parseInt(octal[0], 8));
      at += octal[0].length;
      continue;
    }
    out += char;
  }
  throw new CurlError('A quote is not closed');
}

/** Words of a bash command line, with its quoting removed. Stops at an unquoted `|`, `;`, `&` or `>`. */
function bashWords(text: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? '';
    if (char === '\\') {
      const next = text[at + 1];
      if (next === '\n') at += 1;
      else if (next === '\r' && text[at + 2] === '\n') at += 2;
      else if (next !== undefined) {
        word = (word ?? '') + next;
        at += 1;
      }
    } else if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) throw new CurlError('A quote is not closed');
      word = (word ?? '') + text.slice(at + 1, end);
      at = end;
    } else if (char === '$' && text[at + 1] === "'") {
      const [value, end] = ansiString(text, at + 2);
      word = (word ?? '') + value;
      at = end;
    } else if (char === '"') {
      let value = '';
      let end = at + 1;
      for (; end < text.length && text[end] !== '"'; end++) {
        const inner = text[end] ?? '';
        const next = text[end + 1] ?? '';
        if (inner === '\\' && next === '\n') end += 1;
        else if (inner === '\\' && '$`"\\'.includes(next)) {
          value += next;
          end += 1;
        } else value += inner;
      }
      if (end >= text.length) throw new CurlError('A quote is not closed');
      word = (word ?? '') + value;
      at = end;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (word === null && '|;&>'.includes(char)) {
      break;
    } else if (word === null && char === '#') {
      const end = text.indexOf('\n', at);
      if (end < 0) break;
      at = end;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** Chrome's "Copy as cURL (cmd)" escapes with `^`; nothing in bash quoting looks like that. */
function isCmd(text: string): boolean {
  return /\^"|\^\r?\n/.test(text);
}

type Kind = 'value' | 'flag';

/** Options read into the request, by long name, with their short letters. */
const READ: Readonly<Record<string, Kind>> = {
  request: 'value',
  url: 'value',
  header: 'value',
  'user-agent': 'value',
  referer: 'value',
  cookie: 'value',
  user: 'value',
  'oauth2-bearer': 'value',
  range: 'value',
  data: 'value',
  'data-ascii': 'value',
  'data-binary': 'value',
  'data-raw': 'value',
  'data-urlencode': 'value',
  json: 'value',
  form: 'value',
  'form-string': 'value',
  'url-query': 'value',
  get: 'flag',
  head: 'flag',
  basic: 'flag',
};

/** Options that change only what curl prints, writes or how long it waits: dropped without a note. */
const QUIET: Readonly<Record<string, Kind>> = {
  silent: 'flag',
  'show-error': 'flag',
  verbose: 'flag',
  include: 'flag',
  'show-headers': 'flag',
  location: 'flag',
  'location-trusted': 'flag',
  compressed: 'flag',
  'progress-bar': 'flag',
  'no-progress-meter': 'flag',
  'no-buffer': 'flag',
  fail: 'flag',
  'fail-with-body': 'flag',
  globoff: 'flag',
  'path-as-is': 'flag',
  raw: 'flag',
  'styled-output': 'flag',
  'trace-time': 'flag',
  'remote-name': 'flag',
  'remote-name-all': 'flag',
  'create-dirs': 'flag',
  'http1.0': 'flag',
  'http1.1': 'flag',
  http2: 'flag',
  'http2-prior-knowledge': 'flag',
  http3: 'flag',
  'http3-only': 'flag',
  ipv4: 'flag',
  ipv6: 'flag',
  'tcp-nodelay': 'flag',
  'no-keepalive': 'flag',
  'no-sessionid': 'flag',
  'no-alpn': 'flag',
  'no-npn': 'flag',
  'tr-encoding': 'flag',
  output: 'value',
  'output-dir': 'value',
  'write-out': 'value',
  'dump-header': 'value',
  trace: 'value',
  'trace-ascii': 'value',
  stderr: 'value',
  'max-time': 'value',
  'connect-timeout': 'value',
  'expect100-timeout': 'value',
  'max-redirs': 'value',
  retry: 'value',
  'retry-delay': 'value',
  'retry-max-time': 'value',
  'limit-rate': 'value',
  'keepalive-time': 'value',
  'cookie-jar': 'value',
  'max-filesize': 'value',
  'speed-limit': 'value',
  'speed-time': 'value',
};

/** Options the request cannot hold, whose value must be skipped too. */
const LEFT_OUT_WITH_VALUE = new Set([
  'cert',
  'cert-type',
  'key',
  'key-type',
  'pass',
  'cacert',
  'capath',
  'crlfile',
  'pinnedpubkey',
  'ciphers',
  'proxy',
  'proxy-user',
  'proxy-header',
  'preproxy',
  'noproxy',
  'socks4',
  'socks4a',
  'socks5',
  'socks5-hostname',
  'upload-file',
  'resolve',
  'connect-to',
  'interface',
  'local-port',
  'dns-servers',
  'unix-socket',
  'abstract-unix-socket',
  'aws-sigv4',
  'time-cond',
  'config',
  'netrc-file',
  'header-file',
  'variable',
  'tls-max',
  'request-target',
  'ech',
  'doh-url',
]);

const SHORT: Readonly<Record<string, string>> = {
  X: 'request',
  H: 'header',
  A: 'user-agent',
  e: 'referer',
  b: 'cookie',
  u: 'user',
  r: 'range',
  d: 'data',
  F: 'form',
  G: 'get',
  I: 'head',
  s: 'silent',
  S: 'show-error',
  v: 'verbose',
  i: 'include',
  L: 'location',
  '#': 'progress-bar',
  N: 'no-buffer',
  f: 'fail',
  g: 'globoff',
  O: 'remote-name',
  '0': 'http1.0',
  '4': 'ipv4',
  '6': 'ipv6',
  o: 'output',
  w: 'write-out',
  D: 'dump-header',
  m: 'max-time',
  c: 'cookie-jar',
  Y: 'speed-limit',
  y: 'speed-time',
  E: 'cert',
  x: 'proxy',
  U: 'proxy-user',
  T: 'upload-file',
  z: 'time-cond',
  K: 'config',
  k: 'insecure',
  n: 'netrc',
  Z: 'parallel',
  q: 'disable',
  j: 'junk-session-cookies',
  R: 'remote-time',
  B: 'use-ascii',
  l: 'list-only',
  a: 'append',
  M: 'manual',
  V: 'version',
  h: 'help',
  C: 'continue-at',
  P: 'ftp-port',
  Q: 'quote',
  t: 'telnet-option',
};

const SHORT_WITH_VALUE = new Set(['C', 'P', 'Q', 't']);

function kindOf(name: string, short: string | null): Kind {
  const known = READ[name] ?? QUIET[name];
  if (known !== undefined) return known;
  if (LEFT_OUT_WITH_VALUE.has(name) || (short !== null && SHORT_WITH_VALUE.has(short))) return 'value';
  return 'flag';
}

/** Percent-encodes as curl's `--data-urlencode` does: everything but unreserved characters. */
function curlEscape(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A form's text as fields, or null when it does not decode as `name=value&…`. */
function formFields(text: string): NameValue[] | null {
  if (text === '' || !text.includes('=')) return null;
  const fields: NameValue[] = [];
  for (const pair of text.split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    if (equals <= 0) return null;
    try {
      const decode = (part: string): string => decodeURIComponent(part.replaceAll('+', ' '));
      fields.push({ name: decode(pair.slice(0, equals)), value: decode(pair.slice(equals + 1)) });
    } catch {
      return null;
    }
  }
  return fields.length === 0 ? null : fields;
}

function isJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function bodyOf(data: string, contentType: string | null, notes: string[]): RequestBody {
  const type = contentType?.toLowerCase() ?? null;
  if (type !== null && /[/+]json\b/.test(type)) return { type: 'json', text: data };
  if (type !== null && /[/+]xml\b/.test(type)) return { type: 'xml', text: data };
  if (type === null || type.startsWith('application/x-www-form-urlencoded')) {
    const fields = formFields(data);
    if (fields !== null) return { type: 'form', fields };
    if (type === null && isJson(data)) {
      notes.push('The data is JSON and is sent as JSON; curl would have labelled it as form data.');
      return { type: 'json', text: data };
    }
  }
  return { type: 'text', text: data };
}

function multipartPart(value: string, literal: boolean, notes: string[]): MultipartPart | null {
  const equals = value.indexOf('=');
  if (equals <= 0) {
    notes.push(`The form part “${value}” has no name, so it was left out.`);
    return null;
  }
  const name = value.slice(0, equals);
  let content = value.slice(equals + 1);
  if (literal) return { name, value: content };
  if (content.startsWith('<')) {
    notes.push(
      `The form part “${name}” reads its value from a file, which the browser cannot open, so it was left out.`,
    );
    return null;
  }
  // `;type=…` and `;filename=…` after the value or file.
  let contentType: string | undefined;
  const typed = /;\s*type=([^;]+)/.exec(content);
  if (typed !== null) contentType = typed[1]?.trim();
  if (content.startsWith('@')) {
    const file = content.slice(1).split(';')[0] ?? '';
    notes.push(`The form part “${name}” sends the file ${file}; check that path before you send.`);
    return { name, file, ...(contentType === undefined ? {} : { contentType }) };
  }
  if (typed !== null) content = content.slice(0, typed.index);
  return { name, value: content };
}

function headerOf(value: string): NameValue | null | 'remove' {
  const colon = value.indexOf(':');
  if (colon < 0) {
    // `Name;` sends the header with no value.
    return value.endsWith(';') ? { name: value.slice(0, -1).trim(), value: '' } : null;
  }
  const name = value.slice(0, colon).trim();
  const rest = value.slice(colon + 1).trim();
  if (name === '') return null;
  // `Name:` with nothing after it only stops curl sending its own header.
  return rest === '' ? 'remove' : { name, value: rest };
}

/** Reads a curl command. */
export function parseCurl(text: string): CurlResult {
  try {
    return read(text);
  } catch (error) {
    if (error instanceof CurlError) return { ok: false, message: error.message };
    throw error;
  }
}

function read(text: string): CurlResult {
  const source = text.trim().replace(/^\$\s+/, '');
  const words = isCmd(source) ? cmdWords(source) : bashWords(source);
  const program = words.shift();
  if (program === undefined || !/(^|[/\\])curl(\.exe)?$/i.test(program)) {
    return { ok: false, message: 'This is not a curl command: it should start with curl' };
  }
  const notes: string[] = [];
  const leftOut: string[] = [];
  const headers: NameValue[] = [];
  const data: string[] = [];
  const queries: string[] = [];
  const parts: MultipartPart[] = [];
  const urls: string[] = [];
  // Set by the options as they are read.
  const seen: { method: string | null; get: boolean; head: boolean; json: boolean } = {
    method: null,
    get: false,
    head: false,
    json: false,
  };

  const addHeader = (name: string, value: string): void => {
    headers.push({ name, value });
  };
  const fromFile = (option: string): void => {
    notes.push(`${option} reads from a file, which the browser cannot open, so it was left out.`);
  };
  const urlencoded = (value: string): string | null => {
    const at = value.indexOf('@');
    const equals = value.indexOf('=');
    if (at >= 0 && (equals < 0 || at < equals)) return null;
    if (equals < 0) return curlEscape(value);
    if (equals === 0) return curlEscape(value.slice(1));
    return `${value.slice(0, equals)}=${curlEscape(value.slice(equals + 1))}`;
  };

  const apply = (name: string, value: string, shown: string): void => {
    switch (name) {
      case 'request':
        seen.method = value;
        return;
      case 'url':
        urls.push(value);
        return;
      case 'header': {
        if (value.startsWith('@')) {
          fromFile(shown);
          return;
        }
        const header = headerOf(value);
        if (header === null) notes.push(`The header “${value}” has no name and value, so it was left out.`);
        else if (header !== 'remove') headers.push(header);
        return;
      }
      case 'user-agent':
        addHeader('User-Agent', value);
        return;
      case 'referer':
        if (value.replace(/;?auto$/, '') !== '') addHeader('Referer', value.replace(/;?auto$/, ''));
        return;
      case 'cookie':
        if (value.includes('=')) addHeader('Cookie', value);
        else fromFile(shown);
        return;
      case 'user':
        addHeader('Authorization', `Basic ${base64Utf8(value.includes(':') ? value : `${value}:`)}`);
        return;
      case 'oauth2-bearer':
        addHeader('Authorization', `Bearer ${value}`);
        return;
      case 'range':
        addHeader('Range', `bytes=${value}`);
        return;
      case 'data':
      case 'data-ascii':
      case 'data-binary':
      case 'json':
        if (value.startsWith('@')) {
          fromFile(shown);
          return;
        }
        if (name === 'json') seen.json = true;
        data.push(value);
        return;
      case 'data-raw':
        data.push(value);
        return;
      case 'data-urlencode': {
        const encoded = urlencoded(value);
        if (encoded === null) fromFile(shown);
        else data.push(encoded);
        return;
      }
      case 'url-query': {
        const encoded = value.startsWith('+') ? value.slice(1) : urlencoded(value);
        if (encoded === null) fromFile(shown);
        else queries.push(encoded);
        return;
      }
      case 'form':
      case 'form-string': {
        const part = multipartPart(value, name === 'form-string', notes);
        if (part !== null) parts.push(part);
        return;
      }
      case 'get':
        seen.get = true;
        return;
      case 'head':
        seen.head = true;
        return;
      case 'basic':
        return;
      case 'insecure':
        notes.push(`${shown} was left out: Janus checks upstream certificates unless runner.skipTlsVerify is on.`);
        return;
      default:
        if (QUIET[name] === undefined) leftOut.push(shown);
    }
  };

  let options = true;
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? '';
    const next = (): string => {
      const value = words[++index];
      if (value === undefined) throw new CurlError(`${word} needs a value`);
      return value;
    };
    if (!options || !word.startsWith('-') || word === '-') {
      urls.push(word);
      continue;
    }
    if (word === '--') {
      options = false;
      continue;
    }
    if (word.startsWith('--')) {
      let name = word.slice(2);
      // `--no-thing` turns a flag off; nothing the request holds is turned off that way.
      if (name.startsWith('no-') && READ[name] === undefined && QUIET[name] === undefined) {
        name = name.slice(3);
        if (kindOf(name, null) === 'flag') {
          if (READ[name] === undefined && QUIET[name] === undefined) leftOut.push(word);
          continue;
        }
      }
      apply(name, kindOf(name, null) === 'value' ? next() : '', `--${name}`);
      continue;
    }
    // Short options, which can be grouped (`-sSL`) and can hold their value (`-XPOST`).
    for (let at = 1; at < word.length; at++) {
      const letter = word[at] ?? '';
      const name = SHORT[letter];
      if (name === undefined) {
        leftOut.push(`-${letter}`);
        continue;
      }
      if (kindOf(name, letter) === 'value') {
        const rest = word.slice(at + 1);
        apply(name, rest === '' ? next() : rest, `-${letter}`);
        break;
      }
      apply(name, '', `-${letter}`);
    }
  }

  const first = urls[0];
  if (first === undefined) return { ok: false, message: 'The command has no URL' };
  if (urls.length > 1) notes.push(`The command names ${String(urls.length)} URLs; only the first was imported.`);
  let url = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `http://${first}`;

  const contentType = headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? null;
  if (seen.json) {
    if (contentType === null) addHeader('Content-Type', 'application/json');
    if (!headers.some((header) => header.name.toLowerCase() === 'accept')) addHeader('Accept', 'application/json');
  }
  const query = [...queries, ...(seen.get ? data : [])];
  if (query.length > 0) url += `${url.includes('?') ? '&' : '?'}${query.join('&')}`;

  let body: RequestBody | undefined;
  if (parts.length > 0) {
    body = { type: 'multipart', parts };
    if (data.length > 0 && !seen.get)
      notes.push('The command has both form parts and data; only the form parts were imported.');
  } else if (data.length > 0 && !seen.get) {
    body = bodyOf(data.join(seen.json ? '' : '&'), contentType ?? (seen.json ? 'application/json' : null), notes);
  }

  const resolved =
    seen.method !== null
      ? seen.method.toUpperCase()
      : seen.head
        ? 'HEAD'
        : body !== undefined && !seen.get
          ? 'POST'
          : 'GET';
  if (leftOut.length > 0) {
    notes.push(`Left out, as a request cannot hold them: ${[...new Set(leftOut)].join(', ')}.`);
  }
  return {
    ok: true,
    request: {
      method: resolved,
      url,
      ...(headers.length === 0 ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    },
    notes,
  };
}
