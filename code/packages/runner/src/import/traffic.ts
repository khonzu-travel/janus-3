import { METHOD_PATTERN, REFUSED_METHODS, type MultipartPart, type NameValue, type RequestBody } from '../model.js';
import type { Converted, ImportContext } from './context.js';
import { camelCase, toRunnerName } from './names.js';
import { fileReference } from './postman.js';
import { convertTemplate, type Note } from './template.js';
import { base64Decode, decodeUtf8, encodeUtf8, list, record, text, type JsonRecord } from './text.js';
import { compact, nonEmptyList, type FolderDraft, type RequestDraft } from './tree.js';
import type { ImportOrigin, ImportTransaction } from './types.js';

/**
 * Recorded traffic: Charles JSON sessions and HAR 1.2.
 * Each transaction's request becomes a request file, grouped by
 * origin; responses only classify static assets.
 */

export interface TrafficParam {
  readonly name: string;
  readonly value: string;
  readonly fileName?: string;
  readonly contentType?: string;
}

/** One recorded transaction, in a form both readers produce. */
export interface Transaction {
  /** 1-based position in the session. */
  readonly position: number;
  readonly location: string;
  readonly method: string;
  readonly scheme: string;
  readonly host: string;
  /** Null for the scheme's default port. */
  readonly port: number | null;
  /** The path as recorded, starting with "/". */
  readonly path: string;
  /** The query as recorded, without "?"; null when there is none. */
  readonly query: string | null;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly body: {
    readonly text?: string;
    readonly bytes?: Uint8Array;
    readonly params?: readonly TrafficParam[];
    readonly mimeType?: string;
  } | null;
  readonly responseMimeType: string;
  /** Chrome's `_resourceType`. */
  readonly resourceType?: string;
  /** Why the transaction is incomplete, or null. */
  readonly incomplete: string | null;
}

/** Headers never copied from a recording: hop-by-hop, Host and Content-Length. */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const STATIC_RESOURCE_TYPES: Readonly<Record<string, string>> = {
  image: 'image',
  font: 'font',
  stylesheet: 'stylesheet',
  script: 'script',
};

/** The kind of static asset a response is, or null. */
export function staticKind(mimeType: string, resourceType: string | undefined): string | null {
  const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('font/') || /^application\/(x-)?font/.test(mime) || mime === 'application/vnd.ms-fontobject') {
    return 'font';
  }
  if (mime === 'text/css') return 'stylesheet';
  if (/^(text|application)\/(x-)?(javascript|ecmascript)$/.test(mime)) return 'script';
  return resourceType === undefined ? null : (STATIC_RESOURCE_TYPES[resourceType] ?? null);
}

function defaultPort(scheme: string): number {
  return scheme === 'https' || scheme === 'wss' ? 443 : 80;
}

function originOf(tx: Transaction): string {
  return `${tx.scheme}://${tx.host}${tx.port === null ? '' : `:${String(tx.port)}`}`;
}

/** A recorded path or query made safe for a template: braces encoded, and `:` at a segment start. */
function safePath(path: string): string {
  return path
    .replace(/\{/g, '%7B')
    .replace(/\}/g, '%7D')
    .replace(/(^|\/):/g, '$1%3A');
}

