import { utf8DecodeStrict, utf8Encode } from '../bytes.js';
import { compareStrings } from '../canonical.js';
import { previewBody } from '../atlas/atlas.js';
import type { AtlasPreview } from '../atlas/types.js';
import { captureFileKind } from '../atlas/captures.js';
import { rfc3339 } from '../dynamic/time.js';
import { parseJsonTree } from '../dynamic/json-tree.js';
import { bodyKind } from '../fixtures/body-kind.js';
import { buildSnapshot } from '../fixtures/build.js';
import { parseFileName } from '../fixtures/filename.js';
import {
  fileDigest,
  parseProvenance,
  provenanceFileName,
  PROVENANCE_FORMAT,
  serializeProvenance,
  type ProvenanceDocument,
  type ProvenanceEntry,
  type ProvenanceNote,
  type ProvenanceRefusal,
  type ProvenanceRewrite,
  type ProvenanceSuggestion,
} from '../fixtures/provenance.js';
import type { RouteNode, SnapshotData, StoredMethod } from '../fixtures/snapshot.js';
import { parseJson } from '../fixtures/sidecar.js';
import { decodeFieldValue } from '../http/headers.js';
import { formatTemplate, type RouteSegment } from '../http/target.js';
import { captureDigest } from '../recording/capture.js';
import type { CaptureLogEntry } from '../recording/ports.js';
import { unknownScenario } from '../sessions/scenario-error.js';
import type { BuildSnapshotOptions, FixtureFiles, StartupError, StartupWarning } from '../types/index.js';
import { PromotionError } from './errors.js';
import type { PromotionRequest } from './request.js';
import {
  binaryRefusals,
  collectBindings,
  rewriteHeaders,
  rewriteJsonBody,
  rewriteTextBody,
  type Binding,
} from './rewrite.js';
import { placeTemplate, representationKey, resolveTemplate, withVariant } from './target.js';

/** A capture as the capture reader returns it. */
export interface CaptureExchange {
  readonly entry: CaptureLogEntry;
  /** Allowlisted file names → bytes; null for a file that exists but could not be read. */
  readonly files: ReadonlyMap<string, Uint8Array | null>;
}

/** What a file must look like on disk at the moment it is written. */
export type WritePrecondition = { readonly kind: 'absent' } | { readonly kind: 'digest'; readonly digest: string };

/** Why an existing file blocks the promotion. */
export type ExistingKind = 'promoted' | 'modified' | 'hand-written';
export type ConflictReason = 'exists' | 'modified' | 'hand-written' | 'digest-mismatch' | 'changed-on-disk';

export interface PromotionConflict {
  readonly file: string;
  readonly kind: ExistingKind;
  readonly reason: ConflictReason;
  /** A fixture of the file's identity in the active snapshot, whose detail shows the current content and digest. */
  readonly fixtureId?: string;
}

/** One file a promotion writes. */
export interface PlannedFile {
  /** File key below the target scenario root. */
  readonly file: string;
  /** Validated path components below the fixture root: scenario, directories, method, file name. */
  readonly path: readonly string[];
  readonly role: 'response' | 'headers' | 'provenance';
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly action: 'create' | 'replace';
  readonly precondition: WritePrecondition;
  /** What the replaced file was when planned, so a write-time conflict names it (review E2). */
  readonly existing?: ExistingKind;
  /** For previews: the response file's media type; JSON for sidecars and provenance. */
  readonly mediaType: string | null;
}

/** A rewrite, suggestion or refusal with the file it was found in; global refusals have no file. */
export type Located<T> = T & { readonly file?: string };

/** A planned promotion. */
export interface PromotionPlan {
  readonly capture: string;
  readonly scenario: string;
  readonly endpoint: { readonly method: string; readonly path: string };
  readonly files: readonly PlannedFile[];
  readonly bindings: readonly Binding[];
  readonly rewrites: readonly Located<ProvenanceRewrite>[];
  readonly suggestions: readonly Located<ProvenanceSuggestion>[];
  readonly refusals: readonly Located<ProvenanceRefusal>[];
  readonly notes: readonly Located<ProvenanceNote>[];
  readonly conflicts: readonly PromotionConflict[];
  readonly warnings: readonly StartupWarning[];
}

