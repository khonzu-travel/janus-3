import { useId, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';

import type { EffectiveConfig } from '../atlas/client.js';
import type { SettingSource, SettingValue, WireSetting } from '../atlas/wire.js';
import { ChevronRightIcon } from '../components/icons.js';
import { EmptyState } from '../components/states/EmptyState.js';
import { ErrorState } from '../components/states/ErrorState.js';
import { isUnsupported } from '../components/states/errors.js';
import { LoadingState } from '../components/states/LoadingState.js';
import { Dialog } from '../features/requests/Dialog.js';
import { CloseIcon } from '../features/requests/icons.js';
import type { Health } from '../atlas/client.js';
import { filterInputClass } from '../components/listRows.js';
import { useConfig, useRecording, useRestart } from '../hooks/useAtlas.js';

const SOURCE_CLASS: Readonly<Record<SettingSource, string>> = {
  default: 'border border-line-strong text-muted',
  file: 'bg-accent-soft text-accent',
  cli: 'bg-tok-bg text-tok-fg',
};

/** `?config=1` on any view: the address that opens the Configuration dialog. */
export const CONFIG_PARAM = 'config';

/**
 * The Configuration dialog, over whichever view is open, while the address has
 * `?config=1` (the desktop app's Server › Configuration… sets it). Closing it
 * drops the parameter.
 */
export function ConfigDialog({ health }: { readonly health: Health }) {
  const [search, setSearch] = useSearchParams();
  if (search.get(CONFIG_PARAM) !== '1') return null;
  const close = (): void => {
    const next = new URLSearchParams(search);
    next.delete(CONFIG_PARAM);
    setSearch(next, { replace: true });
  };
  return (
    <Dialog
      title="Configuration"
      wide
      aside={
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="Close"
          title="Close (Escape)"
          onClick={close}
        >
          <CloseIcon className="size-3.5" />
        </button>
      }
      onClose={close}
    >
      <ConfigPage health={health} />
    </Dialog>
  );
}

/** `#/config` once a tab: the Configuration dialog over Requests. */
export function ConfigRedirect() {
  return <Navigate replace to={`/requests?${CONFIG_PARAM}=1`} />;
}

/** The effective settings, read-only. */
function ConfigPage({ health }: { readonly health: Health }) {
  const config = useConfig();
  const restart = useRestart();

  if (config.error !== null) {
    if (isUnsupported(config.error)) {
      return (
        <EmptyState title="Configuration not reported" headingLevel={2}>
          This Janus server predates configuration reporting, so its settings are not available here.
        </EmptyState>
      );
    }
    return (
      <ErrorState title="Could not load the configuration" error={config.error} onRetry={restart} headingLevel={2} />
    );
  }
  if (config.data === undefined) return <LoadingState label="Loading configuration" />;

  return <Settings config={config.data} health={health} />;
}

/** Settings grouped into collapsible cards in columns, with a filter. */
function Settings({ config, health }: { readonly config: EffectiveConfig; readonly health: Health }) {
  const { configDigest, configFile, settings } = config;
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const filterId = useId();
  const changed = settings.filter((setting) => setting.source !== 'default').length;
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, WireSetting[]>();
  for (const setting of settings) {
    if (changedOnly && setting.source === 'default') continue;
    if (needle !== '' && !setting.key.toLowerCase().includes(needle)) continue;
    const group = setting.key.includes('.') ? (setting.key.split('.')[0] ?? 'general') : 'general';
    groups.set(group, [...(groups.get(group) ?? []), setting]);
  }
  return (
    <section aria-label="Settings" className="bg-bg pb-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
        <label htmlFor={filterId} className="sr-only">
          Filter settings
        </label>
        <input
          id={filterId}
          type="search"
          value={query}
          placeholder="Filter settings"
          className={filterInputClass}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(event) => {
              setChangedOnly(event.target.checked);
            }}
          />
          Changed from default only <span className="text-faint">{changed}</span>
        </label>
        <dl className="ml-auto flex flex-wrap gap-x-4 text-muted">
          <div className="flex min-w-0 gap-1.5">
            <dt>Digest</dt>
            <dd className="break-all font-mono text-mono text-fg">{configDigest}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>File</dt>
            <dd className="text-fg">{configFile ? 'Loaded' : 'None'}</dd>
          </div>
        </dl>
      </div>
      {configFile ? null : (
        <p className="mx-4 mt-3 border-l-2 border-line-strong bg-surface p-3 text-muted">
          <strong className="font-medium text-fg">Running on defaults.</strong> No configuration file was loaded; every
          setting below is a built-in default or a command-line flag.
        </p>
      )}
      <RecordingSection health={health} />
      {groups.size === 0 ? (
        <EmptyState title="Nothing matches">No setting matches this filter.</EmptyState>
      ) : (
        <div className="gap-3 px-4 pt-3 [column-width:380px]">
          {[...groups].map(([group, rows]) => (
            <details key={group} open className="group mb-3 break-inside-avoid rounded border border-line bg-surface">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 font-medium hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3 text-faint transition-transform group-open:rotate-90" />
                {group}
                <span className="font-normal text-faint">{rows.length}</span>
              </summary>
              <table className="stack-table w-full text-left">
                <caption className="sr-only">{`Effective settings: ${group}`}</caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Value</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((setting) => (
                    <tr key={setting.key} className="border-t border-line">
                      <th
                        scope="row"
                        data-label="Setting"
                        className="py-1 pr-2 pl-2.5 align-baseline font-mono text-mono font-normal whitespace-nowrap text-muted"
                      >
                        {setting.key.startsWith(`${group}.`) ? (
                          <>
                            <span className="sr-only">{`${group}.`}</span>
                            {setting.key.slice(group.length + 1)}
                          </>
                        ) : (
                          setting.key
                        )}
                      </th>
                      <td
                        data-label="Value"
                        className="py-1 pr-2 text-right align-baseline font-mono text-mono break-all"
                      >
                        {formatSettingValue(setting.value)}
                      </td>
                      <td data-label="Source" className="py-1 pr-2.5 text-right align-baseline">
                        <span className={`inline-block rounded px-1.5 text-label ${SOURCE_CLASS[setting.source]}`}>
                          {setting.source}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}
      <p className="px-4 pb-4 text-label text-muted">
        Read-only. Where Janus binds and where it reads fixtures are not shown. Change settings in janus.config.yaml or
        with command-line flags, then restart Janus.
      </p>
    </section>
  );
}

/** Lists show as "[a, b]"; an empty list as "[]". */
function formatSettingValue(value: SettingValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Readonly<Record<string, string>>);
    return `{${entries.map(([name, expression]) => `${name}: ${expression}`).join(', ')}}`;
  }
  return String(value);
}

/**
 * The Recording section: each registration as a sentence and
 * the limits, or a statement that recording is off.
 */
function RecordingSection({ health }: { readonly health: Health }) {
  const recording = useRecording(health);
  const off = health.capabilities.recording.endpoints === 0;
  return (
    <section aria-labelledby="recording-title" className="mx-4 mt-3 rounded border border-line bg-surface">
      <h3 id="recording-title" className="border-b border-line px-2.5 py-1.5 font-medium">
        Recording
      </h3>
      <div className="space-y-1 px-2.5 py-2">
        {off ? (
          <p className="text-muted">Recording is off: no endpoints are registered in recording.endpoints.</p>
        ) : recording.error !== null ? (
          <p className="text-muted">The recording settings could not be loaded.</p>
        ) : recording.data === undefined ? (
          <p className="text-muted">Loading the recording settings…</p>
        ) : (
          <>
            {recording.data.available ? null : (
              <p className="text-warn">This server cannot record in its current mode; requests to record get 501.</p>
            )}
            <ul className="space-y-0.5">
              {recording.data.endpoints.map((endpoint) => (
                <li key={`${endpoint.method} ${endpoint.path}`}>
                  <code className="font-mono text-mono">
                    {endpoint.method} {endpoint.path}
                  </code>{' '}
                  is forwarded to <code className="font-mono text-mono break-all">{endpoint.upstream}</code>
                </li>
              ))}
            </ul>
            <p className="text-muted">
              Each exchange may take up to {recording.data.timeoutMs} ms and return up to{' '}
              {recording.data.maxResponseBytes} bytes; at most {recording.data.maxConcurrent} record at once.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
