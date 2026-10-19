import { useId, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router';

import {
  BODY_TYPES,
  type BodyType,
  type MultipartPart,
  type RequestBody,
  type RequestDocument,
  type Scripts,
} from '../../atlas/runner.js';
import { SCENARIO_NAME } from '../../atlas/wire.js';
import { linkClass, removableRowClass } from '../../components/buttonClass.js';
import { ChevronRightIcon } from '../../components/icons.js';
import { Tabs } from '../../components/Tabs.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { useChangeScenario } from '../../scenarios/ScenarioSelector.js';
import { CodeEditor } from './CodeEditor.js';
import { looksLikeCurl, parseCurl } from './curl.js';
import { ExtractTable } from './ExtractTable.js';
import { useScriptHelp } from './storedFlag.js';
import {
  inputClass,
  MapTable,
  NameValueTable,
  RemoveButton,
  selectClass,
  TableActions,
  TemplateInput,
  TextArea,
} from './fields.js';
import { pathParamNames, withEntry, type Scopes } from './variables.js';

export const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

type Section = 'params' | 'headers' | 'body' | 'vars' | 'extract' | 'scripts' | 'route' | 'docs';

/** The Body type list: JSON and GraphQL first, the bodies most requests carry. */
const BODY_CHOICES: readonly (BodyType | 'none')[] = [
  'none',
  'json',
  'graphql',
  ...BODY_TYPES.filter((type) => type !== 'json' && type !== 'graphql'),
];

export const BODY_TEXT: Readonly<Record<BodyType | 'none', string>> = {
  none: 'No body',
  json: 'JSON',
  text: 'Text',
  xml: 'XML',
  form: 'Form (URL-encoded)',
  multipart: 'Multipart form',
  file: 'File',
  graphql: 'GraphQL',
};

/** Writes `value` at `key`, or drops the key when the value is empty. */
function withField<K extends keyof RequestDocument>(
  draft: RequestDocument,
  key: K,
  value: RequestDocument[K] | undefined,
): RequestDocument {
  return withEntry(draft, key, value);
}

/**
 * The labels' line above the method, URL and Send: as tall as the icon buttons
 * on it plus the gap under them, which matches a label's gap above its field.
 */
const labelLineClass = 'mb-0.5 flex h-[29px] items-end text-muted';
/** Lifts the buttons on the labels' line so their gap to the field matches the label text's. */
const lineButtonsClass = 'mb-[5px] flex';

/**
 * The request editor: method and URL, then one section at a
 * time: path parameters, headers, body, variables, `extract`, scripts, the
 * capture route and docs.
 */
export function RequestEditor({
  draft,
  onChange,
  scopes,
  actions,
  save,
  tools,
}: {
  readonly draft: RequestDocument;
  readonly onChange: (draft: RequestDocument) => void;
  readonly scopes: Scopes;
  /** Buttons beside the URL: Send or Explain. */
  readonly actions?: ReactNode;
  /** Above `actions`, on the labels' line: Save. */
  readonly save?: ReactNode;
  /** Flush right on the URL's label line: Duplicate, Delete and Move. */
  readonly tools?: ReactNode;
}) {
  const [section, setSection] = useState<Section>('params');
  /** What a curl command pasted into the URL left out, or why it could not be read; cleared by the next URL edit. */
  const [curlNotes, setCurlNotes] = useState<readonly string[]>([]);
  const { health } = useOutletContext<AtlasLayoutContext>();
  const changeScenario = useChangeScenario(health);
  const methodId = useId();
  const names = pathParamNames(draft.url);
  const params = Object.fromEntries(names.map((name) => [name, draft.pathParams?.[name] ?? '']));
  const count = (value: object | undefined): number | undefined =>
    value === undefined ? undefined : Object.keys(value).length;
  const tabs = [
    { key: 'params', label: 'Path parameters', count: names.length },
    { key: 'headers', label: 'Headers', count: draft.headers?.length },
    { key: 'body', label: 'Body' },
    { key: 'vars', label: 'Variables', count: count(draft.vars) },
    { key: 'extract', label: 'Extract', count: count(draft.extract) },
    { key: 'scripts', label: 'Scripts' },
    { key: 'route', label: 'Route' },
    { key: 'docs', label: 'Docs' },
  ] as const;
  return (
    <div className="min-w-0">
      {/* The name is edited on the request's tab (double-click it, or its menu). */}
      <div className="px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <div>
            <label htmlFor={methodId} className={labelLineClass}>
              Method
            </label>
            <select
              id={methodId}
              className={`${selectClass} font-mono text-mono`}
              value={draft.method}
              onChange={(event) => {
                const method = event.target.value;
                // A POST almost always carries JSON: switching to it turns "No body" into an empty JSON body.
                onChange(
                  method === 'POST' && draft.body === undefined
                    ? { ...draft, method, body: emptyBody('json') }
                    : { ...draft, method },
                );
              }}
            >
              {(METHODS.includes(draft.method) ? METHODS : [draft.method, ...METHODS]).map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <TemplateInput
              label="URL"
              value={draft.url}
              scopes={scopes}
              placeholder="{{baseUrl}}/v1/carts/:cartId"
              labelEnd={tools === undefined ? undefined : <div className={lineButtonsClass}>{tools}</div>}
              onChange={(url) => {
                setCurlNotes([]);
                onChange({ ...draft, url });
              }}
              onPaste={(text) => {
                // A whole curl command pasted here fills the request: method, URL, headers and body.
                if (!looksLikeCurl(text)) return false;
                const result = parseCurl(text);
                if (!result.ok) {
                  setCurlNotes([`The curl command could not be read: ${result.message}.`]);
                  return true;
                }
                const { pathParams: _params, headers: _headers, body: _body, ...rest } = draft;
                setCurlNotes(result.notes);
                onChange({ ...rest, ...result.request });
                return true;
              }}
            />
            {curlNotes.length === 0 ? null : (
              <ul aria-label="Notes on the pasted curl command" className="mt-0.5 text-warn">
                {curlNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
          {actions === undefined ? null : (
            <div>
              <div className={labelLineClass}>
                <div className={lineButtonsClass}>{save}</div>
              </div>
              <div className="flex items-center gap-1">{actions}</div>
            </div>
          )}
        </div>
      </div>
      <Tabs label="Request sections" tabs={tabs} selected={section} onSelect={setSection} panelClassName="px-4 py-3">
        {section === 'params' ? (
          names.length === 0 ? (
            <p className="text-muted">
              The URL has no <code className="font-mono text-mono">:name</code> segments.
            </p>
          ) : (
            <MapTable
              caption="Path parameters"
              entries={params}
              fixedNames
              scopes={scopes}
              onChange={(entries) => {
                onChange(withField(draft, 'pathParams', entries));
              }}
            />
          )
        ) : null}
        {section === 'headers' ? (
          <NameValueTable
            caption="Headers"
            rows={draft.headers ?? []}
            scopes={scopes}
            addLabel="Add header"
            clearLabel="Clear all headers"
            scenarioHeader={{
              // The top bar picks the scenario: drop the header, and pick its value there when it names one.
              onUse: (value, index) => {
                onChange(
                  withField(
                    draft,
                    'headers',
                    (draft.headers ?? []).filter((_row, at) => at !== index),
                  ),
                );
                if (SCENARIO_NAME.test(value)) changeScenario(value);
              },
            }}
            onChange={(headers) => {
              onChange(withField(draft, 'headers', headers));
            }}
          />
        ) : null}
        {section === 'body' ? (
          <BodyEditor
            body={draft.body}
            scopes={scopes}
            onChange={(body) => {
              onChange(withField(draft, 'body', body));
            }}
          />
        ) : null}
        {section === 'vars' ? (
          <MapTable
            caption="Request variables"
            entries={draft.vars ?? {}}
            scopes={scopes}
            addLabel="Add variable"
            clearLabel="Clear all variables"
            onChange={(vars) => {
              onChange(withField(draft, 'vars', vars));
            }}
          />
        ) : null}
        {section === 'extract' ? (
          <ExtractTable
            extract={draft.extract ?? {}}
            onChange={(extract) => {
              onChange(withField(draft, 'extract', extract));
            }}
          />
        ) : null}
        {section === 'scripts' ? (
          <ScriptsEditor
            scripts={draft.scripts ?? {}}
            onChange={(scripts) => {
              onChange(withField(draft, 'scripts', scripts));
            }}
          />
        ) : null}
        {section === 'route' ? (
          <div className="max-w-xl">
            <TemplateInput
              label="Capture route"
              value={draft.route ?? ''}
              scopes={null}
              placeholder="/v1/carts/{id}"
              onChange={(route) => {
                onChange(withField(draft, 'route', route));
              }}
            />
            <p className="mt-1 text-muted">
              Record mode files the capture under this route template. Leave it empty to use the registered upstream’s
              route, or the URL’s path after the folder’s strip prefix.
            </p>
          </div>
        ) : null}
        {section === 'docs' ? (
          <TextArea
            label="Docs"
            value={draft.docs ?? ''}
            onChange={(docs) => {
              onChange(withField(draft, 'docs', docs));
            }}
          />
        ) : null}
      </Tabs>
    </div>
  );
}

type TextBody = Extract<RequestBody, { type: 'json' | 'text' | 'xml' }>;

function isTextBody(body: RequestBody): body is TextBody {
  return body.type === 'json' || body.type === 'text' || body.type === 'xml';
}

function emptyBody(type: BodyType): RequestBody {
  switch (type) {
    case 'json':
    case 'text':
    case 'xml':
      return { type, text: '' };
    case 'form':
      return { type, fields: [] };
    case 'multipart':
      return { type, parts: [] };
    case 'file':
      return { type, file: '' };
    case 'graphql':
      return { type, query: '' };
  }
}

function BodyEditor({
  body,
  onChange,
  scopes,
}: {
  readonly body: RequestBody | undefined;
  readonly onChange: (body: RequestBody | undefined) => void;
  readonly scopes: Scopes;
}) {
  const typeId = useId();
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <label htmlFor={typeId}>Body type</label>
        <select
          id={typeId}
          className={selectClass}
          value={body?.type ?? 'none'}
          onChange={(event) => {
            const type = event.target.value as BodyType | 'none';
            onChange(type === 'none' ? undefined : emptyBody(type));
          }}
        >
          {BODY_CHOICES.map((type) => (
            <option key={type} value={type}>
              {BODY_TEXT[type]}
            </option>
          ))}
        </select>
      </div>
      {body === undefined ? null : isTextBody(body) ? (
        <CodeEditor
          label={`${BODY_TEXT[body.type]} body`}
          language={body.type === 'json' ? 'json' : 'text'}
          value={body.text}
          scopes={scopes}
          onChange={(text) => {
            onChange({ type: body.type, text });
          }}
        />
      ) : body.type === 'form' ? (
        <NameValueTable
          caption="Form fields"
          rows={body.fields}
          scopes={scopes}
          addLabel="Add field"
          onChange={(fields) => {
            onChange({ type: 'form', fields });
          }}
        />
      ) : body.type === 'multipart' ? (
        <MultipartEditor
          parts={body.parts}
          onChange={(parts) => {
            onChange({ type: 'multipart', parts });
          }}
        />
      ) : body.type === 'file' ? (
        <div className="grid max-w-xl gap-2">
          <TemplateInput
            label="File, relative to the request file"
            value={body.file}
            scopes={null}
            onChange={(file) => {
              onChange({ ...body, file });
            }}
          />
          <TemplateInput
            label="Content type"
            value={body.contentType ?? ''}
            scopes={null}
            onChange={(contentType) => {
              const { contentType: _old, ...rest } = body;
              onChange(contentType === '' ? rest : { ...rest, contentType });
            }}
          />
        </div>
      ) : (
        <>
          <CodeEditor
            label="GraphQL query"
            language="text"
            value={body.query}
            scopes={scopes}
            onChange={(query) => {
              onChange({ ...body, query });
            }}
          />
          <CodeEditor
            label="GraphQL variables (JSON)"
            language="json"
            value={body.variables ?? ''}
            scopes={scopes}
            onChange={(variables) => {
              const { variables: _old, ...rest } = body;
              onChange(variables === '' ? rest : { ...rest, variables });
            }}
          />
        </>
      )}
    </div>
  );
}

function MultipartEditor({
  parts,
  onChange,
}: {
  readonly parts: readonly MultipartPart[];
  readonly onChange: (parts: MultipartPart[]) => void;
}) {
  const change = (index: number, part: MultipartPart): void => {
    onChange(parts.map((entry, at) => (at === index ? part : entry)));
  };
  return (
    <div>
      <TableActions
        addLabel="Add part"
        onAdd={() => {
          onChange([...parts, { name: '', value: '' }]);
        }}
      />
      {parts.length === 0 ? null : (
        <table className="data-table w-full">
          <caption className="sr-only">Multipart parts</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Value or file</th>
              <th scope="col" className="w-8">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part, index) => {
              const label = part.name === '' ? `part ${String(index + 1)}` : part.name;
              const isFile = 'file' in part;
              return (
                <tr key={index} className={removableRowClass}>
                  <td>
                    <input
                      aria-label={`Name, ${label}`}
                      className={inputClass}
                      value={part.name}
                      onChange={(event) => {
                        change(index, { ...part, name: event.target.value });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Kind, ${label}`}
                      className={selectClass}
                      value={isFile ? 'file' : 'text'}
                      onChange={(event) => {
                        change(
                          index,
                          event.target.value === 'file'
                            ? { name: part.name, file: '' }
                            : { name: part.name, value: '' },
                        );
                      }}
                    >
                      <option value="text">Text</option>
                      <option value="file">File</option>
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`${isFile ? 'File' : 'Value'}, ${label}`}
                      className={inputClass}
                      value={isFile ? part.file : part.value}
                      onChange={(event) => {
                        change(
                          index,
                          isFile ? { ...part, file: event.target.value } : { ...part, value: event.target.value },
                        );
                      }}
                    />
                  </td>
                  <td>
                    <RemoveButton
                      label={`Remove ${label}`}
                      onClick={() => {
                        onChange(parts.filter((_part, at) => at !== index));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ScriptsEditor({
  scripts,
  onChange,
}: {
  readonly scripts: Scripts;
  readonly onChange: (scripts: Scripts) => void;
}) {
  const noteId = useId();
  const set = (key: keyof Scripts, value: string): void => {
    onChange(withEntry(scripts, key, value));
  };
  const [help, setHelp] = useScriptHelp();
  return (
    <div className="@container grid gap-3">
      <div className="grid gap-3 @2xl:grid-cols-2">
        <CodeEditor
          label="Before the request is sent"
          value={scripts.before ?? ''}
          describedBy={noteId}
          onChange={(value) => {
            set('before', value);
          }}
        />
        <CodeEditor
          label="After the response arrives"
          value={scripts.after ?? ''}
          describedBy={noteId}
          onChange={(value) => {
            set('after', value);
          }}
        />
      </div>
      <div>
        <button
          type="button"
          className={`${linkClass} inline-flex items-center gap-1`}
          aria-expanded={help}
          aria-controls={noteId}
          onClick={() => {
            setHelp(!help);
          }}
        >
          <ChevronRightIcon className={`size-3.5 ${help ? 'rotate-90' : ''}`} />
          Scripting help
        </button>
      </div>
      <div id={noteId} hidden={!help} className="border-l-2 border-line-strong bg-surface p-3 text-muted">
        <p>
          Tab indents, or indents every selected line; Shift + Tab outdents. Press Escape, then Tab, to move on from the
          editor.
        </p>
        <p className="mt-1">
          Scripts run in a sandbox with no network, files or timers. <code className="font-mono text-mono">expect</code>{' '}
          (chai) is available.
        </p>
        <p className="mt-1">
          Postman: <code className="font-mono text-mono">pm.variables</code>,{' '}
          <code className="font-mono text-mono">pm.environment</code>,{' '}
          <code className="font-mono text-mono">pm.collectionVariables</code> (get, set, unset, has, replaceIn),{' '}
          <code className="font-mono text-mono">pm.request</code> (method, url, headers, body; change it before the
          request only), <code className="font-mono text-mono">pm.response</code> (code, status, headers.get,
          responseTime, text(), json(), to.have.status), <code className="font-mono text-mono">pm.test</code>,{' '}
          <code className="font-mono text-mono">pm.expect</code>, <code className="font-mono text-mono">pm.info</code>,{' '}
          <code className="font-mono text-mono">tests[name]</code>.
        </p>
        <p className="mt-1">
          Bruno: <code className="font-mono text-mono">bru</code> (getVar, setVar, getEnvVar, setEnvVar, hasVar,
          deleteVar, getRequestVar, getFolderVar, getCollectionVar, interpolate, getEnvName),{' '}
          <code className="font-mono text-mono">req</code> (get and set URL, method, headers, body),{' '}
          <code className="font-mono text-mono">res</code> (status, headers, body, responseTime,{' '}
          <code className="font-mono text-mono">res(&quot;a.b&quot;)</code>),{' '}
          <code className="font-mono text-mono">test</code>.
        </p>
        <p className="mt-1">
          Setting a variable sets a run variable; files are never changed. Sending more requests, setNextRequest and
          cookie jars are not supported.
        </p>
      </div>
    </div>
  );
}