export interface PlanInput {
  readonly request: PromotionRequest;
  readonly capture: CaptureExchange | null;
  /** A fresh read of the whole fixture tree. */
  readonly tree: FixtureFiles;
  /** The active snapshot: target scenarios, declared ids and effective templates. */
  readonly snapshot: SnapshotData;
  readonly buildOptions: BuildSnapshotOptions;
  /** Wall-clock epoch ms for `promotedAt`. */
  readonly now: number;
  /** `promotion.mode: auto` may replace `promoted` files without naming them. */
  readonly auto: boolean;
}

/**
 * Plans a promotion: reads the capture, places the template,
 * names the files, rewrites IDs and escapes tokens, builds provenance,
 * classifies existing files, and validates the resulting tree. Pure: it writes
 * nothing. A write refused by the replacement rules throws `409`; a dry run
 * keeps the conflicts in its plan.
 */
export function planPromotion(input: PlanInput): PromotionPlan {
  const { request, snapshot, tree } = input;
  const captureId = `${request.capture.scenario}/${request.capture.exchange}`;
  const scenario = request.scenario ?? request.capture.scenario;
  const scenarioData = snapshot.scenarios.get(scenario);
  if (scenarioData === undefined) {
    const answer = unknownScenario(scenario, 'caller', [...snapshot.scenarios.keys()]);
    throw new PromotionError(400, 'unknown-scenario', answer.message, answer.details);
  }
  if (input.capture === null)
    throw new PromotionError(404, 'atlas-resource-not-found', 'No capture with this ID exists');
  // Edits the caller made in the dialog stand in for the captured parts; IDs are rewritten in them as usual.
  const captured = readCapture(input.capture);
  const capture = {
    ...captured,
    ...(request.body === undefined ? {} : { body: utf8Encode(request.body) }),
    ...(request.headers === undefined ? {} : { headers: request.headers }),
  };

  // The template, laid onto the scenario's own directory.
  const template = resolveTemplate(capture.registration, capture.params, request.path);
  const placed = placeTemplate(scenario, template.segments, template.bindings, tree, scenarioData.root);
  const method = capture.method;
  const dirParts = [...placed.dirs, method];
  const dirKey = dirParts.join('/');
  const ownPrefix = `${scenario}/${dirKey}/`;
  const own = new Map<string, Uint8Array>();
  for (const [key, bytes] of tree) {
    if (key.startsWith(ownPrefix) && !key.slice(ownPrefix.length).includes('/'))
      own.set(key.slice(ownPrefix.length), bytes);
  }

  // The response file keeps an existing spelling of the same representation.
  const named = withVariant(capture.responseName, request.variant ?? null);
  const key = representationKey(named);
  const responseName = [...own.keys()].sort(compareStrings).find((name) => representationKey(name) === key) ?? named;
  const parsed = parseFileName(responseName);
  if (parsed.kind !== 'response')
    throw new PromotionError(422, 'capture-unreadable', 'the capture has no response file');
  const identity = parsed.variant === null ? String(parsed.status) : `${String(parsed.status)}.${parsed.variant}`;
  const sidecarName = `${identity}.headers.json`;
  const metaName = provenanceFileName(identity);
  const fileKey = (name: string): string => `/${dirKey}/${name}`;

  // Bindings, then each file's rewrites and escapes.
  const kind = parsed.mediaType === null ? null : bodyKind(parsed.mediaType);
  const json = kind === 'json' ? parseJson(capture.body) : null;
  const text = kind === 'text' ? utf8DecodeStrict(capture.body) : null;
  const declared = new Set(scenarioData.ids.map((id) => id.name));
  const collected = collectBindings({
    scenario,
    declared,
    explicit: request.ids,
    path: placed.bindings,
    body: json?.ok === true ? parseJsonTree(json.text) : null,
  });
  const { bindings } = collected;
  const rewrites: Located<ProvenanceRewrite>[] = [];
  const suggestions: Located<ProvenanceSuggestion>[] = [];
  const refusals: Located<ProvenanceRefusal>[] = [...collected.refusals];
  const notes: Located<ProvenanceNote>[] = [];

  let body = capture.body;
  const bodyReport = {
    rewrites: [] as ProvenanceRewrite[],
    suggestions: [] as ProvenanceSuggestion[],
    refusals: [] as ProvenanceRefusal[],
  };
  if (json?.ok === true) {
    const result = rewriteJsonBody(capture.body, json.text, bindings);
    body = result.bytes;
    Object.assign(bodyReport, result);
  } else if (text !== null) {
    const result = rewriteTextBody(text, bindings);
    body = result.bytes;
    Object.assign(bodyReport, result);
  } else if (kind !== null && bindings.length > 0) {
    bodyReport.refusals = [...binaryRefusals(bindings)];
  }
  const responseKey = fileKey(responseName);
  rewrites.push(...bodyReport.rewrites.map((item) => ({ ...item, file: responseKey })));
  suggestions.push(...bodyReport.suggestions.map((item) => ({ ...item, file: responseKey })));
  refusals.push(...bodyReport.refusals.map((item) => ({ ...item, file: responseKey })));

  let sidecar: { bytes: Uint8Array; report: Omit<ReturnType<typeof rewriteHeaders>, 'headers'> } | null = null;
  if (capture.headers !== null) {
    // Captured values hold the upstream's bytes; a sidecar holds text.
    const text = Object.fromEntries(
      Object.entries(capture.headers).map(([name, value]) => [
        name,
        typeof value === 'string' ? decodeFieldValue(value) : value.map(decodeFieldValue),
      ]),
    );
    const result = rewriteHeaders(text, bindings);
    sidecar = { bytes: utf8Encode(`${JSON.stringify(result.headers, null, 2)}\n`), report: result };
    const sidecarKey = fileKey(sidecarName);
    rewrites.push(...result.rewrites.map((item) => ({ ...item, file: sidecarKey })));
    suggestions.push(...result.suggestions.map((item) => ({ ...item, file: sidecarKey })));
  } else if (own.has(sidecarName)) {
    notes.push({
      code: 'existing-headers-kept',
      message: `the capture has no header sidecar, so the existing ${sidecarName} is kept; it applies to every representation of ${identity}`,
      file: responseKey,
    });
  }

  if (request.body !== undefined) {
    notes.push({
      code: 'edited-before-promotion',
      message: 'the body was edited before it was promoted',
      file: responseKey,
    });
  }
  const sidecarNotes: ProvenanceNote[] =
    request.headers === undefined
      ? []
      : [{ code: 'edited-before-promotion', message: 'the headers were edited before they were promoted' }];

  // The provenance file, merged with the identity's existing entries.
  const existingMeta = own.get(metaName);
  const existing = existingMeta === undefined ? null : parseProvenance(metaName, existingMeta);
  if (existing !== null && !existing.ok) {
    // Merging into nothing would drop its other entries (review E3); the review route refuses the same way.
    const path = [scenario, ...dirParts, metaName].join('/');
    throw new PromotionError(
      422,
      'promotion-invalid-tree',
      `The provenance file of ${responseKey} is invalid; nothing was written`,
      {
        errors: [{ code: 'invalid-provenance', source: 'fixtures', path, message: existing.message }],
      },
    );
  }
  const previous: ProvenanceDocument['files'] = existing?.ok === true ? existing.document.files : {};
  const promotedAt = rfc3339(input.now);
  const entry = (
    bytes: Uint8Array,
    report: {
      rewrites: readonly ProvenanceRewrite[];
      suggestions: readonly ProvenanceSuggestion[];
      refusals: readonly ProvenanceRefusal[];
      notes: readonly ProvenanceNote[];
    },
  ): ProvenanceEntry => ({
    source: 'promotion',
    capture: captureId,
    promotedAt,
    digest: fileDigest(bytes),
    review: 'pending',
    rewrites: report.rewrites,
    suggestions: report.suggestions,
    refusals: report.refusals,
    notes: report.notes,
  });
  const strip = <T extends { file?: string }>(items: readonly T[]): Omit<T, 'file'>[] =>
    items.map(({ file: _file, ...rest }) => rest);
  const files: Record<string, ProvenanceEntry> = { ...previous };
  files[responseName] = entry(body, {
    rewrites: bodyReport.rewrites,
    suggestions: bodyReport.suggestions,
    // Refusals that belong to no file are kept with the response file.
    refusals: [...collected.refusals, ...bodyReport.refusals],
    notes: strip(notes),
  });
  if (sidecar !== null) {
    files[sidecarName] = entry(sidecar.bytes, { ...sidecar.report, notes: sidecarNotes });
  }
  const metaBytes = serializeProvenance({ format: PROVENANCE_FORMAT, files });

  // Classify each existing file the plan would write, and apply the replacement rules.
  const conflicts: PromotionConflict[] = [];
  const planned: PlannedFile[] = [];
  const fixtureIdFor = (name: string): string | undefined =>
    identityFixture(scenarioData.root, template.segments, method, scenario, name);
  const write = (name: string, role: 'response' | 'headers', bytes: Uint8Array, mediaType: string | null): void => {
    const current = own.get(name);
    const keyed = fileKey(name);
    const path = [scenario, ...dirParts, name];
    if (current === undefined) {
      planned.push({
        file: keyed,
        path,
        role,
        bytes,
        digest: fileDigest(bytes),
        action: 'create',
        precondition: { kind: 'absent' },
        mediaType,
      });
      return;
    }
    const digest = fileDigest(current);
    const recorded = previous[name];
    const kindOf: ExistingKind =
      recorded === undefined ? 'hand-written' : recorded.digest === digest ? 'promoted' : 'modified';
    const named = request.replace.has(keyed);
    const given = request.replace.get(keyed) ?? null;
    let reason: ConflictReason | null = null;
    if (given !== null && given !== digest) reason = 'digest-mismatch';
    else if (kindOf === 'promoted') reason = named || input.auto ? null : 'exists';
    else if (!named || given === null) reason = kindOf;
    if (reason !== null) {
      const fixtureId = fixtureIdFor(name);
      conflicts.push({ file: keyed, kind: kindOf, reason, ...(fixtureId === undefined ? {} : { fixtureId }) });
    }
    planned.push({
      file: keyed,
      path,
      role,
      bytes,
      digest: fileDigest(bytes),
      action: 'replace',
      precondition: { kind: 'digest', digest },
      existing: kindOf,
      mediaType,
    });
  };
  write(responseName, 'response', body, parsed.mediaType);
  if (sidecar !== null) write(sidecarName, 'headers', sidecar.bytes, 'application/json');
  for (const file of request.replace.keys()) {
    if (!planned.some((entry) => entry.file === file)) {
      throw new PromotionError(
        400,
        'invalid-request',
        `"replace" names ${file}, which this promotion would not write`,
        {
          field: 'replace',
          file,
        },
      );
    }
  }
  planned.push({
    file: fileKey(metaName),
    path: [scenario, ...dirParts, metaName],
    role: 'provenance',
    bytes: metaBytes,
    digest: fileDigest(metaBytes),
    action: existingMeta === undefined ? 'create' : 'replace',
    precondition:
      existingMeta === undefined ? { kind: 'absent' } : { kind: 'digest', digest: fileDigest(existingMeta) },
    mediaType: 'application/json',
  });
  if (conflicts.length > 0 && !request.dryRun) throw conflictError(conflicts);

  // Validate every scenario of the tree as it would be.
  const candidate = new Map(tree);
  for (const file of planned) candidate.set(file.path.join('/'), file.bytes);
  const built = buildSnapshot(candidate, input.buildOptions);
  if (!built.ok) {
    const inherited = inheritedFiles(scenarioData.root, template.segments, method, scenario);
    throw invalidTree(built.errors, `${scenario}/${dirKey}`, `/${dirKey}`, inherited, scenario);
  }

  return Object.freeze({
    capture: captureId,
    scenario,
    endpoint: { method, path: formatTemplate(template.segments) },
    files: Object.freeze(planned),
    bindings,
    rewrites,
    suggestions,
    refusals,
    notes,
    conflicts,
    warnings: built.warnings.filter((warning) => warning.code !== 'promotions-pending'),
  });
}