function lastSegment(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function convertTraffic(
  transactions: readonly Transaction[],
  format: 'charles' | 'har',
  file: string,
  name: string,
  context: ImportContext,
): Converted {
  const { options, report } = context;
  const variables = new Map<string, string>();
  const usedVariables = new Set<string>();
  const counts = new Map<string, number>();
  const folders = new Map<string, FolderDraft>();
  const preview: ImportTransaction[] = [];

  const variableFor = (tx: Transaction, origin: string): string => {
    let variable = variables.get(origin);
    if (variable === undefined) {
      const base = camelCase(tx.port === null ? tx.host : `${tx.host}-${String(tx.port)}`);
      variable = `${base}BaseUrl`;
      for (let n = 2; usedVariables.has(variable); n++) variable = `${base}${String(n)}BaseUrl`;
      variables.set(origin, variable);
      usedVariables.add(variable);
    }
    return variable;
  };

  for (const tx of transactions) {
    const origin = originOf(tx);
    const url = `${origin}${tx.path}${tx.query === null ? '' : `?${tx.query}`}`;
    const entry = report.entry(file, tx.location, `${tx.method} ${url}`);
    const http = tx.scheme === 'http' || tx.scheme === 'https';
    const kind = staticKind(tx.responseMimeType, tx.resourceType);
    const reason =
      tx.method === 'CONNECT'
        ? 'CONNECT tunnels are not imported'
        : !http
          ? tx.scheme === ''
            ? `the transaction cannot be read (${tx.incomplete ?? 'no URL'})`
            : `${tx.scheme} is not an HTTP scheme; the transaction is not imported`
          : tx.incomplete !== null
            ? `the transaction is incomplete (${tx.incomplete}) and is not imported`
            : kind !== null && options.includeStatic !== true
              ? `static asset (${kind}) skipped; import with static assets included to keep it`
              : options.origins !== undefined && !options.origins.includes(origin)
                ? 'not imported: its origin is not among the selected origins'
                : options.positions !== undefined && !options.positions.includes(tx.position)
                  ? 'not imported: its position is not among the selected transactions'
                  : !METHOD_PATTERN.test(tx.method) || REFUSED_METHODS.has(tx.method)
                    ? `the method ${tx.method} cannot be sent by Janus`
                    : null;
    if (http && tx.method !== 'CONNECT') {
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
      variableFor(tx, origin);
    }
    preview.push({
      position: tx.position,
      method: tx.method,
      url,
      origin,
      static: kind !== null,
      included: reason === null,
    });
    if (reason !== null) {
      entry.skip(reason);
      continue;
    }
    const variable = variableFor(tx, origin);
    let folder = folders.get(origin);
    if (folder === undefined) {
      folder = {
        kind: 'folder',
        base: toRunnerName(tx.port === null ? tx.host : `${tx.host}-${String(tx.port)}`, 'origin'),
        document: { name: origin },
        children: [],
        report: null,
      };
      folders.set(origin, folder);
    }
    const note = entry.note;
    const dropped: string[] = [];
    const headers: NameValue[] = [];
    for (const header of tx.headers) {
      const lower = header.name.toLowerCase();
      if (header.name.startsWith(':') || DROPPED_HEADERS.has(lower)) {
        if (!header.name.startsWith(':') && lower !== 'host' && lower !== 'content-length') dropped.push(header.name);
        continue;
      }
      headers.push({ name: header.name, value: convertTemplate(header.value, 'literal', note) });
    }
    if (dropped.length > 0) note(`hop-by-hop headers were dropped: ${dropped.join(', ')}`);
    const body = trafficBody(tx, headers, note);
    if (body.body?.type === 'multipart') {
      // The recorded boundary would not match the one Janus generates.
      const at = headers.findIndex((header) => header.name.toLowerCase() === 'content-type');
      if (at !== -1) headers.splice(at, 1);
    }
    const path = tx.path === '' ? '/' : tx.path;
    if (safePath(path) !== path || (tx.query !== null && safePath(tx.query) !== tx.query)) {
      note('braces, and ":" at the start of a path segment, were percent-encoded so the URL is not read as a template');
    }
    const document = compact({
      name: `${tx.method} ${tx.path}${tx.query === null ? '' : `?${tx.query}`}`,
      method: tx.method,
      url: `{{${variable}}}${safePath(path)}${tx.query === null ? '' : `?${safePath(tx.query)}`}`,
      headers: nonEmptyList(headers),
      body: body.body,
      source: { format, file, item: tx.location },
    });
    const segment = lastSegment(path);
    const draft: RequestDraft = {
      kind: 'request',
      base: toRunnerName(`${tx.method}-${segment}`, tx.method.toLowerCase()),
      document,
      report: entry,
      ...(body.file === undefined ? {} : { bodyFile: body.file }),
    };
    folder.children.push(draft);
  }

  const used = [...folders.keys()];
  const origins: ImportOrigin[] = [...counts.entries()].map(([origin, count]) => ({
    origin,
    variable: variables.get(origin) ?? '',
    transactions: count,
  }));
  const root: FolderDraft = {
    kind: 'folder',
    base: '',
    document: { name },
    children: [...folders.values()],
    report: null,
  };
  const vars = Object.fromEntries(used.map((origin) => [variables.get(origin) ?? '', origin]));
  return {
    ok: true,
    name,
    root,
    environments: used.length === 0 ? [] : [{ base: 'imported', name: 'Imported', vars, secrets: {} }],
    origins,
    transactions: preview,
  };
}

function trafficBody(
  tx: Transaction,
  headers: readonly NameValue[],
  note: Note,
): { body?: RequestBody; file?: { bytes: Uint8Array; contentType?: string } } {
  const source = tx.body;
  if (source === null) return {};
  const contentType =
    headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? source.mimeType ?? '';
  const mime = contentType.toLowerCase();
  const params = source.params ?? [];
  if (/^application\/x-www-form-urlencoded/.test(mime) && params.length > 0) {
    const fields =
      source.text !== undefined
        ? [...new URLSearchParams(source.text)].map(([name, value]) => ({ name, value }))
        : params.map((param) => ({ name: param.name, value: param.value }));
    if (fields.length > 0) {
      return {
        body: {
          type: 'form',
          fields: fields.map((field) => ({
            name: field.name,
            value: convertTemplate(field.value, 'literal', note),
          })),
        },
      };
    }
  }
  if (/^multipart\/form-data/.test(mime) && params.length > 0) {
    const parts: MultipartPart[] = [];
    for (const param of params) {
      if (param.fileName === undefined) {
        parts.push({ name: param.name, value: convertTemplate(param.value, 'literal', note) });
        continue;
      }
      const file = fileReference(param.fileName, `the file part "${param.name}"`, note);
      if (file === null) continue;
      parts.push(
        param.contentType === undefined || param.contentType === ''
          ? { name: param.name, file }
          : { name: param.name, file, contentType: param.contentType },
      );
    }
    note('the multipart body is rebuilt from its parts; its recorded Content-Type and boundary were dropped');
    return { body: { type: 'multipart', parts } };
  }
  const bytes = source.bytes ?? (source.text === undefined ? undefined : encodeUtf8(source.text));
  if (bytes === undefined || bytes.length === 0) return {};
  const decoded = source.text ?? decodeUtf8(bytes);
  if (decoded === null || decoded.includes('\0')) {
    note('the body is not UTF-8 text; it is kept in a file beside the request');
    return { file: contentType === '' ? { bytes } : { bytes, contentType } };
  }
  const type = /[/+]json\b/.test(mime) ? 'json' : /[/+]xml\b/.test(mime) ? 'xml' : 'text';
  return { body: { type, text: convertTemplate(decoded, 'literal', note) } };
}

// ---------------------------------------------------------------------------
// Readers

const HEADER_NAME = /^:?[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function headerRows(value: unknown): { name: string; value: string }[] {
  return list(value)
    .map(record)
    .map((header) => ({ name: text(header.name) ?? '', value: text(header.value) ?? '' }))
    .filter((header) => HEADER_NAME.test(header.name));
}

/** A Charles JSON session (`.chlsj`): an array of transactions. */
export function readCharles(json: readonly unknown[]): Transaction[] {
  return json.map((value, index) => {
    const tx = record(value);
    const request = record(tx.request);
    const response = record(tx.response);
    const scheme = (text(tx.scheme) ?? 'http').toLowerCase();
    const port = Number(text(tx.actualPort) ?? text(tx.port) ?? defaultPort(scheme));
    const path = text(tx.path) ?? '/';
    const query = text(tx.query);
    const status = text(tx.status) ?? 'COMPLETE';
    const body = record(request.body);
    const encoded = text(body.encoded);
    const bodyText = text(body.text);
    const bytes = encoded === undefined ? undefined : (base64Decode(encoded) ?? undefined);
    const mimeType = text(request.mimeType);
    const hasBody = bodyText !== undefined || bytes !== undefined;
    return {
      position: index + 1,
      location: `[${String(index)}]`,
      method: (text(tx.method) ?? 'GET').toUpperCase(),
      scheme,
      host: (text(tx.host) ?? '').toLowerCase(),
      port: Number.isNaN(port) || port === defaultPort(scheme) ? null : port,
      path: path.startsWith('/') ? path : `/${path}`,
      query: query === undefined || query === '' ? null : query,
      headers: headerRows(record(request.header).headers),
      body: hasBody ? compact({ text: bodyText, bytes: bodyText === undefined ? bytes : undefined, mimeType }) : null,
      responseMimeType: text(response.mimeType) ?? '',
      incomplete:
        status === 'COMPLETE'
          ? null
          : status.toLowerCase().replace(/_/g, ' ') +
            (text(tx.errorMessage) === undefined ? '' : `: ${text(tx.errorMessage) ?? ''}`),
    };
  });
}

/** HAR 1.2 `log.entries`, as Chrome, Firefox and proxies export them. */
export function readHar(log: JsonRecord): Transaction[] {
  return list(log.entries).map((value, index) => {
    const entry = record(value);
    const request = record(entry.request);
    const response = record(entry.response);
    const location = `log.entries[${String(index)}]`;
    const method = (text(request.method) ?? 'GET').toUpperCase();
    const status = Number(text(response.status) ?? '0');
    let parsed: URL | null;
    try {
      parsed = new URL(text(request.url) ?? '');
    } catch {
      parsed = null;
    }
    const postData = entry.request === undefined ? {} : record(request.postData);
    const postText = text(postData.text);
    const encoding = text(postData.encoding);
    const params = list(postData.params)
      .map(record)
      .map((param) =>
        compact<TrafficParam>({
          name: text(param.name) ?? '',
          value: text(param.value) ?? '',
          fileName: text(param.fileName),
          contentType: text(param.contentType),
        }),
      );
    const bytes = encoding === 'base64' && postText !== undefined ? (base64Decode(postText) ?? undefined) : undefined;
    const hasBody = postText !== undefined || params.length > 0;
    const scheme = parsed === null ? '' : parsed.protocol.replace(/:$/, '');
    const responseError = text(response._error);
    const resourceType = text(entry._resourceType);
    return {
      position: index + 1,
      location,
      method,
      scheme,
      host: parsed?.hostname ?? '',
      port: parsed === null || parsed.port === '' ? null : Number(parsed.port),
      path: parsed === null ? '/' : parsed.pathname,
      query: parsed === null || parsed.search === '' ? null : parsed.search.slice(1),
      headers: headerRows(request.headers),
      body: hasBody
        ? compact({
            text: bytes === undefined ? postText : undefined,
            bytes,
            params: params.length > 0 ? params : undefined,
            mimeType: text(postData.mimeType),
          })
        : null,
      responseMimeType: text(record(response.content).mimeType) ?? '',
      ...(resourceType === undefined ? {} : { resourceType }),
      incomplete:
        parsed === null
          ? `the URL ${text(request.url) ?? ''} cannot be read`
          : responseError !== undefined && responseError !== ''
            ? responseError
            : status === 0 || Number.isNaN(status)
              ? 'no response was recorded'
              : null,
    };
  });
}
