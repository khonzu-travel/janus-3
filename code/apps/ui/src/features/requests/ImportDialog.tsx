import { useEffect, useId, useRef, useState } from 'react';

import { RUNNER_NAME, type ImportRequest, type ImportResult } from '../../atlas/runner.js';
import { buttonClass, primaryButtonClass } from '../../components/buttonClass.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { Dialog } from './Dialog.js';
import { inputClass } from './fields.js';
import { ProblemList } from './RequestWorkspace.js';

type Picked = ImportRequest['files'];

const FORMAT_TEXT: Readonly<Record<string, string>> = {
  postman: 'Postman collection',
  bruno: 'Bruno collection',
  'bruno-yaml': 'Bruno collection (YAML)',
  charles: 'Charles session',
  har: 'HAR file',
};

/** Base64 of a file's bytes, in chunks so large files do not overflow the argument list. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/**
 * The Import dialog: pick files, a folder or a zip; see
 * what would be created and the report; then Import, or Replace after a
 * confirmation that names the collection.
 */
export function ImportDialog({
  onClose,
  onImported,
}: {
  readonly onClose: () => void;
  readonly onImported: (collection: string) => void;
}) {
  const { client } = useAtlasSession();
  const filesId = useId();
  const folderId = useId();
  const intoId = useId();
  const readSequence = useRef(0);
  const [selection, setSelection] = useState(0);
  const [files, setFiles] = useState<Picked | null>(null);
  const [reading, setReading] = useState(false);
  const [into, setInto] = useState<string | null>(null);
  const [excludedOrigins, setExcludedOrigins] = useState<ReadonlySet<string>>(new Set());
  const [excludedPositions, setExcludedPositions] = useState<ReadonlySet<number>>(new Set());
  const [includeStatic, setIncludeStatic] = useState(false);
  const [preview, setPreview] = useState<{ readonly key: string; readonly result: ImportResult } | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);

  const allOrigins = preview?.result.origins.map((entry) => entry.origin) ?? [];
  const allPositions = preview?.result.transactions.map((entry) => entry.position) ?? [];
  const intoValid = into === null || RUNNER_NAME.test(into);
  const request: ImportRequest | null =
    files === null || !intoValid
      ? null
      : {
          files,
          ...(into === null ? {} : { into }),
          ...(includeStatic ? { includeStatic: true } : {}),
          ...(excludedOrigins.size === 0
            ? {}
            : { origins: allOrigins.filter((origin) => !excludedOrigins.has(origin)) }),
          ...(excludedPositions.size === 0
            ? {}
            : { positions: allPositions.filter((position) => !excludedPositions.has(position)) }),
        };
  const key =
    request === null ? null : JSON.stringify({ ...request, selection, files: request.files.map((file) => file.name) });

  // Every change asks for a new preview.
  useEffect(() => {
    if (request === null || key === null) return undefined;
    const controller = new AbortController();
    client.runner
      .importFiles({ ...request, preview: true }, controller.signal)
      .then((result) => {
        setFailure(null);
        setPreview({ key, result });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreview(null);
        setFailure(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      controller.abort();
    };
    // `key` stands for `request`, which is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  const pick = (list: FileList | null): void => {
    if (list === null || list.length === 0) return;
    const sequence = ++readSequence.current;
    setReading(true);
    setConfirming(false);
    setFailure(null);
    Promise.all(
      [...list].map(async (file) => ({
        name: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
        contentBase64: await base64Of(file),
      })),
    )
      .then((read) => {
        if (sequence !== readSequence.current) return;
        setSelection(sequence);
        setFiles(read);
        setInto(null);
        setExcludedOrigins(new Set());
        setExcludedPositions(new Set());
        setPreview(null);
      })
      .catch((error: unknown) => {
        if (sequence !== readSequence.current) return;
        setFailure(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (sequence === readSequence.current) setReading(false);
      });
  };

  const current = preview !== null && preview.key === key ? preview.result : null;

  const write = async (replace: boolean): Promise<void> => {
    if (request === null) return;
    setImporting(true);
    setFailure(null);
    try {
      const result = await client.runner.importFiles({ ...request, ...(replace ? { replace: true } : {}) });
      onImported(result.collection);
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error(String(error)));
      setImporting(false);
      setConfirming(false);
    }
  };

  const toggle = <T,>(set: ReadonlySet<T>, value: T, on: boolean): Set<T> => {
    const next = new Set(set);
    if (on) next.delete(value);
    else next.add(value);
    return next;
  };

  const skipped = current?.report.filter((item) => item.outcome === 'skipped') ?? [];
  const noted = current?.report.filter((item) => item.outcome === 'converted-with-notes') ?? [];
  const converted = current?.report.filter((item) => item.outcome === 'converted').length ?? 0;
  const requests = current?.files.filter((file) => file.kind === 'request') ?? [];

  return (
    <Dialog title="Import a collection" aside="Postman, Bruno, Charles or HAR" onClose={onClose} wide>
      <div className="grid gap-4 px-4 py-3">
        <section aria-labelledby={`${filesId}-step1`}>
          <h3 id={`${filesId}-step1`} className="font-medium">
            1. Choose what to import
          </h3>
          <p className="text-muted">Pick files, a zip, or a folder. The format is detected from the content.</p>
          <div className="mt-2 flex flex-wrap gap-4">
            <div>
              <label htmlFor={filesId} className="block text-muted">
                Files or a zip
              </label>
              <input
                id={filesId}
                type="file"
                multiple
                onChange={(event) => {
                  pick(event.target.files);
                }}
              />
            </div>
            <div>
              <label htmlFor={folderId} className="block text-muted">
                A folder
              </label>
              <input
                id={folderId}
                type="file"
                // A folder picker: React has no prop for it.
                {...{ webkitdirectory: '' }}
                onChange={(event) => {
                  pick(event.target.files);
                }}
              />
            </div>
          </div>
          {reading ? <LoadingState label="Reading the files" /> : null}
        </section>

        {files === null ? null : (
          <section aria-labelledby={`${filesId}-step2`}>
            <h3 id={`${filesId}-step2`} className="font-medium">
              2. Check the preview
            </h3>
            {current === null && failure === null ? <LoadingState label="Converting" /> : null}
            {current === null ? null : (
              <div className="mt-2 grid gap-3">
                <p>
                  {FORMAT_TEXT[current.format] ?? current.format}: “{current.name}”. {requests.length}{' '}
                  {requests.length === 1 ? 'request' : 'requests'}, {converted} converted as they are, {noted.length}{' '}
                  with notes, {skipped.length} skipped.
                </p>
                <div className="max-w-sm">
                  <label htmlFor={intoId} className="block text-muted">
                    Collection name
                  </label>
                  <input
                    id={intoId}
                    className={inputClass}
                    value={into ?? current.collection}
                    aria-invalid={!intoValid}
                    onChange={(event) => {
                      setInto(event.target.value);
                    }}
                  />
                  {intoValid ? (
                    current.exists ? (
                      <p className="mt-0.5 text-warn">A collection with this name exists. Importing replaces it.</p>
                    ) : null
                  ) : (
                    <p className="mt-0.5 text-bad">Use lower-case letters, digits and single hyphens.</p>
                  )}
                </div>
                {current.existingEnvironments.length === 0 ? null : (
                  <p className="text-warn">
                    {current.existingEnvironments.length === 1 ? 'The environment ' : 'The environments '}
                    {current.existingEnvironments.map((name, index) => (
                      <span key={name}>
                        {index === 0 ? '' : ', '}
                        <code className="font-mono text-mono">{name}</code>
                      </span>
                    ))}{' '}
                    {current.existingEnvironments.length === 1 ? 'exists' : 'exist'}, shared by every collection.
                    Importing replaces {current.existingEnvironments.length === 1 ? 'it' : 'them'}.
                  </p>
                )}
                {current.origins.length === 0 ? null : (
                  <fieldset>
                    <legend className="text-muted">Origins</legend>
                    {current.origins.map((entry) => (
                      <label key={entry.origin} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={!excludedOrigins.has(entry.origin)}
                          onChange={(event) => {
                            setExcludedOrigins(toggle(excludedOrigins, entry.origin, event.target.checked));
                          }}
                        />
                        <code className="font-mono text-mono">{entry.origin}</code>
                        <span className="text-muted">
                          as <code className="font-mono text-mono">{`{{${entry.variable}}}`}</code>,{' '}
                          {entry.transactions} {entry.transactions === 1 ? 'transaction' : 'transactions'}
                        </span>
                      </label>
                    ))}
                    <label className="mt-1 flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={includeStatic}
                        onChange={(event) => {
                          setIncludeStatic(event.target.checked);
                        }}
                      />
                      Include static assets (scripts, styles, images, fonts)
                    </label>
                  </fieldset>
                )}
                {current.transactions.length === 0 ? null : (
                  <fieldset className="max-h-64 overflow-y-auto rounded border border-line p-2">
                    <legend className="text-muted">Transactions</legend>
                    {current.transactions.map((entry) => (
                      <label key={entry.position} className="flex min-w-0 items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={!excludedPositions.has(entry.position)}
                          onChange={(event) => {
                            setExcludedPositions(toggle(excludedPositions, entry.position, event.target.checked));
                          }}
                        />
                        <span className="font-mono text-mono">{entry.method}</span>
                        <span className={`truncate font-mono text-mono ${entry.included ? '' : 'text-faint'}`}>
                          {entry.url}
                        </span>
                        {entry.static ? <span className="text-label text-muted">static</span> : null}
                      </label>
                    ))}
                  </fieldset>
                )}
                {requests.length === 0 ? null : (
                  <details>
                    <summary className="cursor-pointer text-muted">
                      Files that will be written ({current.files.length})
                    </summary>
                    <ul className="mt-1 font-mono text-mono">
                      {current.files.map((file) => (
                        <li key={file.path}>{file.path}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <ReportGroup title="Skipped" items={skipped} />
                <ReportGroup title="Converted with notes" items={noted} />
                {current.problems.length === 0 ? null : <ProblemList problems={current.problems} />}
              </div>
            )}
          </section>
        )}
        {failure === null ? null : <ErrorState title="The import did not work" error={failure} />}
        {confirming && current !== null ? (
          <p role="alert" className="border-l-2 border-warn bg-warn-soft px-3 py-2">
            {current.exists ? (
              <>
                Replace the collection <code className="font-mono text-mono">{into ?? current.collection}</code>? Every
                file in it is replaced by the imported ones.
              </>
            ) : (
              <>Replace the environments that exist? Their files are replaced by the imported ones.</>
            )}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          {current === null ? null : current.exists || current.existingEnvironments.length > 0 ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={importing || current.problems.length > 0 || requests.length === 0}
              onClick={() => {
                if (confirming) void write(true);
                else setConfirming(true);
              }}
            >
              {confirming
                ? current.exists
                  ? `Replace ${into ?? current.collection}`
                  : 'Replace environments'
                : 'Replace'}
            </button>
          ) : (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={importing || current.problems.length > 0 || requests.length === 0}
              onClick={() => void write(false)}
            >
              Import
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ReportGroup({ title, items }: { readonly title: string; readonly items: ImportResult['report'] }) {
  if (items.length === 0) return null;
  return (
    <details open>
      <summary className="cursor-pointer font-medium">
        {title} ({items.length})
      </summary>
      <ul className="mt-1 grid gap-1">
        {items.map((item, index) => (
          <li key={index}>
            <span className="font-medium">{item.name}</span>{' '}
            <span className="text-muted">
              {item.file}
              {item.location === '' ? '' : ` ${item.location}`}
            </span>
            <ul className="list-disc pl-5 text-muted">
              {item.notes.map((note, at) => (
                <li key={at}>{note}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}
