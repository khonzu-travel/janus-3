import type { AtlasPromotionItem } from '../atlas/promotions.js';
import type { AtlasReloadResult } from '../atlas/types.js';
import { rfc3339 } from '../dynamic/time.js';
import { parseFileName } from '../fixtures/filename.js';
import { FLOW_FILE_NAME } from '../fixtures/flow.js';
import {
  fileDigest,
  parseProvenance,
  provenanceFileName,
  serializeProvenance,
  type ProvenanceEntry,
} from '../fixtures/provenance.js';
import type { SnapshotData } from '../fixtures/snapshot.js';
import type { CaptureReservation } from '../recording/ports.js';
import { unknownScenario } from '../sessions/scenario-error.js';
import type { BuildSnapshotOptions, FixtureFiles, HeaderMap, StartupError, StartupWarning } from '../types/index.js';
import { PromotionError, type PromotionErrorCode } from './errors.js';
import {
  conflictError,
  plannedPreview,
  planPromotion,
  type CaptureExchange,
  type ExistingKind,
  type PlannedFile,
  type PromotionConflict,
  type PromotionPlan,
  type WritePrecondition,
} from './plan.js';
import {
  parsePromotionRequest,
  parseReviewRequest,
  parseScenarioRequest,
  type PromotionRequest,
  type ScenarioRequest,
} from './request.js';

/** One file to write: validated path components below the fixture root, its bytes and its precondition. */
export interface WriteFile {
  readonly path: readonly string[];
  readonly bytes: Uint8Array;
  readonly precondition: WritePrecondition;
}

/** A file that must keep the bytes the reviewer saw; it is checked without being rewritten. */
export interface WriteCheck {
  readonly path: readonly string[];
  readonly digest: string;
}

/** What `FixtureWriter.apply` commits, all or nothing. */
export interface WritePlan {
  readonly files: readonly WriteFile[];
  readonly checks?: readonly WriteCheck[];
}

export type WriteResult = (
  | { readonly outcome: 'written' }
  /** Files, as `/`-joined paths, whose precondition failed; nothing was changed. */
  | { readonly outcome: 'conflict'; readonly files: readonly string[] }
  /** Files left as they should not be; `restored` is false when the rollback itself failed. */
  | { readonly outcome: 'failed'; readonly files: readonly string[]; readonly restored: boolean }
) & {
  /** A server may coordinate the commit and its reload under the same lock. */
  readonly reload?: AtlasReloadResult;
};

/**
 * The port through which core reads and writes the fixture tree. `read` rejects with a
 * `FixtureReadError` when the tree cannot be read.
 */
export interface FixtureWriter {
  read(): Promise<FixtureFiles>;
  apply(plan: WritePlan, signal: AbortSignal): Promise<WriteResult>;
}

/** The tree could not be read: its problems, located by source-relative path. */
export class FixtureReadError extends Error {
  override readonly name = 'FixtureReadError';
  constructor(readonly errors: readonly StartupError[]) {
    super('the fixture tree cannot be read');
  }
}

/** How promotion reads captures: the capture reader. */
export interface CaptureSource {
  exchange(scenario: string, exchange: string): Promise<CaptureExchange | null>;
}

/** The promotion ports passed to `createEngine`; promotion is unavailable without them. */
export interface PromotionPorts {
  readonly fixtures: FixtureWriter;
  readonly captures: CaptureSource;
  /** Triggers a reload with the `promotion` trigger and settles with its result. */
  reload(): Promise<AtlasReloadResult>;
  /** Validates candidate trees as startup does: custom aliases and the configured default scenario. */
  readonly buildOptions?: BuildSnapshotOptions;
}

/** A `promotion` event: file keys and codes only. */
export interface PromotionEvent {
  readonly capture?: string;
  readonly scenario: string;
  readonly outcome: 'promoted' | 'skipped' | 'reviewed';
  readonly mode?: 'staged' | 'auto';
  readonly files: readonly string[];
  readonly code?: string;
}