/** `409 promotion-conflict` naming every file with its kind and reason, never its content or digest. */
export function conflictError(conflicts: readonly PromotionConflict[]): PromotionError {
  const names = conflicts.map((conflict) => `${conflict.file} (${conflict.reason})`).join(', ');
  return new PromotionError(
    409,
    'promotion-conflict',
    `The promotion would replace files it may not: ${names}. Name each in "replace" with the digest from its fixture detail to replace it.`,
    { conflicts },
  );
}

/** The capture's parts promotion needs, or `422`. */
function readCapture(exchange: CaptureExchange): {
  readonly method: string;
  readonly registration: string;
  readonly params: Readonly<Record<string, string>>;
  readonly responseName: string;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | readonly string[]>> | null;
} {
  const unreadable = (what: string): never => {
    throw new PromotionError(422, 'capture-unreadable', `The capture cannot be promoted: ${what}`);
  };
  const status = exchange.entry.status ?? 0;
  const of = (kind: ReturnType<typeof captureFileKind>): [string, Uint8Array | null] | undefined =>
    [...exchange.files]
      .filter(([name]) => captureFileKind(name, status) === kind)
      .sort(([a], [b]) => compareStrings(a, b))[0];
  const object = (file: [string, Uint8Array | null] | undefined, what: string): Record<string, unknown> => {
    if (file === undefined) return unreadable(`${what} is missing`);
    if (file[1] === null) return unreadable(`${what} cannot be read`);
    const parsed = parseJson(file[1]);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      return unreadable(`${what} is not a JSON object`);
    }
    return parsed.value as Record<string, unknown>;
  };
  const request = object(of('request'), 'request.json');
  const meta = object(of('meta'), `${String(status)}.meta.json`);
  const response = of('response');
  if (response === undefined) return unreadable('the response file is missing');
  if (response[1] === null) return unreadable('the response file cannot be read');
  const sidecarFile = of('headers');
  const headers = sidecarFile === undefined ? null : object(sidecarFile, `${String(status)}.headers.json`);
  if (headers !== null) {
    for (const value of Object.values(headers)) {
      const ok = typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
      if (!ok) unreadable(`${String(status)}.headers.json is not a header sidecar`);
    }
  }
  const notes = Array.isArray(meta['notes']) ? (meta['notes'] as unknown[]) : [];
  if (notes.some((note) => (note as { code?: unknown } | null)?.code === 'body-encoded')) {
    throw new PromotionError(
      422,
      'capture-body-unavailable',
      'The capture cannot be promoted: the upstream sent its body encoded, so the body was not stored',
    );
  }
  const digest = (meta['response'] as { digest?: unknown } | undefined)?.digest;
  if (typeof digest !== 'string') unreadable('its provenance has no response digest');
  if (digest !== captureDigest(response[1])) {
    throw new PromotionError(
      422,
      'capture-modified',
      'The capture cannot be promoted: its response file changed since it was recorded; promote it as recorded and edit the fixture instead',
    );
  }
  const registration = (meta['registration'] ?? request['registration']) as
    { path?: unknown; method?: unknown } | undefined;
  const method = request['method'];
  const params = request['params'];
  if (typeof registration?.path !== 'string') return unreadable('it names no registration');
  if (typeof method !== 'string') return unreadable('request.json has no method');
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    return unreadable('request.json has no params');
  const paramValues: Record<string, string> = {};
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value !== 'string') return unreadable('request.json has a parameter that is not a string');
    paramValues[name] = value;
  }
  return {
    method: method.toUpperCase(),
    registration: registration.path,
    params: paramValues,
    responseName: response[0],
    body: response[1],
    headers: headers as Readonly<Record<string, string | readonly string[]>> | null,
  };
}

