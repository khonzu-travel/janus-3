import type { ConfigResult } from '../config.js';

/** Rendered instead of the app when the runtime configuration is invalid; no request is made. */
export function ConfigErrorPage({ result }: { readonly result: Extract<ConfigResult, { ok: false }> }) {
  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="text-xl font-bold">Janus Atlas</h1>
      <section role="alert" aria-labelledby="config-error" className="mt-4 border-l-2 border-bad bg-bad-soft p-3">
        <h2 id="config-error" className="font-medium text-bad">
          Configuration error
        </h2>
        <p className="mt-1">{result.message}.</p>
        <p className="mt-1 text-muted">
          Fix <code>atlas-config.js</code> next to this page and reload.
        </p>
      </section>
    </main>
  );
}
