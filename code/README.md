# Janus implementation workspace

All executable Janus code lives in this directory.

## Getting started

Requires Node.js 22.22 or newer and pnpm 12 (pinned in `package.json`).

```sh
pnpm install
pnpm exec playwright install chromium   # once, for the browser acceptance test
pnpm check   # format:check → lint → typecheck → test → build → test:budgets → test:e2e → test:desktop
```

Other scripts: `pnpm format`, `pnpm test:coverage`, and `pnpm test:e2e` (builds
the UI, then runs the Playwright journey in `tests/e2e/`). To use a Chromium
that is already installed instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

### Dependency rules

`tests/boundaries.test.ts` enforces these rules between the workspace packages;
its rule table is `tests/boundaries/rules.ts`, where every package must have an
entry.

1. **core imports nothing platform-specific.** No other Janus package, no
   `node:*` built-in, no Node global (`Buffer`, `process`, `require`,
   `__dirname`), and no framework or I/O library. This applies to static imports
   and `import()` alike.
2. **Spec providers and plugins** import only core's interface types.
3. **ui imports no Janus package.** It owns its Atlas wire types and decodes
   responses at its client boundary.
4. **Adapters and fixture sources** depend on core, never on each other, except
   `fixtures-vite` → `fixtures-fs`.
5. **server** is the only package that wires everything together. Nothing
   depends on it except the desktop app (rule 7).
6. **server → ui is an asset-only edge.** server declares `@janus/ui` only to
   serve its built files at `/_janus/ui/`, through `assetDeps` and an
   `import.meta.resolve` of a `dist/` path; it never imports a module from it.
7. **The desktop app runs Janus only through the server.** `@janus/desktop`
   depends on `@janus/server` alone and declares `@janus/ui` as an asset only.
   Its directories have narrower rules: the main process imports only
   `electron` besides server, the app's own pages (`src/pages/`) are browser
   code with no Janus package, and the preload imports only `contextBridge` and
   `ipcRenderer`.
8. **The runner depends only on core and does no I/O.** `@janus/runner` imports
   `@janus/core` and its allowlisted libraries, and no `node:*` module; network,
   files and time reach it through `RunnerPorts`. Only server imports it.

To run Janus and the Atlas UI, build first, then serve a fixture tree:

```sh
pnpm install
pnpm build                                # builds the server and the Atlas UI
pnpm janus serve --data examples/data     # UI at http://127.0.0.1:4010/_janus/ui/
```