/** The target scenario's effective method at a template, if it has one. */
function effectiveMethod(root: RouteNode, segments: readonly RouteSegment[], method: string): StoredMethod | undefined {
  let node: RouteNode | undefined = root;
  for (const segment of segments) {
    node = segment.kind === 'param' ? node.param?.node : node.children.get(segment.value);
    if (node === undefined) return undefined;
  }
  return node.methods.get(method);
}

/** Every response of a method, across identities. */
function responsesOf(
  stored: StoredMethod,
): { readonly id: string; readonly scenario: string; readonly source: string; readonly identity: string }[] {
  return [...stored.identities.values()].flatMap((identity) =>
    [...(identity.fallback === null ? [] : [identity.fallback]), ...identity.localized].flatMap((group) =>
      group.representations.map((response) => ({
        id: response.id,
        scenario: response.scenario,
        source: response.source,
        identity: response.identity,
      })),
    ),
  );
}

/** A fixture of the same identity as `name`, held by the target scenario, for linking a conflict to its detail. */
function identityFixture(
  root: RouteNode,
  segments: readonly RouteSegment[],
  method: string,
  scenario: string,
  name: string,
): string | undefined {
  const stored = effectiveMethod(root, segments, method);
  if (stored === undefined) return undefined;
  const parsed = parseFileName(name);
  if (parsed.kind === 'invalid') return undefined;
  const identity = parsed.variant === null ? String(parsed.status) : `${String(parsed.status)}.${parsed.variant}`;
  const own = responsesOf(stored).filter(
    (response) => response.scenario === scenario && response.identity === identity,
  );
  return (own.find((response) => response.source.endsWith(`/${name}`)) ?? own[0])?.id;
}

