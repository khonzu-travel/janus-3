// Janus Atlas runtime configuration. Replace this file on the static host to
// point the UI at a server without rebuilding it. `serverUrl` may be absolute
// or relative to this page and may include a path; it defaults to the page's
// own origin. A server on another origin must list this page's origin in its
// `cors.origins` setting, or the browser will not let the UI read its answers.
// The UI that Janus serves itself at /_janus/ui/ ignores this file: Janus
// generates its own, pointing at the server that served the page.
//
// globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: 'http://127.0.0.1:4010' };
