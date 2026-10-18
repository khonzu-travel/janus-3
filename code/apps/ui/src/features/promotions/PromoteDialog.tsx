import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  AtlasError,
  type CaptureDetail,
  type PromotionRequest,
  type PromotionResult,
  type Scenarios,
} from '../../atlas/client.js';
import type { NameValue } from '../../atlas/runner.js';
import type { PromotionErrorDetails, WirePlannedFile, WirePromotionConflict } from '../../atlas/wire.js';
import { buttonClass, iconButtonClass, primaryButtonClass } from '../../components/buttonClass.js';
import { Collapsible } from '../../components/Collapsible.js';
import { CloseIcon } from '../requests/icons.js';
import { PencilIcon, SpinnerIcon, TrashIcon } from '../../components/icons.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import type { Mark } from '../fixtures/Preview.js';
import { CodeEditor } from '../requests/CodeEditor.js';
import { NameValueTable } from '../requests/fields.js';
import { BodyView } from '../requests/JsonTree.js';
import { idTokenText, noteSentence, refusalSentence, rewriteSentence, suggestionSentence } from './sentences.js';

const inputClass =
  'w-full min-w-0 rounded border border-line-strong bg-surface px-2 py-0.5 font-mono text-mono focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** How long the form waits after the last change before it asks for a new dry run. */
export const DRY_RUN_DELAY_MS = 250;

const KIND_TEXT: Readonly<Record<WirePromotionConflict['kind'], string>> = {
  promoted: 'promoted earlier and unchanged since',
  modified: 'promoted earlier, then edited by hand',
  'hand-written': 'written by hand',
};

const ROLE_TEXT: Readonly<Record<WirePlannedFile['role'], string>> = {
  response: 'Response',
  headers: 'Headers',
  provenance: 'Provenance',
};

interface IdRow {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

/** The captured response as it opens for editing: a JSON body indented, the headers as rows. */
interface Editable {
  readonly body: string;
  readonly json: boolean;
  readonly headers: readonly NameValue[];
}

function editableResponse(capture: CaptureDetail): Editable | null {
  const response = capture.response;
  if (response.state !== 'available') return null;
  const preview = response.body;
  if (preview.state !== 'available' || preview.encoding !== 'utf8' || preview.truncated) return null;
  let body = preview.value;
  let json = false;
  try {
    body = `${JSON.stringify(JSON.parse(preview.value), null, 2)}\n`;
    json = true;
  } catch {
    // Not JSON: edited as the text it is.
  }
  return { body, json, headers: response.headers.map(({ name, value }) => ({ name, value })) };
}

/** Rows that are ticked and named, as a header sidecar: a repeated name becomes a list. */
function headerRecord(rows: readonly NameValue[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '' || row.disabled === true) continue;
    const had = out[name];
    out[name] = had === undefined ? row.value : [...(typeof had === 'string' ? [had] : had), row.value];
  }
  return out;
}

type Answer =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'planned'; readonly result: PromotionResult }
  | { readonly kind: 'refused'; readonly error: Error };

/**
 * The Promote dialog. Every change runs a dry run, which
 * shows the files Janus would write with each rewritten ID marked, and every
 * existing file it would replace. A file that was edited or written by hand
 * is shown with its current content and must be ticked on its own; the
 * dialog sends the digest of the content it showed.
 */