export type PromotionAnswer =
  | { readonly ok: true; readonly status: number; readonly document: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: PromotionErrorCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

/** `X-Mock-Promoted`. */
export type AutoOutcome = 'promoted' | 'skipped' | 'failed';

/** Writes reached from `POST /_janus/promotions` and `POST /_janus/promotions/review`. */
export interface EnginePromotions {
  /** The largest `POST /_janus/promotions` body, which carries an edited response. */
  readonly bodyLimit: number;
  promote(headers: HeaderMap, body: Uint8Array | null, signal?: AbortSignal): Promise<PromotionAnswer>;
  review(headers: HeaderMap, body: Uint8Array | null): Promise<PromotionAnswer>;
  /**
   * `POST /_janus/scenarios`: writes `<name>/flow.yaml`
   * with `extends`, then reloads. Available exactly when promotion is, since
   * it writes through the same fixture writer.
   */
  createScenario(headers: HeaderMap, body: Uint8Array | null, signal?: AbortSignal): Promise<PromotionAnswer>;
  /** Subscribes to `promotion` events; returns the unsubscribe function. */
  subscribe(listener: (event: PromotionEvent) => void): () => void;
}

export interface Promoter extends EnginePromotions {
  readonly available: boolean;
  /** Promotes a just-written capture into its own scenario. Never rejects. */
  auto(reservation: CaptureReservation): Promise<AutoOutcome>;
}

export interface PromoterOptions {
  readonly ports: PromotionPorts | undefined;
  /** False without registrations: promotion needs recording. */
  readonly recording: boolean;
  readonly mode: 'staged' | 'auto';
  readonly snapshot: () => SnapshotData;
  /** The current promotion list, after a reload. */
  readonly items: () => readonly AtlasPromotionItem[];
  readonly clock: () => number;
  /** `scenarios.default`: the parent of a created scenario that names none. */
  readonly defaultScenario: () => string;
  /** The largest promotion body; see `promotionBodyLimit`. */
  readonly bodyLimit: number;
}

const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/**
 * Promotion and review. One promotion or review runs
 * at a time; one that arrives meanwhile waits for it. Every write goes
 * through the `FixtureWriter` and is followed by a reload.
 */
export function createPromoter(options: PromoterOptions): Promoter {
  const { ports } = options;
  const available = ports !== undefined && options.recording;
  const listeners = new Set<(event: PromotionEvent) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const publish = (event: PromotionEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  };
  const unavailable = (what = 'Promotion'): PromotionAnswer => ({
    ok: false,
    status: 501,
    code: 'promotion-unavailable',
    message: options.recording
      ? `${what} is not available in this delivery mode`
      : `${what} needs recording: configure recording.endpoints`,
  });
  const answerError = (error: unknown): PromotionAnswer => {
    if (error instanceof PromotionError) {
      return {
        ok: false,
        status: error.status,
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
      };
    }
    throw error;
  };

  const read = async (): Promise<FixtureFiles> => {
    if (ports === undefined) throw new Error('unreachable');
    try {
      return await ports.fixtures.read();
    } catch (error) {
      if (error instanceof FixtureReadError) {
        throw new PromotionError(
          422,
          'promotion-invalid-tree',
          'The fixture tree cannot be read; nothing was written',
          {
            errors: error.errors.map(problemDocument),
          },
        );
      }
      throw error;
    }
  };

  /** Writes and reloads; maps the writer's outcomes to `409 changed-on-disk` and `500 promotion-write-failed`. */
  const commit = async (
    files: readonly {
      readonly file: string;
      readonly path: readonly string[];
      readonly bytes: Uint8Array;
      readonly precondition: WritePrecondition;
      readonly existing?: ExistingKind;
    }[],
    signal: AbortSignal,
    checks: readonly WriteCheck[] = [],
  ): Promise<AtlasReloadResult> => {
    if (ports === undefined) throw new Error('unreachable');
    const result = await ports.fixtures.apply(
      { files: files.map(({ path, bytes, precondition }) => ({ path, bytes, precondition })), checks },
      signal,
    );
    const fileOf = (path: string) => files.find((file) => file.path.join('/') === path);
    const keyOf = (path: string): string =>
      fileOf(path)?.file ??
      (checks.some((check) => check.path.join('/') === path) ? `/${path.split('/').slice(1).join('/')}` : path);
    // The kind the plan found (review E2): a file that was absent and now exists is hand-written.
    const kindOf = (path: string): ExistingKind => {
      const file = fileOf(path);
      if (file?.precondition.kind === 'absent') return 'hand-written';
      return file?.existing ?? 'promoted';
    };
    if (result.outcome === 'conflict') {
      throw conflictError(
        result.files.map((path) => ({
          file: keyOf(path),
          kind: kindOf(path),
          reason: 'changed-on-disk' as const,
        })),
      );
    }
    if (result.outcome === 'failed') {
      // A tree the writer could not restore is reloaded, so Atlas shows it as it is.
      if (!result.restored && result.reload === undefined) await ports.reload().catch(() => undefined);
      throw new PromotionError(
        500,
        'promotion-write-failed',
        result.restored
          ? 'The files could not be written; the tree was left unchanged'
          : 'The files could not be written, and the tree could not be fully restored',
        { files: result.files.map(keyOf), restored: result.restored },
      );
    }
    return result.reload ?? ports.reload();
  };

  const run = async (request: PromotionRequest, auto: boolean, signal: AbortSignal): Promise<PromotionAnswer> => {
    if (ports === undefined) return unavailable();
    const capture = await ports.captures.exchange(request.capture.scenario, request.capture.exchange);
    const tree = await read();
    const plan = planPromotion({
      request,
      capture,
      tree,
      snapshot: options.snapshot(),
      buildOptions: ports.buildOptions ?? {},
      now: options.clock(),
      auto,
    });
    if (request.dryRun) return { ok: true, status: 200, document: planDocument(plan, 'planned') };
    const reload = await commit(plan.files, signal);
    publish({
      capture: plan.capture,
      scenario: plan.scenario,
      outcome: 'promoted',
      mode: auto ? 'auto' : 'staged',
      files: plan.files.filter((file) => file.role !== 'provenance').map((file) => file.file),
    });
    return { ok: true, status: 201, document: { ...planDocument(plan, 'promoted'), reload } };
  };

  /** Creates a scenario directory holding only `flow.yaml`. */
  const createScenario = async (request: ScenarioRequest, signal: AbortSignal): Promise<PromotionAnswer> => {
    if (ports === undefined) return unavailable('Creating a scenario');
    const snapshot = options.snapshot();
    const exists = (): PromotionError =>
      new PromotionError(409, 'scenario-exists', `A scenario or directory named "${request.name}" exists`, {
        name: request.name,
      });
    if (snapshot.scenarios.has(request.name)) throw exists();
    const parent = request.extends ?? options.defaultScenario();
    if (!snapshot.scenarios.has(parent)) {
      const answer = unknownScenario(parent, request.extends === undefined ? 'config' : 'caller', [
        ...snapshot.scenarios.keys(),
      ]);
      throw new PromotionError(422, 'unknown-scenario', answer.message, answer.details);
    }
    // A directory the snapshot does not show as a scenario, such as one with only ignored files, is kept too.
    const prefix = `${request.name}/`;
    if ([...(await read()).keys()].some((key) => key.startsWith(prefix))) throw exists();
    const result = await ports.fixtures.apply(
      {
        files: [
          {
            path: [request.name, FLOW_FILE_NAME],
            bytes: new TextEncoder().encode(`extends: ${parent}\n`),
            precondition: { kind: 'absent' },
          },
        ],
      },
      signal,
    );
    if (result.outcome === 'conflict') throw exists();
    if (result.outcome === 'failed') {
      if (!result.restored && result.reload === undefined) await ports.reload().catch(() => undefined);
      throw new PromotionError(500, 'promotion-write-failed', 'The scenario could not be written', {
        files: [`${request.name}/${FLOW_FILE_NAME}`],
        restored: result.restored,
      });
    }
    // The answer waits for the reload, so a successful one has the scenario in the snapshot.
    const reload = result.reload ?? (await ports.reload());
    return { ok: true, status: 201, document: { name: request.name, extends: parent, reload } };
  };

  return {
    available,
    bodyLimit: options.bodyLimit,
    createScenario: async (headers, body, signal) => {
      // It writes through promotion's fixture writer, so it is gated and refused as promotion is.
      if (!available) return unavailable('Creating a scenario');
      let request: ScenarioRequest;
      try {
        request = parseScenarioRequest(headers, body);
      } catch (error) {
        return answerError(error);
      }
      return serial(() => createScenario(request, signal ?? NEVER_ABORTED).catch(answerError));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    promote: async (headers, body, signal) => {
      if (!available) return unavailable();
      let request: PromotionRequest;
      try {
        request = parsePromotionRequest(headers, body, options.bodyLimit);
      } catch (error) {
        return answerError(error);
      }
      return serial(() => run(request, false, signal ?? NEVER_ABORTED).catch(answerError));
    },
    auto: async (reservation) => {
      if (!available) return 'skipped';
      const request: PromotionRequest = { capture: reservation, ids: [], replace: new Map(), dryRun: false };
      return serial(async (): Promise<AutoOutcome> => {
        try {
          const answer = await run(request, true, NEVER_ABORTED);
          return answer.ok ? 'promoted' : 'skipped';
        } catch (error) {
          const code = error instanceof PromotionError ? error.code : 'promotion-write-failed';
          const failed = !(error instanceof PromotionError) || error.status >= 500;
          publish({
            capture: `${reservation.scenario}/${reservation.exchange}`,
            scenario: reservation.scenario,
            outcome: 'skipped',
            mode: 'auto',
            files: [],
            code,
          });
          return failed ? 'failed' : 'skipped';
        }
      });
    },
    review: async (headers, body) => {
      if (!available) return unavailable();
      let request: ReturnType<typeof parseReviewRequest>;
      try {
        request = parseReviewRequest(headers, body);
      } catch (error) {
        return answerError(error);
      }
      return serial(async (): Promise<PromotionAnswer> => {
        try {
          const snapshot = options.snapshot();
          if (!snapshot.scenarios.has(request.scenario)) {
            const answer = unknownScenario(request.scenario, 'caller', [...snapshot.scenarios.keys()]);
            throw new PromotionError(400, 'unknown-scenario', answer.message, answer.details);
          }
          const tree = await read();
          const reviewedAt = rfc3339(options.clock());
          const metas = new Map<
            string,
            { file: string; path: string[]; original: Uint8Array; files: Record<string, ProvenanceEntry> }
          >();
          const conflicts: PromotionConflict[] = [];
          for (const { file, digest } of request.files) {
            const parts = file.slice(1).split('/');
            const name = parts.pop() ?? '';
            const parsed = parseFileName(name);
            if (parsed.kind === 'invalid') {
              throw new PromotionError(400, 'invalid-request', `${file} is not a response file or header sidecar`, {
                field: 'files',
                file,
              });
            }
            const identity =
              parsed.variant === null ? String(parsed.status) : `${String(parsed.status)}.${parsed.variant}`;
            const metaName = provenanceFileName(identity);
            const metaPath = [request.scenario, ...parts, metaName];
            const metaKey = metaPath.join('/');
            let meta = metas.get(metaKey);
            if (meta === undefined) {
              const bytes = tree.get(metaKey);
              if (bytes === undefined) {
                throw new PromotionError(400, 'invalid-request', `${file} has no provenance entry`, {
                  field: 'files',
                  file,
                });
              }
              const document = parseProvenance(metaName, bytes);
              if (!document.ok) {
                throw new PromotionError(
                  422,
                  'promotion-invalid-tree',
                  `The provenance file of ${file} is invalid; nothing was written`,
                  {
                    errors: [
                      { code: 'invalid-provenance', source: 'fixtures', path: metaKey, message: document.message },
                    ],
                  },
                );
              }
              meta = {
                file: `/${[...parts, metaName].join('/')}`,
                path: metaPath,
                original: bytes,
                files: { ...document.document.files },
              };
              metas.set(metaKey, meta);
            }
            const entry = meta.files[name];
            if (entry === undefined) {
              throw new PromotionError(400, 'invalid-request', `${file} has no provenance entry`, {
                field: 'files',
                file,
              });
            }
            const current = tree.get([request.scenario, ...parts, name].join('/'));
            if (current === undefined) {
              throw new PromotionError(400, 'invalid-request', `${file} does not exist`, { field: 'files', file });
            }
            const now = fileDigest(current);
            if (now !== digest) {
              conflicts.push({ file, kind: now === entry.digest ? 'promoted' : 'modified', reason: 'digest-mismatch' });
              continue;
            }
            // Only the review state changes; the digest stays the one promoted.
            meta.files[name] = {
              ...entry,
              review: 'reviewed',
              reviewedAt: entry.review === 'reviewed' ? (entry.reviewedAt ?? reviewedAt) : reviewedAt,
            };
          }
          if (conflicts.length > 0) throw conflictError(conflicts);
          const writes = [...metas.values()].map((meta) => ({
            file: meta.file,
            path: meta.path,
            bytes: serializeProvenance({ format: 'janus.provenance.v1', files: meta.files }),
            precondition: { kind: 'digest' as const, digest: fileDigest(meta.original) },
          }));
          const checks = request.files.map(({ file, digest }) => ({
            path: [request.scenario, ...file.slice(1).split('/')],
            digest,
          }));
          const reload = await commit(writes, NEVER_ABORTED, checks);
          const files = request.files.map((entry) => entry.file);
          publish({ scenario: request.scenario, outcome: 'reviewed', files });
          const items = options
            .items()
            .filter((item) => item.scenario === request.scenario && files.includes(item.file));
          return { ok: true, status: 200, document: { items, reload } };
        } catch (error) {
          return answerError(error);
        }
      });
    },
  };
}

/** The promotion result, or a dry run's plan. */
function planDocument(plan: PromotionPlan, outcome: 'promoted' | 'planned'): Record<string, unknown> {
  const dryRun = outcome === 'planned';
  return {
    outcome,
    capture: plan.capture,
    scenario: plan.scenario,
    endpoint: plan.endpoint,
    files: plan.files.map((file: PlannedFile) => ({
      file: file.file,
      role: file.role,
      action: file.action,
      digest: file.digest,
      ...(dryRun ? { preview: plannedPreview(file) } : {}),
    })),
    bindings: plan.bindings.map(({ id, value, tier, source }) => ({ id, value, tier, source })),
    rewrites: plan.rewrites,
    suggestions: plan.suggestions,
    refusals: plan.refusals,
    notes: plan.notes,
    warnings: plan.warnings.map(problemDocument),
    ...(dryRun ? { applicable: plan.conflicts.length === 0, conflicts: plan.conflicts } : {}),
  };
}

/** A startup problem, located by source-relative path only. */
function problemDocument(problem: StartupError | StartupWarning): Record<string, unknown> {
  return {
    code: problem.code,
    source: problem.source,
    path: problem.path,
    ...(problem.line === undefined ? {} : { line: problem.line }),
    ...(problem.column === undefined ? {} : { column: problem.column }),
    message: problem.message,
  };
}