No configuration file is needed. See [Serving fixtures](#serving-fixtures) for
the fixture layout and [Configuration file](#configuration-file) for the
optional `janus.config.yaml`. To use Janus without Node or a terminal, see the
[desktop app](#desktop-app).

## Serving fixtures

After `pnpm install && pnpm build`, create a fixture:

```text
data/default/v1/products/GET/200.json
```

```json
[{ "id": "p-1", "name": "Example" }]
```

Start Janus and request it:

```sh
pnpm janus serve --data ./data --host 127.0.0.1 --port 4010
# or: node apps/server/dist/bin.js serve …   (the package also installs a `janus` bin)

curl -i http://127.0.0.1:4010/v1/products
```

`examples/data/` is a small ready-made tree: `pnpm janus serve --data examples/data`.

### Command line

```text
janus serve    [--config <path> | --no-config] [--data <path>] [--host <address>] [--port <integer>]
               [--seed <integer>] [--now <instant>] [--scenario <name>] [--watch] [--no-ui]
janus validate [--config <path> | --no-config] [--data <path>] [--seed <integer>] [--now <instant>]
               [--scenario <name>] [--no-ui] [--strict] [--require-reviewed] [--format text|json]
```

| Option                          | Default               | Notes                                                                                    |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `--config`                      | `./janus.config.yaml` | Used only when it exists; a named file that is missing is an error.                      |
| `--no-config`                   | —                     | Ignore any configuration file. Cannot be combined with `--config`.                       |
| `--data`                        | `./data`              | Relative to the working directory. Overrides `fixtures.root`.                            |
| `--host`                        | `127.0.0.1`           | Loopback only by default. Janus has no authentication.                                   |
| `--port`                        | `4010`                | `0` picks a free port; the chosen URL is printed at startup.                             |
| `--seed`                        | picked at startup     | Seed for generated dynamic values, 0–4294967295. Overrides `dynamic.seed`.               |
| `--now`                         | the wall clock        | RFC 3339 instant dynamic values render against. Overrides `dynamic.now`.                 |
| `--scenario`                    | `default`             | The scenario requests get when nothing selects one. Overrides `scenarios.default`.       |
| `--watch` (serve)               | off                   | Reload when fixture files change (see [Hot reload](#hot-reload)). Sets `fixtures.watch`. |
| `--no-ui`                       | —                     | Do not serve the [Atlas UI](#atlas-ui) at `/_janus/ui/`. Sets `ui.enabled: false`.       |
| `--strict` (validate)           | off                   | Also fail on warnings.                                                                   |
| `--format` (validate)           | `text`                | `json` prints one JSON document to stdout.                                               |
| `--require-reviewed` (validate) | off                   | Also fail while any promoted file is pending review (see [Promotion](#promotion)).       |

`janus --help` prints usage. Usage errors exit `2`. Before binding, `serve`
validates the configuration file and the fixture tree together and, if
anything is wrong, prints every problem and exits `1` without opening the port.
`SIGINT`/`SIGTERM` shut down gracefully (active requests get up to 5 s) and exit
`0`. On Windows, use Ctrl+C in the console: Windows has no `SIGTERM`, so
terminating the process from outside skips the graceful shutdown.

### Configuration file

Janus reads `janus.config.yaml` from the working directory, or the file named
with `--config`. Without one, it runs on defaults and flags, exactly as before
configuration files existed. Other spellings (`janus.config.yml`, `.janusrc`, …)
are never loaded; if one is present without `janus.config.yaml`, Janus warns.

```yaml
# janus.config.yaml
$schema: ./node_modules/@janus/server/schema/janus.config.schema.json

server:
  host: 127.0.0.1
  port: 4010
  strictTrailingSlash: true
  autoOptions: true

fixtures:
  root: ./data
  watch: false

onUnknownMethod: 405
onNoFixture: 404

limits:
  maxUrlBytes: 8192
  maxHeaderBytes: 16384
  maxBodyBytes: 1048576
  maxDecodedBodyBytes: 4194304

negotiation:
  mediaTypePreference: []
  onUnusableAccept: 400
  onUnacceptable: 406

diagnostics:
  headers: true

dynamic:
  now: null
  clockMode: frozen
  timezone: UTC
  seed: null
  strictRefs: false
  aliases: {}

atlas:
  resolve: true

ui:
  enabled: true

cors:
  origins: []
  maxAge: 600
  fixtures:
    origins: []
    credentials: false
    maxAge: 600

scenarios:
  default: default

sessions:
  keyFrom: []
  idleTimeout: 1800
  max: 1000

idempotency:
  enabled: true
  header: Idempotency-Key
  methods: [POST, PATCH]
  maxEntries: 1000

faults:
  enabled: true
  timeoutMs: 120000
  maxHeldConnections: 128
  latency: null

compression:
  enabled: true
  encodings: [br, gzip, deflate]
  minBytes: 1024

codecs:
  xml: true
```

| Key                               | Default               | Flag         | Effect                                                                                                          |
| --------------------------------- | --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `server.host`                     | `127.0.0.1`           | `--host`     | Bind address. A non-loopback address is a warning (`non-loopback-bind`).                                        |
| `server.port`                     | `4010`                | `--port`     | Bind port, 0–65535; `0` picks a free port.                                                                      |
| `server.strictTrailingSlash`      | `true`                | —            | `true`: `/a/` never matches `/a`. `false`: exactly one trailing `/` is dropped (`/a//` is still invalid).       |
| `server.autoOptions`              | `true`                | —            | `OPTIONS` to a fixture path without an `OPTIONS` directory gets `204` with `Allow`. `false`: `405`.             |
| `fixtures.root`                   | `./data`              | `--data`     | Fixture root, relative to the configuration file's directory.                                                   |
| `fixtures.watch`                  | `false`               | `--watch`    | `true`: reload the snapshot when fixture files change. An invalid edit never replaces the served one.           |
| `onUnknownMethod`                 | `405`                 | —            | Known path, unknown method: `405` with `Allow`, or `404 route-not-found` without disclosing methods.            |
| `onNoFixture`                     | `404`                 | —            | No route matches in the selected scenario: `404 route-not-found`, or `501 not-mocked`.                          |
| `limits.maxUrlBytes`              | `8192`                | —            | Integer ≥ 256. Longer request targets get `414 url-too-long`.                                                   |
| `limits.maxHeaderBytes`           | `16384`               | —            | Integer ≥ 1024. Larger header sections (request line not counted) get `431 headers-too-large`.                  |
| `limits.maxBodyBytes`             | `1048576`             | —            | Integer ≥ 0 (`0` allows no body). Larger bodies, on any method, get `413 request-too-large`.                    |
| `limits.maxDecodedBodyBytes`      | `4194304`             | —            | Integer ≥ `maxBodyBytes`. A request body larger than this once decoded gets `413 decoded-body-too-large`.       |
| `negotiation.mediaTypePreference` | `[]`                  | —            | Media types that win `Accept` ties (e.g. `*/*`, or no `Accept`), first first; others follow lexically.          |
| `negotiation.onUnusableAccept`    | `400`                 | —            | An `Accept` with no usable range: `400 invalid-request`, or `any` to treat it as `*/*`.                         |
| `negotiation.onUnacceptable`      | `406`                 | —            | No representation matches `Accept`: `406 not-acceptable`, or `ignore` to serve the first by preference.         |
| `diagnostics.headers`             | `true`                | —            | `false` removes every `X-Mock-*` header Janus adds, for clients that must see only fixture headers.             |
| `dynamic.now`                     | `null`                | `--now`      | RFC 3339 instant dynamic values render against; `null` uses the wall clock.                                     |
| `dynamic.clockMode`               | `frozen`              | —            | `frozen`: `dynamic.now` never moves. `offset`: it starts there and advances with the wall clock.                |
| `dynamic.timezone`                | `UTC`                 | —            | IANA zone for dates such as `{{$today}}`; never the host's zone. An unknown zone is `unknown-timezone`.         |
| `dynamic.seed`                    | `null`                | `--seed`     | Seed for generated values, 0–4294967295; `null` picks one at startup, logs it and reports it.                   |
| `dynamic.strictRefs`              | `false`               | —            | `true`: a request value a token needs but the request lacks is `500 render-failed`.                             |
| `dynamic.aliases`                 | `{}`                  | —            | Custom clock aliases, `name: <base><offsets>`, e.g. `trialEnd: today+30d`. Mistakes are `invalid-alias`.        |
| `atlas.resolve`                   | `true`                | —            | `false` disables `POST /_janus/resolve` and Explore: it then answers `404`, and runs in explain mode get `400`. |
| `ui.enabled`                      | `true`                | `--no-ui`    | Serve the Atlas UI at `/_janus/ui/`. `false`: those paths answer `404 route-not-found`.                         |
| `cors.origins`                    | `[]`                  | —            | Origins whose pages may call Atlas across origins; see [Cross-origin access](#cross-origin-access).             |
| `cors.maxAge`                     | `600`                 | —            | Seconds browsers may cache a successful preflight, 0–86400.                                                     |
| `cors.fixtures.origins`           | `[]`                  | —            | Origins whose pages may call fixture routes across origins; see [Faults and transport](#faults-and-transport).  |
| `cors.fixtures.credentials`       | `false`               | —            | `true` adds `Access-Control-Allow-Credentials: true`, for cookie-keyed sessions. Not with `["*"]`.              |
| `cors.fixtures.maxAge`            | `600`                 | —            | Seconds browsers may cache a fixture preflight, 0–86400.                                                        |
| `scenarios.default`               | `default`             | `--scenario` | The scenario a request gets when nothing else selects one. An unknown name is `unknown-default-scenario`.       |
| `sessions.keyFrom`                | `[]`                  | —            | Up to 8 `header.<name>` / `cookie.<name>` entries; the first present one is hashed into the session ID.         |
| `sessions.idleTimeout`            | `1800`                | —            | Seconds, 60–86400, after a session's last request before it expires.                                            |
| `sessions.max`                    | `1000`                | —            | Sessions that may exist at once, 1–100000. Creating one more is `503 session-limit`; none is evicted.           |
| `idempotency.enabled`             | `true`                | —            | `false` resolves every retry again instead of replaying a session's stored response.                            |
| `idempotency.header`              | `Idempotency-Key`     | —            | The header carrying the key. Not `X-Mock-*`, a hop-by-hop header or `Content-Type`.                             |
| `idempotency.methods`             | `[POST, PATCH]`       | —            | Methods whose responses are stored for replay: any of `POST`, `PATCH`, `PUT`, `DELETE`.                         |
| `idempotency.maxEntries`          | `1000`                | —            | Stored responses per session, 1–100000; storing one more drops that session's oldest.                           |
| `faults.enabled`                  | `true`                | —            | `false` turns off every fault and delay at once; `fault.yaml` and latency are still loaded and described.       |
| `faults.timeoutMs`                | `120000`              | —            | Milliseconds, 1000–3600000, a `timeout` fault holds a connection before closing it.                             |
| `faults.maxHeldConnections`       | `128`                 | —            | Connections held at once, 1–10000; one more gets `503 fault-capacity-exceeded`.                                 |
| `faults.latency`                  | `null`                | —            | Server-wide delay before the first byte: `{ ms: 300 }` or `{ min: 200, max: 800 }`.                             |
| `compression.enabled`             | `true`                | —            | Compress fixture responses by `Accept-Encoding`.                                                                |
| `compression.encodings`           | `[br, gzip, deflate]` | —            | Codings Janus may use, preferred first on ties.                                                                 |
| `compression.minBytes`            | `1024`                | —            | Bodies smaller than this are sent uncompressed.                                                                 |
| `codecs.xml`                      | `true`                | —            | `body.` references read XML request bodies as a document. `false`: an XML body is a missing value.              |

- **Precedence**: flags, then the file, then the defaults. When a flag
  overrides a value the file sets, `serve` logs it once
  (`janus config-override key=server.port file=4010 cli=4020`).
- **Strict**: unknown keys, duplicate keys, wrong types, out-of-range values,
  and custom YAML tags (`!env`, `!!js/…`) are errors. An unknown key gets a
  "did you mean" suggestion when one is close. Sizes are plain integers in
  bytes; suffixes such as `10MiB` are not supported. An empty file means "all
  defaults"; `$schema` is accepted and ignored. Anchors and aliases work.
- **Seed**: without `dynamic.seed` or `--seed`, `serve` picks a seed once,
  logs it (`janus seed seed=… source=generated`) and reports it at
  `/_janus/clock`, so any run can be reproduced. A generated seed does not
  change `configDigest`.
- **Paths**: relative paths in the file resolve against the file's directory;
  relative flags resolve against the working directory.
- **Editor support**: the JSON Schema is `apps/server/schema/janus.config.schema.json`
  (shipped in the `@janus/server` package). `examples/janus.config.yaml` shows
  every setting at its default. After changing the Zod schema in
  `packages/core/src/config/`, run `pnpm schema`; a test fails while the
  committed schema is out of date.

### Startup errors and `janus validate`

Every run reports every independent problem it can find, sorted and located:

```text
janus: 3 startup errors; not starting.
  janus.config.yaml:3:3: unknown key "prot" under "server"; did you mean "port"? [config-unknown-key]
  janus.config.yaml:6:18: expected 404 or 405, got 403 [config-invalid-value]
  data/default/v1/products/GET/200.headers.json:3:3: invalid JSON: unexpected "}" [invalid-headers]
```

Each line is `<path>[:<line>[:<column>]]: <message> [<code>]`; warnings follow
the errors, prefixed `warning:`. Fixture paths are shown under the fixture root
as given. If `fixtures.root` itself is invalid (and `--data` is not given),
fixture validation is skipped and the report says so.

`janus validate` runs the same pass without binding a port, for CI:

```sh
janus validate                        # exit 0: valid (warnings allowed); 1: errors; 2: usage error
janus validate --strict               # warnings fail too
janus validate --require-reviewed     # promoted files pending review fail too
janus validate --format json          # {"valid":…,"configDigest":…,"snapshotVersion":…,"errors":[…],"warnings":[…]}
```

On success, `configDigest` and `snapshotVersion` identify exactly what was
validated; `serve` reports the same values in `/_janus/health`. Each JSON error
has `code`, `source` (`cli`, `config`, `fixtures`), `path`, and, when known,
`line`, `column`, `key`, and `token`. `--host` and `--port` are accepted so the
same command line works for both commands.

Warnings never change behaviour: `non-loopback-bind`,
`config-similar-file-ignored`, `redundant-content-type` (a header sidecar
repeats the `Content-Type` its response file name already sets),
`janus-computed-header` (a sidecar sets `Content-Length`, `Date` or
`Content-Encoding`, which Janus drops and computes itself), and
`content-type-override` (a sidecar `Content-Type` deliberately names a
different media type than the file name), and `unreceivable-method` (a method
directory such as `FOO/` that Node's HTTP parser refuses, so it is never
served).

### Fixture layout

```text
data/
├── <scenario>/                 any other scenario: flow.yaml and its own files (see Scenarios)
└── default/                    the root scenario (required)
    └── <segment>/…             zero or more URL path segments: literal, or {name}
        └── <METHOD>/           uppercase HTTP method; the last directory
            ├── <response file> one per locale per media type, optionally with a variant (200.empty.json)
            ├── <status>[.<variant>].headers.json   optional
            ├── accepts.yaml    optional: the request media types this method accepts
            └── variants.yaml, pages.yaml, sequence.yaml, expect.yaml   optional: see Choosing between responses
```

For example (all of these are in `examples/data`):

```text
data/default/v1/products/{productId}/GET/
├── 200.json
└── 200.yaml
data/default/v1/products/p-1/GET/200.json
data/default/v1/products/POST/
├── accepts.yaml
└── 201.json
```

```sh
curl http://127.0.0.1:4010/v1/products/p-1                                   # the literal p-1 fixture
curl -H 'Accept: application/yaml' http://127.0.0.1:4010/v1/products/p-42   # the YAML file
curl -H 'Accept: text/csv'         http://127.0.0.1:4010/v1/products/p-42   # 406
curl -X POST -H 'Content-Type: application/xml' -d '<p/>' \
  http://127.0.0.1:4010/v1/products                                          # 415
```

- **Path segments** are literal, or a template. Directory names are
  percent-decoded once and NFC-normalised, so `a%20b` serves `/a%20b`. Matching
  is case-sensitive, but routes that differ only by case are rejected because
  they are not portable. `_janus` is reserved as a first segment.
- **Path parameters**: a directory named `{name}` (a letter or `_`, then
  letters, digits or `_`) matches any one non-empty segment and binds its
  decoded value. Braces with other text (`p-{id}`), a name bound twice in one
  route, and two template directories side by side are startup errors. A
  literal directory beside a template wins for its own value, and matching
  backtracks: with `products/featured/GET/` and
  `products/{productId}/reviews/GET/`, `/v1/products/featured/reviews` is
  answered by the template. A path matches at the first directory that has
  method directories; a method missing there is `405` listing that
  directory's methods.
- **Response files** are named `<status>.<ext>`, and the extension gives the
  media type: `200.json` answers `200` with `Content-Type: application/json`.
  The extensions are `.json`, `.txt`, `.html`, `.css`, `.js`, `.csv`, `.md`,
  `.xml`, `.yaml`/`.yml`, `.pdf`, `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`,
  `.svg` and `.bin` (`application/octet-stream`); any other is a startup
  error. For another media type, write it in the name as
  `<status>_{<type>-<subtype>}.<ext>`, where the first `-` stands for `/`:
  `422_{application-problem+json}.json`. The extension is then free, and
  `+suffix` types such as `{application-vnd.acme+json}` work. `200.json` and
  `200_{application-json}.json` are the same response, so they cannot both be
  present. Bytes are replayed unchanged; `.json` files are syntax-checked at
  startup but never reformatted.
- **Several media types**: one status may have one file per media type
  (`200.json`, `200.yaml`). Janus picks
  one by `Accept`: each file takes the quality of its most specific matching
  range (a `q=0` range refuses it); ties go to the more specific range, then
  `negotiation.mediaTypePreference`, then lexical order. No match is
  `406 not-acceptable` naming the offered types (or, with
  `onUnacceptable: ignore`, the first by preference). Malformed ranges are
  dropped with an `X-Mock-Warning`; an `Accept` with no usable range is
  `400 invalid-request` (or `*/*` with `onUnusableAccept: any`). Every bodyful
  response sends `Vary: Accept`, even with one media type.
- **Localized responses** add a language tag in square brackets:
  `200_[en-US].json`, `200_[fr].html`. The files
  sharing a locale (or sharing none) are one response in several media types:
  Janus first picks the locale from `Accept-Language` (exact tag, then shorter
  prefixes such as `en-US` → `en`, then the first tag extending a bare language
  such as `en` → `en-GB`), then the media type from `Accept` within it, and
  sends `Content-Language` and `Vary: Accept, Accept-Language`. An optional
  language-neutral group answers when nothing matches or no language is asked
  for; without one, an unmatched request gets `406 not-acceptable` and a
  request with no `Accept-Language` gets the first tag alphabetically. Each
  locale may have its own status, but every file of one locale shares one
  status. Tags and media types are case-insensitive, so two files for the same
  locale and media type are rejected (`duplicate-representation`).
- **Bodyless statuses** `204`, `205`, and `304` use a bare, empty file named
  just the status, e.g. `DELETE/204`; it must be the only response without a
  locale.
- **`accepts.yaml`** makes a method refuse request bodies of other media types:

  ```yaml
  accepts: [application/json, multipart/form-data]
  allowMissingContentType: application/json # optional: accept a body with no Content-Type
  ```

  A non-empty body whose `Content-Type` (type and subtype, parameters ignored)
  is not listed, or that has no `Content-Type`, gets `415
unsupported-media-type` with `Accept-Post` (POST) or `Accept-Patch` (PATCH).
  A malformed `Content-Type` is `400`. Without `accepts.yaml`, any body is
  accepted. Wildcards, parameters, duplicates and unknown keys are startup
  errors.

- **Header sidecars** (`201.headers.json`) hold a JSON object of header names to
  a string or array of strings (one field line per element, so several
  `Set-Cookie` values replay in order). A sidecar applies to every file of its
  status. Hop-by-hop headers, control characters (CR, LF, NUL, …) in values and
  `X-Mock-*` names (reserved for Janus) are rejected. Any other text is allowed
  and is sent as its UTF-8 bytes, as written in the file. `Content-Length`, `Date` and `Content-Encoding` are
  computed by Janus: a sidecar value is dropped with a warning. Everything else
  (`Location`, `ETag`, `Cache-Control`, `Set-Cookie`, other `X-` headers, …) is
  replayed as written. Redirects (`3xx` except `304`) must set `Location`.
- **`Content-Type` in a sidecar**: repeating the file name's media type is a
  `redundant-content-type` warning; adding parameters
  (`application/json; charset=utf-8`) is sent as written; a different media
  type is an override (warning `content-type-override`) that is sent instead,
  while `Accept` still selects the file by its name and the response carries
  `X-Mock-Representation` with the original. It is an error for a bodyless
  status or a status with several media types.
- **Ignored files**: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.gitkeep`,
  `.keep`, `._*`, `*~`, `.*.swp`, and `.*.swo` are skipped everywhere. Any other
  unexpected file is a startup error. Symbolic links inside the tree are
  rejected.

### Scenarios

Every directory under the data root is a **scenario**. `default` is the root;
any other scenario inherits from a parent and declares what it changes in an
optional `flow.yaml` (the only file allowed directly in a scenario directory):

```yaml
# data/sold-out/flow.yaml
description: Every product is sold out, so the product list is empty.
extends: default # the default; a chain may be at most 16 deep
ids: # literal values shown in the Atlas, merged down the chain
  cartId: cart_sold_out
overrides: # endpoint keys whose inherited files are all dropped
  - /v1/products/GET
removes: # inherited files dropped one by one
  - /v1/greeting/GET/200_[fr].json
```

A scenario starts from its parent's effective tree, applies `overrides`, then
`removes`, then its own files: each one replaces the inherited file with the
same status, locale and media type (whatever its spelling), or adds a new one.
A header sidecar goes with its response file. A reference to a file or
endpoint the parent does not have, the same key in both lists, an unknown
parent and a cycle are startup errors, and every fixture rule runs on each
scenario's effective tree, naming the scenario. `examples/data` has
`sold-out` and its child `sold-out-en`.

A request is served from exactly one scenario, picked by the first of:
`X-Mock-Scenario: <name>`, the request's session's pin (see
[Sessions](#sessions)), `scenarios.default` / `--scenario`, then `default`. A
name that is not a scenario is `400 unknown-scenario` with the `source` that
named it and the `known` names; Janus never falls back to another scenario.
Responses carry `X-Mock-Scenario` (the selected scenario) and, when a fixture
answered, `X-Mock-Resolved-From` (the scenario whose file answered).

```sh
curl -H 'X-Mock-Scenario: sold-out' http://127.0.0.1:4010/v1/products   # []
```

`POST /_janus/scenarios` with `{ "name": "sold-out", "extends": "default" }`
creates a scenario: it writes `<fixtures.root>/sold-out/flow.yaml` holding
only `extends` (default: `scenarios.default`), reloads, and answers `201`
with `{ "name", "extends", "reload" }` once the reload has finished. A bad
body is `400 atlas-invalid-request`, a name outside the scenario grammar
`422 scenario-invalid-name`, an existing scenario or directory
`409 scenario-exists`, and an unknown parent `422 unknown-scenario`. It
writes the way [Promotion](#promotion) does, so it is available when
promotion is and otherwise `501 promotion-unavailable`; a browser may call
it only from a trusted origin.

### Dynamic values

JSON, text and header-sidecar fixtures may contain **tokens** that are
rendered when the fixture is served: dates relative to a clock, values echoed
from the request, and deterministic generated values.

```json
{
  "id": "{{$path.productId}}",
  "name": "{{$faker.commerce.productName}}",
  "restockDate": "{{$today+14d}}",
  "updatedAt": "{{$now}}"
}
```

```sh
curl -H 'X-Mock-Now: 2026-01-01T00:00:00Z' http://127.0.0.1:4010/v1/products/p-42
# {"id":"p-42","name":"…","restockDate":"2026-01-15","updatedAt":"2026-01-01T00:00:00Z"}
```

The syntax is `{{$ base [offset…] [@timezone] [:format] [:unique] }}`.
Whitespace inside the braces is ignored, a token ends at the first `}}`, and
`{{$$` writes a literal `{{$`. Tokens never read another field, do arithmetic
on data, or branch.

**Where**: JSON bodies (`application/json`, `+json`) inside string values;
text bodies (`text/*`, `application/yaml`, `application/xml`, `+xml`,
`application/x-www-form-urlencoded`) anywhere; replayed header-sidecar values.
Never in binary bodies, object keys, file names, `accepts.yaml`, or
`Content-Type` and Janus-computed headers (a token there is an error). Text
bodies must be valid UTF-8 (`invalid-text-body`).

**Whole-value typing (JSON)**: a string that is exactly one token takes the
token's natural type — `"{{$randomInt(1,5)}}"` becomes `3`, `"{{$now:unix}}"`
a number, `"{{$body.$.customer}}"` whatever JSON the path selects. Any other
string is interpolated. A dynamic JSON body is re-serialised compactly, in
source key order; a JSON body without tokens is replayed byte for byte.

| Base                                    | Renders                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `now`                                   | the instant, RFC 3339 UTC: `2026-09-15T14:22:08Z` (offset form with an `@zone`) |
| `today`                                 | the date in the active timezone: `2026-09-15`                                   |
| `tomorrow`, `yesterday`                 | `today+1d`, `today-1d`                                                          |
| `oneWeekFromToday`, `oneWeekAgo`        | `today+1w`, `today-1w`                                                          |
| `oneMonthFromToday`, `oneYearFromToday` | `today+1mo`, `today+1y`                                                         |
| `startOfDay`, `endOfDay`                | `now` snapped to `00:00:00` / `23:59:59.999`                                    |
| `startOfMonth`, `endOfMonth`            | `today` snapped to the first / last day                                         |
| `epoch`                                 | `now:unix`                                                                      |
| `path.<name>`                           | a bound path parameter of the fixture's route (checked at load)                 |
| `query.<name>`                          | the first value of a query parameter                                            |
| `header.<name>`                         | the first value of a request header, case-insensitive                           |
| `body.<JSONPath>`                       | the first match in a JSON request body, e.g. `body.$.customer.name`             |
| `method`                                | the request method                                                              |
| `uuid`, `ulid`                          | a v4-shaped UUID; a ULID whose time part is the render instant                  |
| `randomInt(min,max)`                    | an integer in `[min, max]` (base-10 safe integers)                              |
| `randomFrom(a,b,…)`                     | one of the JSON scalar literals: `randomFrom("a", 2, true, null)`               |
| `randomBool`                            | `true` or `false`                                                               |
| `faker.<module>.<method>`               | a `@faker-js/faker` generator without arguments, e.g. `faker.person.fullName`   |

**Offsets** chain left to right with explicit signs — `{{$today+1mo-1d}}`,
`{{$now+2h15min}}` — in `ms`, `s`, `min`, `h`, `d`, `w`, `mo`, `y` (`m` is not a
unit). `mo` and `y` clamp to the month's last day (`2026-01-31+1mo` is
`2026-02-28`). On `now`, `d` and smaller are exact durations; on `today` they
move the calendar date. **Timezones**: `@Asia/Tokyo` overrides
`dynamic.timezone` for one token. **Formats**: `:date`, `:datetime`, `:time`,
`:unix`, `:unixMillis`, `:http` (always GMT), or a quoted pattern such as
`:"dd/MM/yyyy"` using `yyyy yy MM M dd d HH H mm ss SSS EEE MMM XXX`, with
`'literal'` text. Offsets, zones and formats apply only to clock values.
Custom aliases come from `dynamic.aliases`.

**Missing request values** render as `null` (whole value) or `""` (embedded);
with `dynamic.strictRefs: true` they are `500 render-failed`. A JSON-typed
request body that a token reads but that is not valid JSON is
`400 invalid-request`. A rendered header value containing CR, LF or NUL is
`500 render-failed`, never a written header.

**Determinism**: every generated value is a pure function of the seed, the
render instant, the method, route template, path parameters, sorted query and
canonical body (never headers), the fixture, and the token's location and text.
A JSON body nested more than 1000 levels deep is hashed as its bytes, and a
`$body` token cannot read it (`400 invalid-request`).
The same request with the same seed and frozen clock returns the same bytes
under any concurrency; another path parameter, query or body gives other
values, and two `{{$uuid}}` tokens differ. `:unique` on a generator opts out
and draws fresh entropy each time.

**Mistakes fail at load**, located with a suggestion where one is close:
`unknown-dynamic-token` (`{{$tommorow}}` → did you mean `tomorrow`?),
`invalid-dynamic-token`, `unknown-timezone`, `unknown-path-parameter`,
`impure-faker-path` (unknown, needs arguments, or reads the date),
`invalid-alias`, `invalid-text-body`, and `invalid-json` for a key repeated
within one object of a JSON body with tokens. A JSON body made only of tokens
is the warning `fully-dynamic-fixture`.

### The clock

A request renders against, in order: the caller's `nowMs` (direct engine
calls), an `X-Mock-Now: <RFC 3339 instant>` request header, its session's
clock (see [Sessions](#sessions)), `dynamic.now` / `--now` (frozen, or
advancing in `offset` mode), then the wall clock.
`X-Mock-Now` must occur once with a valid instant, or the request is
`400 invalid-request`; fixtures without tokens ignore it.

`X-Mock-Nondeterministic: true` marks a response that contains a `:unique`
token, or whose clock or generated values come from a moving (live or
`offset`) clock. A response is byte-reproducible when its instant is frozen and
the seed is known. `diagnostics.headers: false` removes the header.

### Sessions

A session lets one caller pin a scenario and a clock without affecting anyone
else. A request's session is named by `X-Mock-Session: <id>` (1–128 of
`A-Z a-z 0-9 . _ ~ -`; `default` and the `k_` prefix are reserved), or else
by the first `sessions.keyFrom` header or cookie it carries, hashed into a
`k_…` ID so the credential is never stored. A request with neither uses the `default` session, which holds
nothing.

```sh
# Create session a, pinned to sold-out with a frozen clock; keep the write key.
curl -i -X POST http://127.0.0.1:4010/_janus/session -H 'X-Mock-Session: a' \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"sold-out","clock":{"now":"2030-01-01T00:00:00Z"}}'
# 201, with X-Mock-Session-Key: wk_…

curl -H 'X-Mock-Session: a' http://127.0.0.1:4010/v1/products   # sold-out, rendered at 2030-01-01
curl -X PATCH http://127.0.0.1:4010/_janus/session -H 'X-Mock-Session: a' \
  -H 'X-Mock-Session-Key: wk_…' -H 'Content-Type: application/json' -d '{"clock":{"advance":"+1d"}}'
curl -X DELETE http://127.0.0.1:4010/_janus/session -H 'X-Mock-Session: a' -H 'X-Mock-Session-Key: wk_…'
```

- `POST /_janus/session` creates the caller's session and returns its write
  key once, in `X-Mock-Session-Key`. Both `scenario` and `clock` are optional;
  `clock` is `{"now": …, "mode": "frozen" | "offset"}` (`frozen` by default;
  `offset` advances with the wall clock; one that runs past the end of the
  Date range is `409 no-session-clock` until it is bound again). An existing
  session is
  `409 session-exists`; a request with no session key is
  `400 session-required`; one more than `sessions.max` is `503 session-limit`.
- `PATCH` changes only the members it sends (`null` clears one;
  `{"clock":{"advance":"+1d"}}` moves the bound clock), and `DELETE` drops
  the session. Both need the key: a wrong or missing key is
  `403 session-forbidden` and changes nothing. A lost key cannot be
  recovered; the session then ends when it expires.
- `GET /_janus/session` describes the caller's session without the key. A key
  that names no session is served as an empty session and stores nothing.
- Sessions live in memory: they expire `sessions.idleTimeout` seconds after
  their last request, survive a reload, and end with the server. A pin naming
  a scenario a reload removed answers `400 unknown-scenario` with source
  `session` until it is changed or dropped.
- Every session write is logged (`janus session-write …`), without the key.

### Choosing between responses

One method directory can hold several named responses, and small YAML files
beside them decide which one a request gets.

**Variants.** A variant name goes before the extension: `200.empty.json`,
`404.missing.json`, `200_[fr].empty.json`, `304.fresh` (bodyless), with its
headers in `200.empty.headers.json`. A name is lowercase words of letters and
digits joined by `-`, at most 32 bytes; `headers`, `meta` and file extensions
such as `json` are reserved. `200` and `200.empty` are **identities**; each
negotiates locale and media type. A method needs at
least one plain response, and plain fixture IDs are unchanged by variants.

**Control files**, beside `accepts.yaml`, inherited and replaced whole like it:

```yaml
# variants.yaml: the first rule whose conditions all hold chooses
rules:
  - when: { path.orderId: ord-missing }
    serve: 404.missing
  - when: { header.if-none-match: { matchesETag: '"o-v2"' } }
    serve: 304.fresh
  - when: { query.express: 'true' } # a rule sequence: one step per request
    serve: [202.pending, 200.shipped]
```

```yaml
# pages.yaml: the request's value picks a page; pages hold no state
by: query.page
whenAbsent: '1'
pages:
  '1': 200
  '2': 200.page-2
otherwise: 200.empty
```

```yaml
# sequence.yaml: each session steps through; the last step repeats
steps: [202.pending, 202.pending, 200]
```

```yaml
# expect.yaml: checked after accepts.yaml
expect:
  header.idempotency-key: { present: true }
  body.$.orderId: '{{$scenario.ids.orderId}}'
  body.$.amount.currency: EUR
onMismatch: 400.unexpected # optional; without it, 422 expectation-failed
```

- **Conditions** read `path.<name>`, `query.<name>`, `header.<name>`,
  `cookie.<name>`, `body.<JSONPath>` and `contentType`, and test a literal,
  `in: [...]`, `present: true|false`, a range (`gt`, `gte`, `lt`, `lte`) or
  `matchesETag` (on `header.if-none-match` only, weak comparison, `*`
  matches). All conditions of a rule must hold. Literals for non-body
  references are strings (`'2'`, not `2`); body literals match by JSON type.
  A literal may be one `{{$scenario.ids.<name>}}` token.
- **Order**: replay, then `expect.yaml`, then rules, `pages.yaml`,
  `sequence.yaml`, and finally every plain response, negotiated as before. A
  control's identity is final: if it has no acceptable representation the
  answer is `406`, even with `onUnacceptable: ignore`.
- **Sequences** keep a position per session, scenario, endpoint and sequence.
  A `GET` or other request advances the sequence that chose its response;
  `HEAD`, the explorer and requests without a session never do, so anonymous
  callers always get step 1. Positions survive a reload unless the sequence
  (its steps, or its rule's number or conditions) changed.
  `DELETE /_janus/sequences` (with `X-Mock-Session` and its
  `X-Mock-Session-Key`; `?endpoint=<ep_…>` for one endpoint) restarts the
  caller's own positions.
- **Load checks**: every identity a control names must exist
  (`unknown-identity`, with a suggestion), every `path.<name>` must be a
  route parameter, every `$scenario.ids` name must exist in each scenario that
  uses the file (`unknown-scenario-id`), and `pages.yaml` and `sequence.yaml`
  cannot share a method (`conflicting-controls`). Mistakes in a control file
  are `invalid-control`, with a line and column.
- **New tokens**: `{{$scenario.name}}`, `{{$scenario.ids.<name>}}` and, in a
  method with a sequence, `{{$sequence.position}}`.
- **Replay**: a session that repeats a `POST` or `PATCH` with the same
  `Idempotency-Key` (1–255 visible ASCII characters) gets the stored fixture
  response back byte for byte, with `X-Mock-Replayed: true`; the same key on a
  different request is `422 idempotency-key-reused`. Errors are never
  stored, and nothing is stored without a session.
- **Diagnostics**: fixture responses carry
  `X-Mock-Choice: 200.shipped; by=rule; rule=3; step=2` (`by` is `rule`,
  `page`, `sequence`, `expect` or `plain`). The trace's `choice`, `expect`,
  `sequence` and `replay` say what decided; none of them holds a request
  value.

### Recording

Recording forwards chosen requests to a real API, relays its answer, and keeps
the exchange under `captures/` for review. Use it only against dev, test or
staging backends with no real data. Captures are never served: Janus answers
from fixtures alone, and a capture becomes a fixture only when it is
[promoted](#promotion).

```yaml
# janus.config.yaml
recording:
  captures: ./captures # relative to this file; flag: --captures
  endpoints: # the allowlist; empty (the default) disables recording
    - method: POST
      path: /v1/carts/{cartId}/items
      upstream: https://staging.api.example.com/shop
```

```sh
curl -X POST -H 'X-Mock-Record: true' -H 'X-Mock-Scenario: payment-declined' \
  -H 'Content-Type: application/json' -d '{"sku":"s-1"}' \
  http://127.0.0.1:4010/v1/carts/c-9/items
# → the upstream's answer, relayed, with X-Mock-Recorded: payment-declined/3f9a0c1e
```

- **Opt-in per request.** Only `X-Mock-Record: true` forwards; `false` or no
  header resolves from fixtures as before, and anything else is
  `400 invalid-request`. Recording happens after scenario selection and skips
  everything after it: no fixture, rule, sequence, replay or session state is
  read or changed.
- **The allowlist.** A request is forwarded only when its method and
  normalised path match an entry of `recording.endpoints` (template
  grammar, no overlaps, at most 256). Anything else, and every `HEAD`, is
  `403 recording-not-allowed` with no DNS lookup or connection. The URL is the
  entry's `upstream` (origin and optional base path), the canonical path and
  the raw query, so a request can never choose another host.
- **Header forwarding.** Every header is forwarded as sent, `Authorization`
  and `Cookie` included, except hop-by-hop headers and those named in
  `Connection`, `Host`, `Content-Length`, `Expect`, `Forwarded`, `Via`,
  `X-Forwarded-*` and `X-Mock-*`; `Accept-Encoding: identity` replaces the
  caller's. Redirects are relayed, not followed.
- **The relayed response** keeps the upstream's status, headers and body,
  except hop-by-hop and `X-Mock-*` headers and those that would act on the
  Janus origin: `Set-Cookie`, `Clear-Site-Data`, `Strict-Transport-Security`,
  `Alt-Svc`, the reporting headers and `Access-Control-*`. Janus computes
  `Content-Length`, `Date` and `X-Janus-Request-Id` itself.
  `WWW-Authenticate` and `Authentication-Info` are relayed. With
  `diagnostics.headers` on, it carries `X-Mock-Scenario` and
  `X-Mock-Recorded: <scenario>/<exchange>` (or `failed`).
- **Failures**: `501 recording-unavailable` (no upstream or capture store in
  this mode), `503 recording-busy` (`recording.maxConcurrent` exchanges, default
  4, are in flight), `500 recording-capture-failed` (no exchange ID could
  be claimed; nothing is forwarded), `502 recording-upstream-failed` (DNS,
  connection or TLS), `504 recording-upstream-timeout` (`recording.timeoutMs`,
  default 30000, over the whole exchange) and `502 recording-response-too-large`
  (`recording.maxResponseBytes`, default 10 MiB). None quotes the upstream's
  error text. A `recording-upstream-failed` error and its `log.jsonl` line carry
  a `reason` from a fixed list: `dns`, `refused`, `unreachable`,
  `connect-timeout`, `reset`, `certificate`, `tls`, `invalid-response`,
  `invalid-request` or `unknown`. The error text itself goes only to the server
  log, as an `upstream-failed` line with the method, origin, path (never the
  query), reason and error code; `janus run` prints it to stderr.
- **Startup checks**: `captures-inside-fixtures` when the captures directory
  and `fixtures.root` overlap, also through links; `captures-not-writable`;
  `recording-non-loopback` unless `recording.allowNonLoopback: true`, which
  raises the `recording-exposed` warning instead; `capture-incomplete` for an
  exchange directory with no log line, older than `recording.timeoutMs`.
  `janus validate` creates nothing.

The capture layout, one directory per scenario and one per exchange:

```text
captures/
└── payment-declined/
    ├── log.jsonl              one line per exchange, in the order they completed
    └── 3f9a0c1e/
        ├── request.json       the request as received: method, target, params, headers, body
        ├── 402.json           the response body, named like a fixture response file
        ├── 402.headers.json   the response headers a fixture sidecar can hold, Set-Cookie included
        └── 402.meta.json      provenance: when, how long, the registration, a SHA-256 digest, notes
```

Captures hold whatever the exchange carried, credentials included, with no
redaction. Keep them out of version control: add `captures/` to
`.gitignore`. Each exchange gets a random ID of eight hex digits, claimed by
creating its directory before the upstream call, so one ID cannot be guessed
from another and processes sharing the directory never share one. Captures
made by older versions keep their six-digit numbers and are read as before. A
failed exchange keeps its empty directory and a log line saying why.

`DELETE /_janus/captures/<scenario>/<exchange>` deletes a capture, a failed
one too: its log lines go first, then its directory. Files promoted from it
are copies and stay as they are; `GET /_janus/promotions` marks them
`captureExists: false`, and the UI shows the capture as deleted. Nothing records
deletions: a capture that is gone simply does not exist.

### Promotion

Promotion turns a capture into an ordinary fixture, written where a
hand-written one would be, then reloads. It is available when recording is
on (`recording.endpoints` is not empty) and the fixture root is writable.

```yaml
# data/payment-declined/flow.yaml
overrides: [/v1/payments/POST]
ids:
  paymentId: pay_declined_1
```

```sh
curl -X POST -H 'Content-Type: application/json' http://127.0.0.1:4010/_janus/promotions \
     -d '{"capture":"payment-declined/3f9a0c1e","ids":{"paymentId":"pay_8f2e91c0"}}'
# → 201, files written, snapshot reloaded
```

```text
data/payment-declined/v1/payments/POST/
├── 402.json            "id": "{{$scenario.ids.paymentId}}"
├── 402.headers.json
└── 402.meta.json       capture payment-declined/3f9a0c1e, review: pending
```

- **The request**: `capture` (required), and optionally `scenario` (default:
  the capture's), `path` (a route template; default: the registration's),
  `variant`, `ids` (declared name to captured value), `replace` (files that
  may be replaced, each `{ "file", "digest" }`), `body` and `headers` (the
  response body as text and the response headers, edited before promoting;
  IDs are rewritten in them as usual and the provenance notes the edit) and
  `dryRun: true`, which
  plans, validates and shows the bytes without writing. A dry run answers
  `200` with `applicable`; a promotion answers `201` with the files written
  and the reload result.
- **Where it goes**: the method directory under the route template, so a
  capture of `/v1/products/p-8812` lands in `v1/products/{productId}/GET/`,
  with literal segments in the router's canonical form and the response
  named by the fixture grammar. A template that would clash with an existing
  route is `422 promotion-template-conflict`.
- **ID rewriting**: values the target scenario declares in `flow.yaml` `ids`
  become `{{$scenario.ids.<name>}}` tokens, in JSON string values, in text
  lines that are a whole URL or path, and in header values. A rewrite is
  `exact` (it filled a path parameter or you named it) or `inferred` (a JSON
  member of the same name); a value seen inside other text is only a
  suggestion. Values that are not rewritten are listed with a reason:
  shorter than 4 characters, bound twice, a JSON number or key, or a binary
  body. Existing `{{$` text is escaped, so captured bytes never render as
  tokens. An `ids` name the scenario does not declare is
  `422 promotion-unknown-id`.
- **Protecting files**: an existing file is `promoted` (its digest still
  matches its provenance), `modified` or `hand-written`. Only a `promoted`
  file is replaced without being named in `replace`; a `modified` or
  `hand-written` one needs its current digest. Otherwise nothing is written
  and the answer is `409 promotion-conflict`, listing each file and why. An
  existing header sidecar is kept, with a note, unless it is replaced.
- **The result is validated first**: the whole tree, with the new files, must
  pass the startup checks (`422 promotion-invalid-tree`, with the problems and
  a hint such as adding the endpoint to `overrides`). Files are written to
  temporary names, checked again and moved into place together; a failed
  write leaves the tree as it was (`500 promotion-write-failed`). Without
  recording or a writable root, promotion is `501 promotion-unavailable`.
- **Provenance**: each identity gets `<identity>.meta.json`
  (`janus.provenance.v1`) with an entry per promoted file: the capture, when,
  a SHA-256 digest, the review state and every rewrite, suggestion, refusal
  and note as a location and code, never a value. It is loaded and checked
  (`invalid-provenance`) but never served; `.janus-*.tmp` files are ignored.
- **Modes**: `promotion.mode: staged` (the default) waits for someone to
  promote. With `auto`, every successful capture is promoted into its own
  scenario before it is relayed, replacing only `promoted` files, and
  `X-Mock-Promoted` says `promoted`, `skipped` or `failed`; startup then needs
  a writable fixture root (`fixtures-not-writable`).
- **Review**: every promoted file starts `pending`. `POST
/_janus/promotions/review` with `{ "scenario", "files": [{ "file", "digest" }] }`
  marks files reviewed if their digest still matches what the reviewer saw;
  editing `review` in the provenance file does the same in a commit. Pending
  files are the warning `promotions-pending`; `janus validate
--require-reviewed` reports each as the error `promotion-unreviewed`, so CI
  can block unreviewed fixtures. A provenance entry whose file was deleted is
  the warning `stale-provenance`.

### Faults and transport

Janus can make the network misbehave the way a real one does, and handles the
transport details real clients use.

**Faults.** A method directory may hold `fault.yaml`, a control file inherited
like `variants.yaml`:

```yaml
# data/flaky-network/v1/payments/POST/fault.yaml
latency: { ms: 1500 }
rules:
  - when: { header.x-simulate: reset }
    fault: reset
  - when: { header.x-simulate: cut }
    fault: { truncate: { bytes: 16 } }
  - when: { header.x-simulate: broken }
    fault: { malformed: conflicting-length }
  - when: { header.x-simulate: retry }
    fault: [reset, timeout, none] # a fault sequence: one step per request, per session
```

- The first rule whose conditions all hold decides. `reset`
  resets the TCP connection; `timeout` holds it open without answering for
  `faults.timeoutMs`, then closes it; `truncate` cuts the response after
  `bytes` of body (half of it without `bytes`); `malformed` sends a
  `status-line`, `header-line`, `conflicting-length` or `bad-chunk` response
  that is not valid HTTP/1.1; `none` answers normally (in sequences only).
- A fault sequence steps per session, like `sequence.yaml`; the default
  session always gets the first step. `DELETE /_janus/sequences` restarts it.
- `reset` and `timeout` change nothing but the fault step: no sequence
  advances and no replay is stored. `truncate` and `malformed` break the
  response Janus would have sent, with all its effects.
- Faults are described, never performed, by the explorer, and
  `faults.enabled: false` turns every fault and delay off.

**Latency.** The delay before the first byte comes from the method's
`fault.yaml`, else the scenario's `flow.yaml` (`latency: { min: 200, max: 800 }`,
inherited), else `faults.latency`. A range is drawn from the seed and the
request, so the same request waits the same time. Responses carry
`X-Mock-Latency` and, for a fault, `X-Mock-Fault`.

**Compressed requests.** A body with `Content-Encoding: gzip`, `deflate`, `br`
or a list of them is decoded before matching, so `body.` conditions, tokens,
the fingerprint and the explorer see the decoded bytes. An unknown coding is
`415 unsupported-content-encoding` with `Accept-Encoding`; corrupt or trailing
data is `400 invalid-request`; a body larger than `limits.maxDecodedBodyBytes`
once decoded is `413 decoded-body-too-large`, found without decoding it all.
Recording forwards the bytes as received and stores the decoded body in
`request.json` with its `codings`.

**Compressed responses.** Fixture responses and replays of at least
`compression.minBytes` are compressed with the best coding the request's
`Accept-Encoding` allows, with `Content-Encoding`, `Vary: Accept-Encoding` and
a weak `ETag`. `HEAD` gets `GET`'s headers.

**`Expect: 100-continue`.** Janus checks the request head first: size,
`Content-Encoding`, route, method and `accepts.yaml`. A refusal is the final
response, sent with `Connection: close` before the body is read; otherwise
Janus sends `100 Continue`. Any other expectation is `417 unsupported-expectation`.

**`OPTIONS`.** A method with no `OPTIONS` directory is answered `204` with
`Allow` (which lists `OPTIONS` too), or `404` under `onUnknownMethod: 404`.
`server.autoOptions: false` restores the `405`.

**CORS for fixture routes.** For a page under test on another origin, list it:

```yaml
cors:
  fixtures:
    origins: ['http://localhost:5173']
    credentials: false
```

A listed origin's preflights succeed for any route and method some scenario
serves, and every fixture-path response, errors included, gets
`Access-Control-Allow-Origin`, `Access-Control-Expose-Headers` (so the page can
read `ETag`, `Location` and `X-Mock-*`) and `Vary: Origin`. A header sidecar's
own `Access-Control-*` headers are then dropped with the warning
`cors-header-ignored`. Recorded relays get no CORS headers, and a preflight
for `X-Mock-Record` is refused.

**XML request bodies.** `application/xml`, `text/xml` and `+xml` bodies are
read for `body.` references: `<order id="o-7"><item sku="a"/></order>` reads
as `{"order":{"@id":"o-7","item":{"@sku":"a"}}}`, so
`body.$.order.@id` works in conditions and `{{$body.$.order.@id}}` in
fixtures. Every value is a string; prefixes are dropped; a repeated element is
an array. A `DOCTYPE`, an unknown entity, nesting deeper than 64, more than
10 000 nodes or a non-UTF-8 body is `400 invalid-request`.

The `flaky-network` example scenario (`examples/data/flaky-network`) shows
latency and every fault kind.

### Request runner

The request runner sends saved requests, one at a time or a whole
collection in order, to Janus's own fixtures (**Mock** mode) or to a dev,
test or staging backend, either without keeping anything (**Upstream** mode)
or writing each exchange as a capture (**Record** mode). It can also ask what
the mock would answer without serving anything (**Explore**). Requests are YAML files in your
project, so they live in git next to the fixtures. You use them from the
**Requests** page of the Atlas UI, from `janus run`, and from the desktop
app's **File › Import Collection…**.

The runner is on when `runner.root` (default `./requests`, flag
`--requests`) exists, and only on a loopback listener: it sends requests to
any URL its files name, so `runner.allowNonLoopback: true` is needed to use
it on another address, and Janus then warns `runner-exposed`. On a
non-loopback listener without it, the Requests page keeps only Explore and
untitled requests, and every runner route answers `404`.

An upstream with a self-signed certificate or a private CA is trusted by
listing its PEM file in `runner.extraCaCerts`. `runner.skipTlsVerify: true`
instead accepts any certificate, unverified. Both apply to the runner's Upstream and Record modes,
`janus run` and recording.

Record mode replaces a request's `Accept-Encoding` with `identity`, so each
capture holds an uncompressed body. Mock and Upstream modes send it as
written; a compressed answer is shown, extracted from and tested decoded.

#### Request files

```text
requests/
├── environments/                     ← shared by every collection
│   ├── staging.yaml
│   └── staging.local.yaml            ← values kept out of git (optional)
└── checkout/                         ← a collection
    ├── folder.yaml                   ← collection settings (optional)
    ├── 010-create-cart.request.yaml
    └── payments/                     ← a folder (up to 8 deep)
        ├── folder.yaml
        └── 010-pay.request.yaml
```

Requests run in name order, so imports and **New request** add a number
prefix. A request file:

```yaml
name: Create cart
method: POST
url: '{{baseUrl}}/v1/carts'
headers:
  - name: Authorization
    value: 'Bearer {{token}}'
body:
  type: json # or text, xml, form, multipart, file, graphql
  text: '{ "currency": "EUR" }'
vars:
  currency: EUR
extract:
  cartId: '{{$response.body.$.id}}'
scripts:
  after: |
    pm.test('created', () => pm.response.to.have.status(201));
docs: Creates an empty cart.
```

`pathParams` fills `:name` segments of the URL; `route` names the fixture
route a capture goes to when the URL alone can't tell (`/v1/carts/{cartId}`).
`folder.yaml` holds `name`, `vars`, `headers` and `scripts` that every
request below it inherits, plus `stripPrefix` (removed from the URL path
for mock mode and captures). A collection's `folder.yaml` can also set
`cookies: false` to turn off the run's cookie jar and `environment: <name>`,
the environment the Requests page picks when you open one of its requests
(runs and `janus run` use only the environment they are given; a name with
no environment yet is the warning `requests-unknown-environment`).

Environments are shared by every collection and saved on their own in
`requests/environments/`, so `environments` is never a collection name.
`environments/<name>.yaml` holds `name`, `vars` and an optional `disabled`
list of variable names that stay in the files but are not used, as if the
environment did not define them (names no file defines are ignored). Values
in `<name>.local.yaml` are merged over them and never written to the shared
file; the environment tab's **Sensitive** eye toggle masks a value and moves
it there, and each row's checkbox adds it to or takes it from `disabled`. A
collection's `folder.yaml` can name a preferred `environment`, picked when one
of its requests opens. `default: true` in an environment's `.yaml` makes it
the default, picked until you pick another; the star on the environment's tab
sets it (runs and `janus run` ignore it). An `environments/` folder inside a collection, where earlier versions
kept them, is not read: Janus warns `requests-collection-environments`;
move its files to `requests/environments/`. Add this to your `.gitignore`:

```text
*.local.yaml
```

#### Variables

`{{name}}` is looked up in this order: run variables (set by `extract`,
scripts and `--var`), the request's `vars`, the environment, then each
folder's `vars` from the nearest out to the collection. Dynamic values
work too (`{{$uuid}}`, `{{$now}}`, …) with the real clock and fresh random
values, and `{{$$` writes a literal `{{$`. A variable defined nowhere fails
the step as `unresolved-variable`. In the editor, the variables a field uses
are listed under it with the value and scope each resolves to.

#### Passing values between requests: `extract`

`extract` sets run variables from the exchange after the response arrives,
before `after` scripts. The later requests of the run see them.

| Source                                                                                                                | Value                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `$response.status`                                                                                                    | the status code, a number                             |
| `$response.header.<name>`                                                                                             | the first value of a response header                  |
| `$response.cookie.<name>`                                                                                             | a cookie the response set                             |
| `$response.body.<JSONPath>`                                                                                           | the first match in a JSON body, keeping its JSON type |
| `$response.text`                                                                                                      | the whole body as text                                |
| `$response.timeMs`                                                                                                    | the elapsed time                                      |
| `$request.header.<name>`, `$request.query.<name>`, `$request.path.<name>`, `$request.body.<JSONPath>`, `$request.url` | the request as sent                                   |

The long form adds `match` (a regular expression; the first group wins),
`optional: true` (leave the variable unset when the value is missing) and
`default`:

```yaml
extract:
  cartId: '{{$response.body.$.id}}'
  etag:
    value: '{{$response.header.etag}}'
    match: '"(.*)"'
    optional: true
```

Every missing value is reported together as `extract-missing`, and the step
fails. In the response panel, **Save as variable** on a JSON value or a
header adds the entry for you.

#### Scripts

`scripts.before` runs before the request is sent and may change it;
`scripts.after` runs when the response arrives. Scripts run in a sandbox (a
separate JavaScript engine compiled to WebAssembly) with no network, files
or timers, bounded by `runner.scriptTimeoutMs` and
`runner.scriptMemoryBytes`. Before scripts run from the collection inward
to the request; after scripts from the request outward. `expect` (chai) is
available, and both tools'
APIs work:

- **Postman:** `pm.variables`, `pm.environment`, `pm.collectionVariables`,
  `pm.request`, `pm.response`, `pm.test`, `pm.expect`, `pm.info`,
  `tests[name]`.
- **Bruno:** `bru` (`getVar`, `setVar`, `getEnvVar`, `setEnvVar`,
  `interpolate`, …), `req`, `res` and `test`.

Setting any variable sets a run variable; files never change during a run.
`pm.sendRequest`, `setNextRequest` and cookie jars are refused with
`script-unsupported`. A failed test fails the step after its scripts.

#### Runs

A run walks its target (a collection, folder or request) depth first in
name order and stops at the first failing step; the rest are `not-run` and
nothing is sent for them. In **Record** mode each request goes to its real
URL with no redirects followed, using `recording.timeoutMs`,
`recording.maxResponseBytes` and `recording.maxConcurrent`, and each
exchange is written as a capture with `source: "runner"` into the run's
scenario. Captures promote like any other, and promotion works
whenever the runner is available, without `recording.endpoints`. In
**Mock** mode Janus answers each request itself, in the run's scenario,
with the URL's origin (and `stripPrefix`) removed. Each run has its own
cookie jar.

Runs are kept in memory (`runner.keepRuns`); at most `runner.maxActiveRuns`
run at once.

The Requests page has a side panel that switches between **Collections**
and **Environments** and folds away (Ctrl/⌘ + [; Ctrl/⌘ + ] folds the
inspector on the right, and on Endpoints the same keys fold the list and
Details), with a hotbar at its foot: **New
request**, **New collection**, **Import** and **Runs** on keys 1 to 4 (Ctrl/⌘

- K finds these and any request by name). Requests, collections, folders and
  environments open in editor tabs. **New request** opens a blank
  **Untitled-N** tab with the headers of the tab that was in front; **Save to
  collection** names it and picks the collection or folder. A collection or
  folder runs from its menu: right-click it, or its ⋯ button, for **Run**,
  **Explain**, **New request here**, **New folder**, settings and **Delete**.
  The Requests page is the home page (`#/`); the endpoint list is at
  `#/endpoints`. The page has two modes. **Explore** explains what
  the mock would answer, at an optional **Render at** instant, and sends
  nothing. **Live** (the default) sends, to the **Send to** choice: Mock, Upstream (the default) or Record
  (which says the scenario it records into). The scenario is picked in the
  header's scenario picker, whose **+** creates a new one (a `flow.yaml` that
  inherits from the scenario you pick). A picked scenario is used as if the
  request carried `X-Mock-Scenario`; on the configured default Janus decides
  (a session pin, else `scenarios.default`). The page refuses an
  `X-Mock-Scenario` header row and points you to the picker instead; a request
  file that already carries one still sends it. **Send** (Ctrl/⌘ + Enter) runs the request as edited,
  without saving, and the run variables it ends with carry into the next
  **Send** in that tab until **Reset variables**; **Save** is Ctrl/⌘ + S. The
  inspector beside the response says why it is what it is: the mock's
  decisions (Simulated or Mock), or for a backend answer the same steps noted
  in a word each (Backend).

#### `janus run`

```text
janus run checkout --env staging --mock --scenario cart-with-one-item --reporter junit > report.xml
```

Runs a collection, folder or request with no server running, after the same
startup checks as `serve`. Exactly one of `--mock`, `--upstream` or
`--record` is required. `--scenario` fills in for requests without their own
`X-Mock-Scenario`; without it Janus decides.
`--env` names one of the shared environments.
`--var name=value` sets a starting run variable. `--reporter` is `text`
(default; a line per step), `json` (the run) or `junit` (a test case per step
and per test). Exit codes: `0` every step passed, `1` a step failed or the run was
refused (an unknown environment, for example), `2` the configuration,
fixtures or request files do not load.

#### Importing

**Import** on the Requests page (or `janus import`) converts:

- **Postman** Collection v2.0 and v2.1, with environment and globals files;
  auth becomes headers, `prerequest`/`test` scripts become `before`/`after`
  scripts, and dynamic variables such as `{{$guid}}` become Janus's.
- **Bruno** collections (`.bru` files or the YAML format), as a folder or a
  zip; `vars:post-response` becomes `extract`, and `assert` becomes tests.
- **Charles** sessions (`.chlsj`) and **HAR 1.2** files (from a browser's
  network panel): one folder per origin with a base URL variable; static
  assets are left out unless you include them, and you can pick which
  origins to import.

The preview lists the requests, what was converted with notes, and what was
skipped and why, before anything is written. Environments in the import go
to the shared `requests/environments/`. An existing collection, or an
existing environment of the same name, is replaced only when you confirm
(`--replace`). Imports are written to a
temporary folder and renamed into place, so a failed import leaves nothing
behind.

```text
janus import ~/Downloads/checkout.postman_collection.json staging.postman_environment.json --preview
janus import ./shop-bruno --into shop
```

**A curl command** becomes one request: choose **curl** in the Import
dialog and paste it, or paste it into a request's URL field. It opens in a
new untitled tab (or fills the one you pasted into), ready to send or save.
Both bash quoting (a browser's "Copy as cURL" and most terminals) and
Windows cmd quoting (`^` escapes) are read. The method, URL, headers
(`-H`, `-A`, `-e`, `-b`, `-u` as Basic, `--oauth2-bearer`), data (`-d`,
`--data-raw`, `--data-binary`, `--data-urlencode`, `--json`, with `-G`
moving it into the query) and form parts (`-F`) carry over. Options that
only change curl's output or timing (`-s`, `-v`, `-L`, `-o`,
`--compressed` and the like) are dropped; anything else the request cannot
hold (`--proxy`, `--cert`, `-k`, data read from a file) is listed before you
open it.

### Requests and errors

- `HEAD` uses an explicit `HEAD` fixture, or else the `GET` fixture without a
  body, negotiated and rendered the same way, with the `Content-Length` `GET`
  would send. The query string never affects matching.
- Resolution order: match the path, select the method, check the body against
  `accepts.yaml`, negotiate the locale and then the media type, then apply the
  header policy, then render dynamic values.
- Janus-generated errors are JSON (always `application/json`, whatever
  `Accept` says):
  `{"error":{"code":"…","message":"…","requestId":"…"}}`. Clients should rely on
  the status and `error.code`: `400 invalid-request` (malformed target, method,
  `Content-Type`, or an unusable `Accept`), `404 route-not-found`,
  `405 method-not-allowed` (with `Allow`; `404 route-not-found` instead with
  `onUnknownMethod: 404`), `406 not-acceptable` (no matching locale or media
  type), `413 request-too-large`, `414 url-too-long`,
  `421 host-not-allowed` (see [Cross-origin access](#cross-origin-access)),
  `503 service-unavailable` (Atlas only: too many event streams, or a reload refused during shutdown),
  `400 unknown-scenario` (see [Scenarios](#scenarios)),
  `415 unsupported-media-type`, `422 expectation-failed` and
  `422 idempotency-key-reused` (see
  [Choosing between responses](#choosing-between-responses)),
  `403 recording-not-allowed` and the other recording errors (see
  [Recording](#recording)),
  `415 unsupported-content-encoding`, `413 decoded-body-too-large`,
  `417 unsupported-expectation` and `503 fault-capacity-exceeded` (see
  [Faults and transport](#faults-and-transport)),
  `501 not-mocked` (instead of `404 route-not-found` with `onNoFixture: 501`),
  `431 headers-too-large` (sent with
  `Connection: close`), `500 render-failed` (a dynamic value could not be
  rendered; the message names the token and fixture ID, never a request value),
  and `500 internal-error`.
- Janus computes `Content-Length` and `Date` itself. Fixture responses are
  compressed by `Accept-Encoding` (see [Faults and transport](#faults-and-transport));
  errors and Atlas responses never are.
- Every fixture response carries `X-Mock-Identity`: the served
  representation's Atlas fixture ID (`fx_…`), which opens
  `/_janus/fixtures/<id>`. `X-Mock-Representation` accompanies a
  `Content-Type` override and `X-Mock-Warning:
199 janus "ignored Accept range <range>"` each dropped `Accept` range. Janus
  errors carry none of these. `diagnostics.headers: false` removes them all.
- Every response carries `x-janus-request-id` for correlation with the request
  log.
- Paths whose first segment is `_janus` belong to Janus itself (the Atlas API
  below) and never reach fixture resolution; a root `{name}` template never
  binds `_janus`.

## Atlas API

Atlas is a view of the active snapshot, mounted at the fixed prefix
`/_janus/`. Every response is `application/json` (the event stream aside) with
`Cache-Control: no-store`; successful documents carry `"apiVersion":"atlas.v1"`.
Read resources allow only `GET` and `HEAD` (anything else is `405` with
`Allow: GET, HEAD`, and so is `OPTIONS` unless it is a CORS preflight from a
listed origin); `/_janus/resolve` allows only `POST`, and `/_janus/reload`
`GET`, `HEAD` and `POST`. None of them changes a fixture file. Janus sends CORS
headers only for the origins in `cors.origins`, and refuses a browser's
`POST` to reload or resolve from any other origin; see
[Cross-origin access](#cross-origin-access). `/_janus/ui/` serves the
[Atlas UI](#atlas-ui) and is not an Atlas resource.

| Resource                                                | Returns                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /_janus/health`                                    | `status`, `snapshotVersion` (and `snapshot`), counts, `configDigest`, `warnings`, `capabilities`, `lastReload`                |
| `GET /_janus/config`                                    | The effective settings and where each value came from                                                                         |
| `GET /_janus/endpoints`                                 | Every path template + method, with `pathParameters`, `origin` and `detailHref` links; `?scenario=<name>` for another scenario |
| `GET /_janus/scenarios`                                 | Every scenario: `extends`, `chain`, `ids`, `overrides`, `removes`, endpoint counts and an `endpointsHref`                     |
| `GET` / `POST` / `PATCH` / `DELETE /_janus/session`     | The caller's session, with its `sequences` positions and `replays` count; see [Sessions](#sessions)                           |
| `DELETE /_janus/sequences`                              | Restarts the caller's sequence positions; see [Choosing between responses](#choosing-between-responses)                       |
| `GET /_janus/endpoints/<id>?at=<version>`               | One endpoint: its responses, `representationGroups`, `accepts`, `controls`, `origin` and the scenario `matrix`                |
| `GET /_janus/fixtures/<id>?at=<version>`                | One response: status, media types, headers, body preview, `dynamic` and `tokens`                                              |
| `GET /_janus/clock`                                     | The instant a request would render against, its mode and source, timezone and seed                                            |
| `POST /_janus/resolve`                                  | What Janus would answer for a request, and why: a simulation that serves nothing                                              |
| `GET` / `POST /_janus/reload`                           | The last reload result / reload now and wait for the result                                                                   |
| `GET /_janus/events`                                    | Server-sent events announcing snapshot changes and failed reloads                                                             |
| `GET /_janus/recording`                                 | The recording registrations and limits, and whether this server can record                                                    |
| `GET /_janus/captures`                                  | Recorded exchanges, newest first; `?scenario=`, `?outcome=`, `?limit=` (1–500) and `?before=` to page                         |
| `GET` / `DELETE /_janus/captures/<scenario>/<exchange>` | One capture: the request, the response with a `modified` flag, its provenance and `promotedTo` / delete it                    |
| `GET` / `POST /_janus/promotions`                       | Promoted files, newest first (`?review=`, `?scenario=`, `pending`) / promote a capture; see [Promotion](#promotion)           |
| `POST /_janus/promotions/review`                        | Marks promoted files reviewed against their current digests                                                                   |

- **IDs** (`ep_…`, `fx_…`) come from the logical identity: scenario, method,
  and path template, plus the locale and file-name media type for a response.
  An endpoint has one ID per scenario; a response's ID comes from the
  scenario that holds the file, so an inherited response keeps its parent's
  ID.
- **Scenarios**: each endpoint and response reports its `origin`: `own`
  (from the scenario itself), `inherited`, or `mixed`; inherited responses
  name the `scenario` holding the file. An endpoint's `matrix` has one row per
  scenario with the same method and path, and its responses by status, each
  with a `detailHref`. A `?scenario=` naming no scenario is
  `404 atlas-resource-not-found`.
  Editing a body, status, or headers changes `snapshotVersion` but not the IDs.
  A fixture ID is the `X-Mock-Identity` of the responses it serves.
- **Templates and representations**: `path` is the template
  (`/v1/products/{productId}`) and `pathParameters` lists its parameter names.
  An endpoint's `representationGroups` are
  `[{ status, locale, representations: [response…] }]`, the neutral group first,
  then locales, each by media type; the flat `fixtures` list holds the same
  responses in the same order. `accepts` is `{ mediaTypes,
allowMissingContentType }` from `accepts.yaml`, or `null`.
- **Headers**: one `{"name":…,"value":…,"treatment":…}` entry per value, the
  value exactly as configured. `treatment` is `replayed` (sent as shown) or
  `dropped` (a Janus-computed header the sidecar set).
  `mediaType` is the file name's media type, which `Accept` selects;
  `wireContentType` is the `Content-Type` actually sent.
- **Links** (`detailHref`) are relative to the Atlas root `/_janus/`, so they
  keep working when a proxy mounts Janus below a path.
- **Snapshot guard**: detail requests need `at=<snapshotVersion>`. A missing,
  repeated, or malformed `at`, or a malformed ID, is
  `400 atlas-invalid-request`; a different version is
  `409 atlas-snapshot-stale`; an unknown ID in the current snapshot is
  `404 atlas-resource-not-found`. Unknown `/_janus/…` paths are
  `404 route-not-found`.
- **Previews** show JSON, YAML, XML, `+json`/`+xml` and `text/*` bodies that
  are valid UTF-8 as `utf8`, everything else as `base64`, cut at 64 KiB (`truncated: true`, with the full
  `byteLength`). Request runner steps carry text bodies whole; only their
  `base64` bodies are cut. Bodyless statuses have `{"state":"unavailable","reason":"bodyless"}`;
  an empty body is an available, empty preview.
- **File paths**: Atlas never reports them.
- **Dynamic values**: a fixture's `tokens` list each token's `location`
  (`body` or `header`), `pointer` (JSON Pointer, or `line:column` in a text
  body), `header`, `expression`, `category` (`clock`, `request`, `generator`),
  `unique`, and `span` in the raw preview. Add `&view=rendered` for a
  `rendered` preview against a synthetic request with no query, headers or
  body: optional `now=<RFC 3339>` and `param.<name>=<value>`. It reports
  `preview`, rendered `headers`, `instant`, `clockSource`, `seed`,
  `nondeterministic`, `unresolved` request tokens, and each body token's
  rendered `spans`; it changes no state. An invalid `now`, an unknown parameter,
  or a repeated input is `400 atlas-invalid-request`.
- **Clock**: `/_janus/clock` returns `now`, `mode` (`frozen`, `offset`,
  `live`), `source` (`request-header`, `session`, `server-default`, `wall-clock`),
  `session` (the caller's session ID, or `null`),
  `timezone`, `seed`, `seedSource` (`config`, `cli`, `generated`) and
  `serverDefault`. It honours `X-Mock-Now` on the clock request itself and is
  not snapshot-bound.
- **Configuration**: `configDigest` (`cfg_` + 16 hex digits) identifies the
  behaviour-affecting settings; two servers with the same digest and snapshot
  answer requests the same way. `warnings` lists startup warnings as `code`,
  `source`, and `message`, without locations. `/_janus/config` returns
  `configFile` (whether a file was loaded) and `settings`, sorted by key, each
  with its `value` and `source` (`default`, `file`, or `cli`). `server.host`,
  `server.port`, and `fixtures.root` are never included. It is not
  snapshot-bound and takes no `at`.

Health also reports `scenarioCount` and `configuredDefaultScenario`, and
`capabilities` reports `scenarios` and `sessions`, `ui` (the UI is served at `/_janus/ui/`)
and `cors.origins` (how many origins are configured, never the list), and
`recording` (`available`, and how many endpoints are registered), and
`promotion` (`available`, `mode`, and how many files are pending review).
Responses in endpoint and fixture detail carry a `digest` and, when promoted,
their `provenance`; inventory summaries carry `review`. Captures are
read from disk, not the snapshot, so they take no `at`; the captures directory
is never reported, and `/_janus/config` shows `recording.captures` only as
`"set"`. `/_janus/events` also sends a `capture` event (`id`, `scenario`,
`outcome`, never request values) after each exchange is logged, and a
`promotion` event (capture, scenario, outcome, file keys) after each
promotion, skipped auto promotion or review.

### Cross-origin access

By default Atlas is same-origin only, as in earlier versions: no
`Access-Control-*` headers, and `OPTIONS` answers `405`. List the origins whose
pages may call Atlas from another origin, such as a UI on a shared static host
or `vite dev`:

```yaml
cors:
  origins: ['http://localhost:5173', 'https://atlas.example.com']
  maxAge: 600
```

- Entries are exact origins: `http` or `https`, host and optional port, no
  path and no trailing slash. They are normalized (lowercase, default port
  dropped). `['*']` allows any origin and must be the only entry.
- These origins apply only to Atlas routes. The UI's own files never get CORS
  headers; fixture routes have their own list, `cors.fixtures.origins` (see
  [Faults and transport](#faults-and-transport)).
- A listed origin gets `Access-Control-Allow-Origin` and `Vary: Origin` on
  every Atlas response, the event stream included. Credentials are never
  allowed. With a non-empty list, every Atlas response carries `Vary: Origin`.
- A preflight succeeds (`204`) only for a listed origin, a known and enabled
  Atlas route, one of its methods, and request headers among `content-type`
  and `x-mock-now`. Any other preflight gets the same answer as a plain
  `OPTIONS`: `405` with `Allow`, or `404` for an unknown or disabled route.

**The `Origin` check.** `POST /_janus/reload` and `POST /_janus/resolve` are
refused with `403 atlas-origin-forbidden`, changing nothing, when they carry an
`Origin` header that is neither listed in `cors.origins` nor the request's own
authority. That stops a page on another site from reloading your server with a
plain form post. Requests without `Origin`, such as curl and scripts, are
unaffected.

- The request's authority is its `Host` header. The `Origin`'s host and port
  must equal it; a `Host` without a port stands for the origin scheme's
  default port.
- The scheme is not compared, because Janus serves plain HTTP and cannot see
  what a TLS-terminating proxy received: `http://host` and `https://host` are
  both trusted for `Host: host`. If that matters, enforce the check at the
  proxy.
- `Forwarded`, `X-Forwarded-Host` and `X-Forwarded-Proto` are ignored.
- A malformed `Origin`, `null`, or more than one `Origin` header is refused.
- This is not authentication. Anything that can reach the port without a
  browser can still reload and resolve; binding to loopback, the default, is
  what limits who can, together with the `Host` check below.

**The `Host` check.** While Janus listens on a loopback address (the default),
it answers `421 host-not-allowed` to any request whose `Host` is not
`localhost`, a `*.localhost` name, a loopback IP such as `127.0.0.1` or `[::1]`,
or the configured `server.host`. This stops DNS rebinding, where a page on
another site points its name at 127.0.0.1 to read Atlas or post to it as the
same origin. Requests without `Host` (HTTP/1.0) are allowed, and a non-loopback
listener does not check `Host`.

### Resolution explorer: `POST /_janus/resolve`

Describe a request as JSON and Janus answers with the response it would send
and the full trace, without serving it:

```sh
curl -X POST http://127.0.0.1:4010/_janus/resolve \
  -H 'Content-Type: application/json' \
  -d '{"method":"GET","target":"/v1/products/p-1/reviews","headers":{"accept":["application/json"]}}'
```

```json
{
  "apiVersion": "atlas.v1",
  "snapshotVersion": "…",
  "response": { "status": 200, "headers": [{ "name": "content-type", "value": "application/json" }, …],
                "body": { "state": "available", "encoding": "utf8", "value": "[{ \"rating\": 5, … }]", … } },
  "trace": { "route": { "template": "/v1/products/{productId}/reviews", "params": { "productId": "p-1" },
                        "considered": ["/v1/products/p-1"] }, … },
  "fixture": { "endpointId": "ep_…", "fixtureId": "fx_…", "detailHref": "fixtures/fx_…?at=…" },
  "notes": ["transport limits (413, 414, 431) are not simulated"]
}
```

- **Envelope**: `method` and `target` (required; normalised exactly as a real
  request's), `headers` (name → string or array of strings), `body`
  (`{"encoding":"utf8"|"base64","data":"…"}`), `nowMs` (epoch milliseconds or
  RFC 3339) and `scenario` (selected ahead of every other source) are the only
  keys; `requestId` and anything else are
  `400 atlas-invalid-request` naming the field, as are header names that differ
  only by case. The envelope must be `Content-Type: application/json`
  (`415` otherwise). The decoded body is limited by `limits.maxBodyBytes`, the
  envelope by twice that plus 64 KiB (`413 request-too-large`).
- **The answer** is `200` whenever the simulation ran, whatever status the
  simulated request gets. Headers are `{"name":…,"value":…}` entries, one per
  value; the body is an Atlas preview (bodyless for `HEAD`); `fixture` links the fixture that
  answered, or is `null` for a Janus-generated response.
- **Scenarios and sessions**: the trace reports the selected `scenario`, its
  `selection` (`source` and inheritance `chain`), `resolvedFrom`, the
  `session`, and the inherited files the scenario hid (`shadowed`, at most 64,
  with `shadowedCount` when cut); the answer's `shadowed` links each hidden
  file. A simulated `X-Mock-Session` header uses that session's pin and clock
  but never creates, refreshes or changes the session.
- **`trace.route.considered`** lists the templates that matched a prefix of the
  path and were abandoned, in the order tried. A miss reports
  `route: { "template": null, "params": {}, "considered": […] }` when any
  template was tried, which is what explains a surprising `404`.
- **Simulation only**: the simulated request is never logged as a request (the
  resolve call itself is), its body is never stored, no state changes, and the
  trace never contains request header or body values. Dynamic values render
  exactly as for a real request, `:unique` tokens included. `413`, `414` and
  `431` are not simulated, and a target under `/_janus` answers
  `404 route-not-found`.
- `atlas.resolve: false` unmounts it (`404`), and health reports
  `capabilities.resolve: false`.

### Hot reload

`janus serve --watch` (or `fixtures.watch: true`) watches the fixture root and
reloads once changes settle (150 ms without further changes, or 2 s into a
continuous burst), so an editor's save-rename-delete is one reload.
`POST /_janus/reload` reloads on demand, watching or not. The configuration
file is not watched; changing it still needs a restart.

A reload reads the whole tree, builds and validates a complete candidate beside
the running snapshot, and swaps it in only when it has no errors:

```text
janus reload-started triggers=watch
janus reload-failed errors=1
janus: reload: 1 startup error; keeping the current snapshot.
  data/default/v1/products/{productId}/GET/200.json:2:11: invalid JSON: … [invalid-json]
```

- **Outcomes**: `swapped` (a new snapshot is served), `unchanged` (the tree
  validates to the active version), `failed` (the running snapshot keeps
  serving). Warnings never block; a reload's warnings replace the previous
  fixture warnings in health.
- **One at a time**: triggers that arrive during a reload join a single
  follow-up reload. `POST /_janus/reload` (empty body) waits for the reload that
  includes its trigger and answers `200` (`swapped`, `unchanged`) or `422`
  (`failed`), even if the caller disconnects. `GET /_janus/reload` returns the
  last result, or `{"outcome":null}` before the first:
  `outcome`, `triggers` (`watch`, `request`, `promotion`), `finishedAt`,
  `activeSnapshotVersion`, `candidateSnapshotVersion`, and `errors` and
  `warnings` located by `scenario`, `endpoint` (`method`, `path` template), `file` name,
  `line` and `column`, never by filesystem path.
- **In-flight work** finishes on the snapshot it started with; detail links
  with the old `at` then answer `409 atlas-snapshot-stale`.
- **A vanished fixture root** is a failed reload; automatic watching then stays
  off until a restart. Other watcher failures are retried with backoff.
- **Startup is unchanged**: an invalid tree still exits without binding.
- **Shutdown** stops accepting reloads, closes the watcher before the server,
  and lets a running reload finish within the shutdown deadline.

`GET /_janus/events` is a `text/event-stream` (at most 32 at once; more get
`503 service-unavailable`):

```text
retry: 3000
event: state
data: {"snapshotVersion":"…","lastReload":{"outcome":"failed","errorCount":1,"finishedAt":"…"}}

event: snapshot
data: {"snapshotVersion":"…","previousVersion":"…"}

event: reload-failed
data: {"errorCount":1,"finishedAt":"…"}
```

Every connection starts with an authoritative `state` event (sent again when a
reload changes nothing but the last result); after that it receives only
changes made while it is open. A comment line every 25 s keeps proxies from
closing it; a proxy must not buffer or compress it. Health reports
`capabilities` (`resolve`, `reload`, `watch`: watching is configured and
running, `events`, `ui` and `cors`) and `lastReload` (`outcome`, `errorCount`, `finishedAt`, or
`null`).

## Atlas UI

`apps/ui` is a static React app that talks to Janus only through the Atlas API.
Janus serves it at **`/_janus/ui/`**: `janus serve` prints the address
(`Atlas UI: http://127.0.0.1:4010/_janus/ui/`), and it works there with no
configuration. To host it elsewhere, see
[Deploying the Atlas UI](#deploying-the-atlas-ui).

For local development of the UI itself, run Janus and the Vite dev server side
by side:

```sh
pnpm janus serve --data examples/data    # terminal 1: Janus on 127.0.0.1:4010
pnpm ui:dev                              # terminal 2: open http://localhost:5173/
```

The dev server (and `vite preview`) forwards `/_janus/` to Janus, so the UI
works on its own origin with live reload. Set `JANUS_URL` to point it at
another Janus, e.g. `JANUS_URL=http://127.0.0.1:4011 pnpm ui:dev`.

The connection header shows the configuration digest, a gear button that opens
the read-only Configuration dialog over the current view (each setting with its
source; the desktop app opens it from **Server › Configuration…** instead, and
`#/config` links still open it), and, when there are any, a startup-warnings
count that opens the list of warnings.

The inventory shows path templates with their `{parameters}` set apart and
announced, grouped into folders by path segment (a top-level group shows its
endpoint count). A search box (path template or method, any case) and one
toggle per method filter it; the search, the methods and the folders you open
or close are kept in the address (`#/?q=products&method=POST`), so a filtered
view can be shared and survives a refresh. Only the rows near the viewport are
rendered, so thousands of endpoints stay responsive. Endpoint detail shows a representation matrix (rows are statuses
and locales, columns media types), headed by the response count, and the accepted request media types. The compass
icon after the endpoint ID (**Try it**) opens the endpoint in Requests' Explore mode.
Response detail marks headers "Computed by Janus" and shows a `Content-Type`
override beside the file name's media type, in text. JSON, YAML, XML and HTML
previews are syntax-highlighted, loaded only when first needed: JSON by a small
built-in tokenizer, the others by shiki. A preview that takes more than 150 ms
to highlight stays plain, with a **Highlight** button.

A response with dynamic values has a **Raw / Rendered** toggle. Raw marks
every token in the body and lists them with their kind, stating `:unique` in
text. Rendered asks the server to render the response, shows the instant, its
source and the seed, marks the rendered values, lists unresolved request
tokens, and re-renders at another instant or with sample path-parameter values.
The connection header shows the server clock (mode, instant or "live",
timezone) and the seed.

**Scenarios.** With more than one scenario, the header has a **Scenario**
selector; the choice is kept in the address (`#/?scenario=sold-out`) and
applies to every view. Changing it keeps the endpoint on screen when the new
scenario has it, and otherwise says the endpoint is not in that scenario.
Inventory rows mark inherited and mixed endpoints, with an **Own only**
filter. Endpoint detail adds a table of the endpoint's responses in every
scenario, each linking to its file and saying where it comes from; response
detail names the scenario that holds the file. `#/scenarios` shows the
inheritance as a keyboard-navigable tree beside the selected scenario's
description, chain, ids, overrides, removes and endpoint counts.

**Choosing between responses.** Response names include their variant
(`200.empty`) in both matrices. A **Controls** panel reads the endpoint's
`variants.yaml`, `pages.yaml`, `sequence.yaml` and `expect.yaml` as sentences
("1. If path parameter `orderId` is `ord-missing`, respond with
**404.missing**."), names the scenario that supplies each file, and links every
response it names. The explorer adds the replay, expectation, choice and
sequence decisions, and an **Add idempotency key** button.

**Explore** (an untitled request on the **Requests** tab in Explore mode; old
`#/explorer` links land there, and **Try it** on an endpoint pre-fills the
method and template with its first `{parameter}` selected): edit the method,
target, headers and an optional body (text or base64, with its
`Content-Type`), set **Render at** in the bar if you like, then **Explain**. The result shows the status, headers, the
highlighted body, a link to the fixture that answered, and the decisions in
order: route and abandoned templates, parameters, method, request media type,
language, media type, header policy and rendering, plus the session, the
selected scenario and why, the scenario that supplied the file, and the
hidden ancestor files. The request's own `X-Mock-Scenario` decides the
scenario; without one, a scenario picked in the header goes with the
simulation. The method, target and
headers are kept in the address, so an explanation can be shared; the body
never is. A result from an older snapshot is labelled stale, with **Re-run**. With `atlas.resolve: false` Explore is off and the toggle offers only Live.

**Recording.** With registered endpoints, the header has a **Captures** tab
(`#/captures`): the recorded exchanges, newest first, for the selected
scenario or all of them, filtered by outcome and paged. New captures appear as
they are logged and are announced without moving focus. Each captured
exchange opens its request, response (with a note when the file was edited
since) and provenance. A capture is deleted, after a confirmation, with the
trash button on its row or on its own page. The Configuration dialog has a **Recording** section listing
each registration as a sentence, and the explorer accepts `X-Mock-Record`,
showing the registration, the URL that would be requested and the headers that
would be forwarded, with nothing sent.

**Promotion.** When the server can promote, a captured exchange has a
**Promote** button. Its dialog chooses the scenario, variant and route
template and binds IDs, and runs a dry run on every change: the files that
would be written, each ID token marked with its tier, every suggestion and
refusal as a sentence, and each existing file the promotion would replace.
A modified or hand-written file is shown with its current content and must
be ticked on its own. Problems are shown next to the field they concern. A
promoted file is pending review: the header's **Promotions** tab
(`#/promotions`, with the pending count) lists promoted files by review state
and scenario, the inventory marks them **Unreviewed**, and the response
detail shows where each came from, what was rewritten, and **Mark
reviewed**. The capture detail links to the files it was promoted to.

**Snapshot changes** arrive over `/_janus/events`, never by polling: a banner
says the fixtures changed and offers **Refresh view** (the current view stays
until then, labelled stale), and a failed reload shows **Reload failed** in the
connection header, listing each error with its endpoint, file, line and
message. Dropped connections are retried by the browser; the UI reconnects with
backoff only if the browser gives up.

**Themes and layout.** The theme follows the system unless you choose Light
or Dark in the header; the choice is remembered in the browser and applied
before the page draws. From 769 px wide the inventory sits beside the
details on the Endpoints view and folds away (Ctrl/⌘ + [, or the button at the end of the search row; the
details fold with Ctrl/⌘ + ] or the button in their first section's header); at 768 px and below
it is its own view, and endpoint details link back to it. The server's address
is in the tooltip of the status light after the wordmark. Every view works by keyboard,
starting with a **Skip to main content** link, and moves focus to the new
view's heading when you navigate.

### Deploying the Atlas UI

There are two ways to run the UI.

**1. Served by Janus (the default).** Open `/_janus/ui/` on the server. The
page reaches the Atlas of the server that served it, through a generated
`atlas-config.js` with a relative `serverUrl`, so it also works when a reverse
proxy mounts Janus below a path. Disable it with `ui.enabled: false` or
`--no-ui`. When running from source without a UI build, Janus starts without
it and warns `ui-assets-missing`; run `pnpm build`.

Behind a reverse proxy, pass the client's `Host` header through, so that the
UI is same-origin for Janus's [`Origin` check](#cross-origin-access) too. For
example, mounting Janus at `/mock/`:

```nginx
location /mock/ {
    proxy_pass http://127.0.0.1:4010/;   # strips /mock
    proxy_set_header Host $host;          # keep the client's Host
    proxy_buffering off;                  # the event stream must not be buffered
}
```

Open `https://host/mock/_janus/ui` (Janus redirects to `.../ui/`). A proxy
that rewrites `Host` to the upstream address (`127.0.0.1:4010`, nginx's
default) makes the page cross-origin for Janus: browsing works, but the
explorer answers "This page's origin (…) is not allowed to change this server",
and so does a `POST /_janus/reload` from the page. Pass `Host` through, or list
the proxy's public origin in `cors.origins`.

**2. On a static host.** `pnpm build` writes the UI to `apps/ui/dist/`; serve
that directory from any host or path (it uses hash routes such as
`#/endpoints/<id>`, so no fallback rules are needed). The server URL is read at
runtime from `atlas-config.js` next to `index.html`; replace that file on the
host instead of rebuilding:

```js
globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: 'https://tools.example/mock' };
```

`serverUrl` defaults to the page's own origin. It may be relative to the page
and may include a path, but not credentials, a query, or a fragment; the UI
requests `<serverUrl>/_janus/…`. Unknown keys are rejected. Then either:

- **Same origin:** put the UI and Janus behind one proxy that forwards
  `<serverUrl path>/_janus/` to Janus. With the UI at `/ui/` and
  `serverUrl: '/mock'`:

  ```nginx
  location /ui/          { root /srv/janus-ui; }             # apps/ui/dist copied to /srv/janus-ui/ui
  location /mock/_janus/ {
      proxy_pass http://127.0.0.1:4010/_janus/;
      proxy_set_header Host $host;
      proxy_buffering off;
  }
  ```

- **Cross origin:** point `serverUrl` at Janus and list the page's origin in
  [`cors.origins`](#cross-origin-access), for example
  `origins: ['https://atlas.example.com']`. Everything works across origins,
  the event stream included.

Atlas has no authentication; keep Janus and any proxy on a trusted network.

**Supported browsers.** Current versions of Chrome, Edge and other
Chromium-based browsers, Firefox and Safari. The browser journeys run in
Chromium, Firefox and WebKit.

**Troubleshooting.**

| What you see                                                                                         | Why, and what to do                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Could not reach the server. It may be down, or it may not list this page's origin in cors.origins." | The UI is on another origin than `serverUrl`, and the request failed: either Janus is not running at that URL, or its `cors.origins` does not list the origin the page shows. Add it and restart Janus, then **Retry connection**. |
| "The server is unreachable."                                                                         | Janus is not running at `serverUrl`, or the proxy does not forward `/_janus/` to it.                                                                                                                                               |
| "This page's origin (…) is not allowed to change this server"                                        | An explanation was refused with `403 atlas-origin-forbidden`: usually a proxy that rewrites `Host`. Pass `Host` through, or list the origin in `cors.origins`.                                                                     |
| `/_janus/ui/` answers `404`                                                                          | The UI is disabled (`ui.enabled: false`, `--no-ui`) or not built: look for the `ui-assets-missing` warning and run `pnpm build`.                                                                                                   |
| The "fixtures changed" banner never appears behind a proxy                                           | The proxy buffers the event stream; turn buffering off for `/_janus/events`.                                                                                                                                                       |
| A `curl -X POST` reload works but the page's does not                                                | Expected when the page's origin is untrusted: requests without `Origin` are allowed, browser requests from other origins are not.                                                                                                  |

## Desktop app

The desktop app runs Janus for a project folder and shows its Atlas UI in a
window, with no Node installation, terminal or browser tab. It is the same
server as `janus serve`: a folder that runs with the CLI runs the same way in
the app, and the app never writes to it unless asked to create a project.

### Installing

Installers are built by the **Desktop** workflow (`.github/workflows/desktop.yml`,
run by hand or by a `desktop-v*` tag) and kept as workflow artifacts for 14 days:
a `.dmg` and `.zip` for macOS (Apple silicon and Intel), a per-user installer
(`.exe`) for Windows, and an AppImage and a `.deb` for Linux.

The installers are not signed, so the first launch needs one extra step:

- **macOS:** open the `.dmg` and drag Janus to Applications. The first time,
  Control-click Janus in Applications, choose **Open**, then **Open** again.
  If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/Janus.app` once.
- **Windows:** run the installer. When SmartScreen says "Windows protected your
  PC", choose **More info**, then **Run anyway**.
- **Linux:** make the AppImage executable (`chmod +x Janus-*.AppImage`) and run
  it, or install the `.deb` with `sudo apt install ./janus-desktop_*.deb`.

There is no automatic update: install a newer build over the old one.

### Projects

A project is a folder holding `janus.config.yaml`, a `data/` directory, or
both. Open one with **File › Open Project…**, from **File › Open Recent** or the
start page, by passing it on the command line (`janus-desktop ./shop-mocks`),
or by dropping it on the Dock icon on macOS. Launched with no folder, the app
reopens the last project you opened; if its folder is gone, it shows the start
page. Opening a project that is already
open focuses its window. **File › New Project…** writes a minimal
`janus.config.yaml` and `data/default/hello/GET/200.json` into an empty folder,
never overwriting a file.

Each project gets its own window and its own server process, so several run
side by side. The server listens on the project's configured address and port,
so a browser, a simulator or a test suite calls the same URL as with the CLI;
the window title shows it. The app runs a project as `janus serve` with no
flags in that folder, with two differences: watching is on unless
`janus.config.yaml` sets `fixtures.watch`, and **Start on a Free Port** can run
it on another port for one run. Both are reported with source `cli` at
`GET /_janus/config`. The app never changes the port by itself.

When the configuration or fixtures are invalid, or the port is taken, the
window lists every problem with its file and line, opens a problem's file with
**Open File**, and starts again with **Retry**. If a server stops on its own,
the window shows its exit code and last log lines; the app never restarts it
by itself. Closing a window stops its server, and quitting stops every server
before the app exits, so no port stays bound.

### Menus

| Menu   | Items                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| File   | New Project…, Open Project…, Open Recent (with Clear), Import Collection…, Close Window                                                    |
| Edit   | the platform's standard items                                                                                                              |
| Server | Restart, Reload Fixtures, Configuration…, Copy Mock URL, Open Mock URL in Browser, Show Data Folder, Show Captures Folder, Show Server Log |
| View   | Reload Page, Actual Size, Zoom In, Zoom Out, Toggle Full Screen (Toggle Developer Tools in builds from source)                             |
| Window | the platform's standard items                                                                                                              |
| Help   | About Janus (in the Janus menu on macOS)                                                                                                   |

**Server › Restart** starts a new server process, so sessions, sequences,
clocks and replays start empty, as they do when `janus serve` restarts.
**Reload Fixtures** is `POST /_janus/reload`. **File › Import Collection…**
opens the Requests page with the import dialog. **Server › Configuration…**
opens the Configuration dialog over the current view.

### Where the app keeps its data

The app's own files live in its data directory: `~/Library/Application
Support/Janus` on macOS, `%APPDATA%\Janus` on Windows and `~/.config/Janus` on
Linux.

| File                    | Holds                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| `recent-projects.json`  | up to 10 recent project folders                                         |
| `window-state.json`     | each project window's size and position                                 |
| `logs/<project id>.log` | the server log of a project's current run; the previous run is `.1.log` |
| `logs/app.log`          | the app's own events                                                    |

A project id is the first 16 hex digits of the SHA-256 of the folder's real
path. The logs hold what the server prints, which never includes request
bodies or header values.

### Security

The Atlas window runs the UI exactly as a browser tab does: same origin as its
server, no access to the app or the computer, and no navigation outside its
server's `/_janus/ui/` (other `http:` and `https:` links open in the system
browser). Every window is sandboxed with context isolation, every permission
request is denied, and the packaged app turns off running as Node and
`NODE_OPTIONS` with Electron fuses. The app opens no port of its own; the only
listener is the project's server, which binds loopback unless the project says
otherwise.

### Building from source

```sh
pnpm install
pnpm desktop                                  # builds the workspace and starts the app
pnpm --filter @janus/desktop run package      # installers for this platform, in apps/desktop/release/
pnpm --filter @janus/desktop run smoke        # launches the packaged app against examples/
pnpm test:desktop                             # Electron journeys, unpacked build, smoke test
```

`pnpm install` downloads the Electron binary. The Electron journeys and the
smoke test run under `xvfb-run` on Linux when there is no display. The app is
built from `apps/desktop`: the main process, the server host and the preload
in TypeScript, and the start, status and log pages with React and Vite.
Packaging stages the app with `pnpm deploy`, ships the UI build as
`resources/ui`, and fails if a dependency has a native module.