/** File names the target scenario inherits at the method directory. */
function inheritedFiles(
  root: RouteNode,
  segments: readonly RouteSegment[],
  method: string,
  scenario: string,
): string[] {
  const stored = effectiveMethod(root, segments, method);
  if (stored === undefined) return [];
  return [
    ...new Set(
      responsesOf(stored)
        .filter((response) => response.scenario !== scenario)
        .map((response) => response.source.split('/').pop() ?? ''),
    ),
  ].sort(compareStrings);
}

/**
 * `422 promotion-invalid-tree`. When the target method holds
 * two statuses because it inherits a response, the error carries the
 * `overrides` or `removes` entry `flow.yaml` would need.
 */
function invalidTree(
  errors: readonly StartupError[],
  dirPath: string,
  endpointKey: string,
  inherited: readonly string[],
  scenario: string,
): PromotionError {
  const needsFlow =
    inherited.length > 0 && errors.some((error) => error.code === 'multiple-responses' && error.path === dirPath);
  const hint = needsFlow
    ? {
        scenario,
        overrides: endpointKey,
        removes: inherited.map((name) => `${endpointKey}/${name}`),
        message: `"${scenario}" inherits ${inherited.join(', ')} at ${endpointKey}; add ${endpointKey} to "overrides" in its flow.yaml, or list the inherited files under "removes". Promotion never edits flow.yaml.`,
      }
    : null;
  const list = errors.map((error) => ({
    code: error.code,
    source: error.source,
    path: error.path,
    ...(error.line === undefined ? {} : { line: error.line }),
    ...(error.column === undefined ? {} : { column: error.column }),
    message: error.message,
  }));
  return new PromotionError(
    422,
    'promotion-invalid-tree',
    hint === null
      ? `The promotion would make the fixture tree invalid (${String(errors.length)} ${errors.length === 1 ? 'error' : 'errors'}); nothing was written`
      : `The promotion would make the fixture tree invalid: ${hint.message}`,
    { errors: list, ...(hint === null ? {} : { hint }) },
  );
}

/** A planned file's dry-run preview. */
export function plannedPreview(file: PlannedFile): AtlasPreview {
  return previewBody(file.role === 'response' && file.mediaType === null ? null : file.bytes, file.mediaType);
}