export function PromoteDialog({
  capture,
  scenarios,
  onClose,
  onPromoted,
}: {
  readonly capture: CaptureDetail;
  readonly scenarios: Scenarios | undefined;
  readonly onClose: () => void;
  readonly onPromoted: (result: PromotionResult) => void;
}) {
  const { client } = useAtlasSession();
  const captureScenario = capture.id.split('/')[0] ?? 'default';
  const registration = capture.request.state === 'available' ? capture.request.registration.path : '';
  const [scenario, setScenario] = useState(captureScenario);
  const [path, setPath] = useState(registration);
  const [variant, setVariant] = useState('');
  const [ids, setIds] = useState<readonly IdRow[]>([]);
  const [replace, setReplace] = useState<ReadonlyMap<string, string | null>>(new Map());
  // The latest answer, with the request it answers; an answer to an older request reads as waiting.
  const [answered, setAnswered] = useState<{ readonly key: string; readonly answer: Answer } | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  // Bumped after a failed write, so the dry run runs again against the tree as it is now.
  const [revision, setRevision] = useState(0);
  // The response as edited before promoting; null until the pencil is pressed.
  const editable = useMemo(() => editableResponse(capture), [capture]);
  const [edits, setEdits] = useState<{ readonly body: string; readonly headers: readonly NameValue[] } | null>(null);
  const nextKey = useRef(1);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const declared = useMemo(
    () => scenarios?.items.find((item) => item.name === scenario)?.ids.map((entry) => entry.name) ?? [],
    [scenarios, scenario],
  );

  const request = useMemo((): PromotionRequest => {
    const named = ids.filter((row) => row.name !== '' && row.value !== '');
    return {
      capture: capture.id,
      ...(scenario === captureScenario ? {} : { scenario }),
      ...(path === registration || path === '' ? {} : { path }),
      ...(variant === '' ? {} : { variant }),
      ...(named.length === 0 ? {} : { ids: Object.fromEntries(named.map((row) => [row.name, row.value])) }),
      ...(replace.size === 0
        ? {}
        : {
            replace: [...replace].map(([file, digest]) => (digest === null ? { file } : { file, digest })),
          }),
    };
  }, [capture.id, scenario, captureScenario, path, registration, variant, ids, replace]);
  // Only what was changed is sent; opening the editor alone changes nothing.
  const editedBody = edits !== null && editable !== null && edits.body !== editable.body ? edits.body : undefined;
  const editedHeaders =
    edits !== null && editable !== null && JSON.stringify(edits.headers) !== JSON.stringify(editable.headers)
      ? headerRecord(edits.headers)
      : undefined;
  const sent = useMemo(
    (): PromotionRequest => ({
      ...request,
      ...(editedBody === undefined ? {} : { body: editedBody }),
      ...(editedHeaders === undefined ? {} : { headers: editedHeaders }),
    }),
    [request, editedBody, editedHeaders],
  );

  // A dry run on every change, after a short pause; a newer change cancels the older request.
  const key = `${JSON.stringify(sent)}#${String(revision)}`;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      client.promote({ ...sent, dryRun: true }, controller.signal).then(
        (result) => {
          setAnswered({ key, answer: { kind: 'planned', result } });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const refusal = error instanceof Error ? error : new Error(String(error));
          setAnswered({ key, answer: { kind: 'refused', error: refusal } });
        },
      );
    }, DRY_RUN_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, sent, key]);
  const answer: Answer = answered?.key === key ? answered.answer : { kind: 'waiting' };

  // Focus starts on the first field; Escape closes; Tab stays inside (an `aria-modal` dialog).
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  // Escape cancels wherever focus is, even in the body editor.
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [onClose]);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea'),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const promote = async (): Promise<void> => {
    setSending(true);
    setFailure(null);
    try {
      onPromoted(await client.promote(sent));
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error(String(error)));
      setSending(false);
      setRevision(revision + 1);
    }
  };

  const refused = answer.kind === 'refused' ? answer.error : null;
  const details: PromotionErrorDetails | undefined =
    refused instanceof AtlasError ? refused.details.promotion : undefined;
  const fieldOf = (error: Error | null): string | null => {
    if (!(error instanceof AtlasError)) return null;
    if (error.details.code === 'unknown-scenario') return 'scenario';
    if (error.details.code === 'promotion-unknown-id') return 'ids';
    return error.details.promotion?.field?.split('.')[0] ?? null;
  };
  const field = fieldOf(refused);
  const plan = answer.kind === 'planned' ? answer.result : null;
  const planned = new Set(plan?.files.map((file) => file.file) ?? []);
  const ready = plan !== null && plan.applicable && !sending;

  const fieldError = (name: string): ReactNode =>
    field === name && refused !== null ? (
      <p id={`${titleId}-${name}-error`} className="mt-0.5 text-bad">
        {refused.message}
      </p>
    ) : null;
  const describedBy = (name: string) => (field === name ? `${titleId}-${name}-error` : undefined);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-fg/40 p-4 max-sm:p-0">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-3xl flex-col rounded border border-line bg-bg shadow-lg max-sm:min-h-full max-sm:rounded-none"
      >
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <h2 id={titleId} className="font-medium">
            Promote capture <code className="font-mono text-mono">{capture.id}</code>
          </h2>
          <span className="ml-auto text-muted">Writes fixture files Janus will serve</span>
        </div>

        <form
          className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) void promote();
          }}
        >
          <div>
            <label htmlFor={`${titleId}-scenario`} className="block text-muted">
              Scenario
            </label>
            {scenarios === undefined ? (
              <input
                id={`${titleId}-scenario`}
                className={inputClass}
                value={scenario}
                aria-describedby={describedBy('scenario')}
                onChange={(event) => {
                  setScenario(event.target.value);
                  setReplace(new Map());
                }}
              />
            ) : (
              <select
                id={`${titleId}-scenario`}
                className={inputClass}
                value={scenario}
                aria-describedby={describedBy('scenario')}
                onChange={(event) => {
                  setScenario(event.target.value);
                  setReplace(new Map());
                }}
              >
                {scenarios.items.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            {fieldError('scenario')}
          </div>
          <div>
            <label htmlFor={`${titleId}-variant`} className="block text-muted">
              Variant <span className="text-faint">optional, such as declined</span>
            </label>
            <input
              id={`${titleId}-variant`}
              className={inputClass}
              value={variant}
              aria-describedby={describedBy('variant')}
              onChange={(event) => {
                setVariant(event.target.value);
                setReplace(new Map());
              }}
            />
            {fieldError('variant')}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${titleId}-path`} className="block text-muted">
              Route template <span className="text-faint">rename a parameter, or turn a segment into one</span>
            </label>
            <input
              id={`${titleId}-path`}
              className={inputClass}
              value={path}
              aria-describedby={describedBy('path')}
              onChange={(event) => {
                setPath(event.target.value);
                setReplace(new Map());
              }}
            />
            {fieldError('path')}
          </div>

          <fieldset className="sm:col-span-2" aria-describedby={describedBy('ids')}>
            <legend className="text-muted">IDs</legend>
            {plan === null || plan.bindings.length === 0 ? (
              <p className="text-faint">
                {plan === null ? 'Looking for IDs…' : 'Janus found no declared ID in this capture.'}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {plan.bindings.map((binding) => (
                  <li key={binding.id} className="flex flex-wrap items-baseline gap-2">
                    <code className="font-mono text-mono">{binding.id}</code>
                    <code className="font-mono text-mono break-all text-muted">{binding.value}</code>
                    <span className={binding.tier === 'inferred' ? 'text-warn' : 'text-faint'}>
                      {binding.tier}, from{' '}
                      {binding.source === 'explicit' ? 'you' : binding.source === 'path' ? 'the path' : 'the response'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {ids.map((row, index) => (
              <div key={row.key} className="mt-1 flex items-center gap-2">
                <label className="sr-only" htmlFor={`${titleId}-id-${String(row.key)}`}>
                  ID name {index + 1}
                </label>
                <select
                  id={`${titleId}-id-${String(row.key)}`}
                  className={`${inputClass} max-w-48`}
                  value={row.name}
                  onChange={(event) => {
                    setIds(
                      ids.map((entry) => (entry.key === row.key ? { ...entry, name: event.target.value } : entry)),
                    );
                  }}
                >
                  <option value="">Choose an ID</option>
                  {declared.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor={`${titleId}-value-${String(row.key)}`}>
                  Captured value {index + 1}
                </label>
                <input
                  id={`${titleId}-value-${String(row.key)}`}
                  className={inputClass}
                  placeholder="the value as captured"
                  value={row.value}
                  onChange={(event) => {
                    setIds(
                      ids.map((entry) => (entry.key === row.key ? { ...entry, value: event.target.value } : entry)),
                    );
                  }}
                />
                <button
                  type="button"
                  className={iconButtonClass}
                  aria-label={`Remove ID ${String(index + 1)}`}
                  title={`Remove ID ${String(index + 1)}`}
                  onClick={() => {
                    setIds(ids.filter((entry) => entry.key !== row.key));
                  }}
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={`${buttonClass} mt-1.5`}
              disabled={declared.length === 0}
              onClick={() => {
                setIds([...ids, { key: nextKey.current++, name: declared[0] ?? '', value: '' }]);
              }}
            >
              Bind an ID
            </button>
            {declared.length === 0 ? (
              <span className="ml-2 text-faint">The scenario declares no IDs in its flow.yaml.</span>
            ) : null}
            {fieldError('ids')}
          </fieldset>
        </form>

        <Collapsible
          title="Response"
          label="Response to write"
          className="border-t border-line bg-surface"
          defaultOpen
          actions={
            editable === null ? (
              <span className="text-faint">Only a complete text body can be edited here.</span>
            ) : edits === null ? (
              <button
                type="button"
                className={iconButtonClass}
                aria-label="Edit before promoting"
                title="Edit before promoting"
                onClick={() => {
                  setEdits({ body: editable.body, headers: editable.headers });
                }}
              >
                <PencilIcon className="size-3.5" />
              </button>
            ) : (
              <button
                type="button"
                className={iconButtonClass}
                aria-label="Discard edits"
                title="Discard edits"
                onClick={() => {
                  setEdits(null);
                }}
              >
                <CloseIcon className="size-3.5" />
              </button>
            )
          }
        >
          {edits === null ? (
            <p className="px-3 py-1.5 text-muted">
              Written as captured. Press the pencil to change the headers or the body first.
            </p>
          ) : (
            <div className="pb-2">
              <Collapsible title="Headers" level={4} count={edits.headers.length}>
                <div className="px-3 pb-1">
                  <NameValueTable
                    caption="Response headers"
                    rows={edits.headers}
                    scopes={null}
                    addLabel="Add header"
                    clearLabel="Clear all headers"
                    onChange={(headers) => {
                      setEdits({ ...edits, headers });
                    }}
                  />
                </div>
              </Collapsible>
              <Collapsible title="Body" level={4}>
                <div className="px-3 pb-1">
                  <CodeEditor
                    label="Response body"
                    hideLabel
                    language={editable?.json === true ? 'json' : 'text'}
                    value={edits.body}
                    onChange={(body) => {
                      setEdits((current) => (current === null ? current : { ...current, body }));
                    }}
                  />
                </div>
              </Collapsible>
            </div>
          )}
        </Collapsible>

        <div className="border-t border-line bg-surface">
          <div aria-live="polite" className="sr-only">
            {answer.kind === 'planned'
              ? `Dry run: ${String(answer.result.files.length)} files${answer.result.applicable ? '' : ', with files to confirm'}.`
              : ''}
          </div>
          {answer.kind === 'waiting' ? (
            <p className="flex items-center gap-2 px-4 py-3 text-muted">
              <SpinnerIcon className="size-3.5 motion-safe:animate-spin" />
              Checking what would be written…
            </p>
          ) : refused !== null && field === null ? (
            <Refusal error={refused} details={details} />
          ) : plan === null ? null : (
            <Plan
              plan={plan}
              editing={edits !== null}
              replace={replace}
              onReplace={(file, digest) => {
                const next = new Map([...replace].filter(([key]) => planned.has(key)));
                if (digest === undefined) next.delete(file);
                else next.set(file, digest);
                setReplace(next);
              }}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-2.5">
          {failure !== null ? (
            <p role="alert" className="mr-auto text-bad">
              Not promoted: {failure.message}
            </p>
          ) : (
            <span className="mr-auto text-muted">
              {plan !== null && !plan.applicable ? 'Tick each existing file to replace it.' : null}
            </span>
          )}
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${primaryButtonClass} disabled:opacity-50`}
            disabled={!ready}
            onClick={() => {
              void promote();
            }}
          >
            {sending ? 'Promoting…' : 'Promote'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Plan({
  plan,
  editing,
  replace,
  onReplace,
}: {
  readonly plan: PromotionResult;
  /** The response is being edited above, so its files show no preview here. */
  readonly editing: boolean;
  readonly replace: ReadonlyMap<string, string | null>;
  /** `undefined` unticks; `null` replaces without a digest (a promoted file). */
  readonly onReplace: (file: string, digest: string | null | undefined) => void;
}) {
  const findings = [
    ...plan.suggestions.map((suggestion) => suggestionSentence(suggestion)),
    ...plan.refusals.map((refusal) => refusalSentence(refusal)),
    ...plan.notes.map((note) => noteSentence(note)),
  ];
  return (
    <div className="space-y-3 px-4 py-3">
      {plan.conflicts.length === 0 ? null : (
        <section aria-labelledby="promote-conflicts" className="rounded border border-warn bg-warn-soft/40 p-2">
          <h3 id="promote-conflicts" className="font-medium">
            Existing files this would replace
          </h3>
          <ul className="mt-1 space-y-2">
            {plan.conflicts.map((conflict) => (
              <ConflictRow
                key={conflict.file}
                conflict={conflict}
                ticked={replace.has(conflict.file)}
                onReplace={onReplace}
              />
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="promote-files">
        <h3 id="promote-files" className="font-medium">
          Files <span className="font-normal text-faint">{plan.files.length}</span>
        </h3>
        <p className="text-muted">
          Into <code className="font-mono text-mono">{plan.scenario}</code> at{' '}
          <code className="font-mono text-mono">
            {plan.endpoint.method} {plan.endpoint.path}
          </code>
        </p>
        {plan.files
          .filter((file) => file.role !== 'provenance')
          // Headers first, as a response reads.
          .sort((a, b) => Number(b.role === 'headers') - Number(a.role === 'headers'))
          .map((file) => (
            <PlannedFile key={file.file} file={file} plan={plan} preview={!editing} />
          ))}
        <p className="mt-1 text-faint">
          A provenance file records where each file came from and that it awaits review; it holds no captured values.
        </p>
      </section>
      {plan.rewrites.length === 0 && findings.length === 0 ? null : (
        <section aria-labelledby="promote-ids">
          <h3 id="promote-ids" className="font-medium">
            IDs
          </h3>
          <ul className="list-disc space-y-0.5 pl-5">
            {plan.rewrites.map((rewrite, index) => (
              <li key={`r${String(index)}`} className={rewrite.tier === 'inferred' ? 'text-warn' : undefined}>
                {rewriteSentence(rewrite)}
              </li>
            ))}
            {findings.map((text, index) => (
              <li key={`f${String(index)}`} className="text-warn">
                {text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PlannedFile({
  file,
  plan,
  preview,
}: {
  readonly file: WirePlannedFile;
  readonly plan: PromotionResult;
  readonly preview: boolean;
}) {
  const tiers = new Map(plan.rewrites.map((rewrite) => [rewrite.id, rewrite.tier]));
  const marks: Mark[] = [];
  if (file.preview?.state === 'available' && file.preview.encoding === 'utf8') {
    const value = file.preview.value;
    for (const [id, tier] of tiers) {
      const token = idTokenText(id);
      for (let start = value.indexOf(token); start !== -1; start = value.indexOf(token, start + token.length)) {
        marks.push({ span: { start, end: start + token.length }, label: `ID ${id}, ${tier}` });
      }
    }
    marks.sort((a, b) => a.span.start - b.span.start);
  }
  return (
    <Collapsible
      title={ROLE_TEXT[file.role]}
      label={`${ROLE_TEXT[file.role]} file ${file.file}`}
      className="mt-2 rounded border border-line"
      detail={
        <span className="flex flex-wrap items-baseline gap-2">
          <code className="font-mono text-mono break-all">{file.file}</code>
          <span className="text-faint">{file.action}</span>
        </span>
      }
    >
      {file.preview === null || !preview ? null : (
        <BodyView preview={file.preview} status={200} mediaType={null} marks={marks} />
      )}
    </Collapsible>
  );
}

function ConflictRow({
  conflict,
  ticked,
  onReplace,
}: {
  readonly conflict: WirePromotionConflict;
  readonly ticked: boolean;
  readonly onReplace: (file: string, digest: string | null | undefined) => void;
}) {
  const { client, generation } = useAtlasSession();
  const needsDigest = conflict.kind !== 'promoted';
  const detailUrl = conflict.detailHref;
  const current = useQuery({
    queryKey: ['atlas', generation, 'conflict', detailUrl],
    enabled: needsDigest && detailUrl !== null,
    queryFn: ({ signal }) => {
      if (detailUrl === null) throw new Error('no fixture');
      return client.conflictFixture(detailUrl, signal);
    },
  });
  const isSidecar = conflict.file.endsWith('.headers.json');
  const shown = isSidecar ? (current.data?.sidecar?.preview ?? null) : (current.data?.preview ?? null);
  const digest =
    shown === null ? null : isSidecar ? (current.data?.sidecar?.digest ?? null) : (current.data?.digest ?? null);
  const canTick = !needsDigest || digest !== null;
  const id = useId();
  return (
    <li>
      <label className="flex items-start gap-2" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="mt-1"
          checked={ticked}
          disabled={!canTick}
          onChange={(event) => {
            onReplace(conflict.file, event.target.checked ? (needsDigest ? digest : null) : undefined);
          }}
        />
        <span>
          Replace <code className="font-mono text-mono break-all">{conflict.file}</code>
          <span className="text-muted">, {KIND_TEXT[conflict.kind]}</span>
          {needsDigest && conflict.reason === 'digest-mismatch' ? (
            <span className="block text-bad">It changed since it was shown; check it again.</span>
          ) : null}
        </span>
      </label>
      {needsDigest ? (
        current.data === undefined || shown === null ? (
          <p className="pl-6 text-muted">
            {detailUrl === null || (current.data !== undefined && shown === null)
              ? 'Its content is not shown here, so it cannot be replaced from this dialog.'
              : current.error === null
                ? 'Loading its current content…'
                : `Could not load its current content: ${current.error.message}`}
          </p>
        ) : (
          <div className="mt-1 ml-6 rounded border border-line bg-surface">
            <BodyView
              preview={shown}
              status={current.data.status}
              mediaType={isSidecar ? 'application/json' : current.data.mediaType}
            />
          </div>
        )
      ) : null}
    </li>
  );
}

function Refusal({ error, details }: { readonly error: Error; readonly details: PromotionErrorDetails | undefined }) {
  return (
    <div role="alert" className="border-l-2 border-bad px-4 py-3">
      <p className="font-medium">This capture cannot be promoted as set up</p>
      <p className="text-muted">{error.message}</p>
      {details?.hint === null || details?.hint === undefined ? null : (
        <p className="mt-1">
          Add <code className="font-mono text-mono">{details.hint.overrides}</code> to{' '}
          <code className="font-mono text-mono">overrides</code> in{' '}
          <code className="font-mono text-mono">{details.hint.scenario}/flow.yaml</code>, then try again. Promotion
          never edits flow.yaml.
        </p>
      )}
      {details === undefined || details.problems.length === 0 ? null : (
        <ul className="mt-1 list-disc pl-5">
          {details.problems.map((problem, index) => (
            <li key={index}>
              <code className="font-mono text-mono">{problem.code}</code> in{' '}
              <code className="font-mono text-mono break-all">{problem.path}</code>: {problem.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
