import { toHex } from '../bytes.js';
import { CanonicalWriter, compareStrings } from '../canonical.js';
import {
  dynamicFixture,
  scanHeaderSidecar,
  scanJsonBody,
  scanTextBody,
  type BodyScan,
  type HeaderScan,
} from '../dynamic/fixture.js';
import { expandAliases, type ClockExpansion, type GrammarContext } from '../dynamic/grammar.js';
import { sortStartupProblems } from '../errors/startup.js';
import { mediaTypeEssence, parseMediaType } from '../http/media-type.js';
import { decodePathSegment, formatTemplate, type RouteSegment } from '../http/target.js';
import { isUppercaseMethodToken } from '../http/token.js';
import { endpointId, fixtureId } from '../ids.js';
import type {
  BuildSnapshotOptions,
  BuildSnapshotResult,
  FixtureFiles,
  FixtureSnapshot,
  StartupError,
  StartupErrorCode,
  StartupWarning,
} from '../types/index.js';
import { scenarioIdLiterals } from '../controls/conditions.js';
import type { ControlProblem } from '../controls/yaml.js';
import { parseEntityTag, weakMatch } from '../http/etag.js';
import { suggest } from '../suggest.js';
import { ACCEPTS_FILE_NAME, parseAccepts, type AcceptsPolicy } from './accepts.js';
import { bodyKind } from './body-kind.js';
import {
  CONTROL_FILE_NAMES,
  EXPECT_FILE_NAME,
  FAULT_FILE_NAME,
  PAGES_FILE_NAME,
  parseExpect,
  parseFault,
  parsePages,
  parseSequence,
  parseVariants,
  SEQUENCE_FILE_NAME,
  VARIANTS_FILE_NAME,
  type ControlResult,
  type IdentityReference,
} from './controls.js';
import { parseFileName } from './filename.js';
import {
  EMPTY_FLOW,
  FLOW_FILE_NAME,
  isScenarioName,
  MAX_SCENARIO_NAME_BYTES,
  parseFlow,
  splitReference,
  type Flow,
  type FlowReference,
} from './flow.js';
import { isIgnoredFileName } from './ignored.js';
import { formatLatency } from './latency.js';
import { scanJson, type TextPosition } from './json.js';
import {
  fileDigest,
  parseProvenance,
  parseProvenanceName,
  PROVENANCE_FORMAT,
  type ProvenanceEntry,
} from './provenance.js';
import { parseHeaderSidecar, parseJson, type SidecarResult } from './sidecar.js';
import {
  registerSnapshot,
  type HeldControl,
  type ProvenanceRecord,
  type RepresentationGroup,
  type RouteNode,
  type ScenarioData,
  type ScenarioIdUse,
  type ShadowedFile,
  type StoredControls,
  type StoredIdentity,
  type StoredMethod,
  type StoredResponse,
} from './snapshot.js';
import { isBodylessStatus, requiresLocation } from './status.js';

/** The scenario every tree must have, and the one every chain ends at. */
export const DEFAULT_SCENARIO = 'default';

/** The first path segment reserved for Janus operational APIs. */
export const RESERVED_SEGMENT = '_janus';

/** At most this many scenarios, and this many in one chain. */
export const MAX_SCENARIOS = 256;
export const MAX_CHAIN = 16;

/** One file of a scenario's effective tree; `scenario` holds it. */
interface SourceFile {
  readonly key: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly scenario: string;
}

/** A file an ancestor held at this method directory that the effective tree no longer has. */
interface HiddenFile {
  readonly scenario: string;
  readonly key: string;
  readonly locale: string | null;
  readonly mediaType: string | null;
  readonly variant: string | null;
  readonly by: 'replaced' | 'overrides' | 'removes';
}

/** One scenario's effective tree, keyed by method directory below the scenario root ("v1/cart/GET"). */
interface EffectiveTree {
  readonly dirs: Map<string, Map<string, SourceFile>>;
  readonly hidden: Map<string, readonly HiddenFile[]>;
  readonly ids: Map<string, { readonly value: string; readonly from: string }>;
}

interface ScenarioSource {
  readonly name: string;
  flow: SourceFile | null;
  /** Own files by method directory below the scenario root. */
  readonly dirs: Map<string, SourceFile[]>;
  /** Own provenance files by directory below the scenario root; never served. */
  readonly provenance: Map<string, SourceFile[]>;
}

interface RouteDraft {
  readonly segments: readonly RouteSegment[];
  /** Raw directory names of one spelling, for locating template conflicts. */
  readonly raw: readonly string[];
  /** Raw spellings that decode to this logical path, each with the source directory to name; more than one is ambiguous. */
  readonly rawDirs: Map<string, string>;
  readonly methods: Map<string, StoredMethod>;
  readonly hidden: Map<string, readonly HiddenFile[]>;
}

/**
 * Validates a complete fixture tree and builds an immutable snapshot, or
 * returns every independent startup error found. Every
 * directory under the data root is a scenario; each one's effective tree is
 * built from its parent's and validated as the tree a request would see.
 * Pure: the same files always produce the same snapshot or the same errors,
 * whatever the map's enumeration order.
 */
export function buildSnapshot(files: FixtureFiles, options: BuildSnapshotOptions = {}): BuildSnapshotResult {
  const aliases = expandAliases(options.aliases ?? {}).aliases;
  const errors = new ErrorCollector();
  const warnings = new WarningCollector();
  const keys = [...files.keys()].sort(compareStrings);

  const sources = new Map<string, ScenarioSource>();
  const topNames = new Set<string>();
  const invalidNames = new Set<string>();

  for (const key of keys) {
    const parts = key.split('/');
    if (key.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
      errors.add('invalid-source-path', key, 'source paths must be relative, with no empty, "." or ".." parts');
      continue;
    }
    const name = parts[parts.length - 1] ?? '';
    const top = parts[0] ?? '';

    if (parts.length === 1) {
      if (isIgnoredFileName(name)) continue;
      errors.add(
        'invalid-scenario-name',
        key,
        top === DEFAULT_SCENARIO
          ? '"default" must be a directory'
          : 'files are not allowed at the data root; put fixtures under a scenario directory such as default/',
      );
      continue;
    }
    topNames.add(top);
    if (!isScenarioName(top)) {
      invalidNames.add(top);
      continue;
    }
    let source = sources.get(top);
    if (source === undefined) {
      source = { name: top, flow: null, dirs: new Map(), provenance: new Map() };
      sources.set(top, source);
    }
    if (isIgnoredFileName(name)) continue;
    const file: SourceFile = { key, name, bytes: files.get(key) ?? new Uint8Array(), scenario: top };
    if (parts.length === 2) {
      if (name === FLOW_FILE_NAME) source.flow = file;
      else {
        errors.add(
          'misplaced-file',
          key,
          `response files belong in a method directory, e.g. ${top}/GET/200.txt; only ${FLOW_FILE_NAME} may sit directly in a scenario directory`,
        );
      }
      continue;
    }
    const dir = parts.slice(1, -1).join('/');
    // `<identity>.meta.json` records provenance; it is read, never served.
    const target = parseProvenanceName(name) === null ? source.dirs : source.provenance;
    const entries = target.get(dir) ?? [];
    entries.push(file);
    target.set(dir, entries);
  }

  for (const name of invalidNames) {
    errors.add(
      'invalid-scenario-name',
      name,
      `"${name}" is not a scenario name: use lowercase letters and digits in words joined by "-", at most ${String(MAX_SCENARIO_NAME_BYTES)} bytes`,
      { token: name },
    );
  }
  reportNameCollisions(topNames, errors);
  if (sources.size > MAX_SCENARIOS) {
    errors.add(
      'too-many-scenarios',
      '',
      `the data root has ${String(sources.size)} scenarios; at most ${String(MAX_SCENARIOS)} are allowed`,
    );
  }
  if (!sources.has(DEFAULT_SCENARIO) && !files.has(DEFAULT_SCENARIO)) {
    errors.add(
      'missing-default-scenario',
      DEFAULT_SCENARIO,
      'the data root must contain a non-empty "default" directory',
    );
  }
  const required = options.defaultScenario;
  if (required !== undefined && required !== DEFAULT_SCENARIO && !sources.has(required)) {
    errors.add(
      'unknown-default-scenario',
      '',
      `scenarios.default names "${required}", but the data root has no such scenario directory`,
      { token: required },
    );
  }

  const graph = buildGraph(sources, errors);
  const trees = new Map<string, EffectiveTree>();
  const reporter = new TreeReporter(errors);
  /** Method directories with the same files validate to the same result, so each set is checked once. */
  const validated = new Map<string, StoredMethod | null>();
  const scenarios = new Map<string, { readonly routes: Map<string, RouteDraft>; readonly tree: EffectiveTree }>();

  for (const name of graph.order) {
    const source = sources.get(name);
    const node = graph.nodes.get(name);
    if (source === undefined || node === undefined) continue;
    const parentTree = node.parent === null ? null : trees.get(node.parent);
    if (node.parent !== null && parentTree === undefined) continue;
    const tree = effectiveTree(source, node, parentTree ?? null, errors);
    trees.set(name, tree);
    const routes = buildRoutes(name, tree, node.chain, {
      aliases,
      validated,
      reporter,
      errors,
      warnings,
      dropCors: options.fixtureCors === true,
    });
    scenarios.set(name, { routes, tree });
  }

  const provenance = collectProvenance(sources, errors, warnings);
  if (options.receivableMethods !== undefined) {
    reportUnreceivableMethods(sources, new Set(options.receivableMethods), warnings);
  }

  if (errors.size > 0) return { ok: false, errors: errors.sorted(), warnings: warnings.sorted() };

  const data = new Map<string, ScenarioData>();
  for (const name of graph.order) {
    const built = scenarios.get(name);
    const node = graph.nodes.get(name);
    if (built === undefined || node === undefined) continue;
    let fixtureCount = 0;
    for (const route of built.routes.values()) fixtureCount += route.methods.size;
    data.set(
      name,
      deepFreezeScenario({
        name,
        description: node.flow.description,
        parent: node.parent,
        chain: node.chain,
        ids: [...built.tree.ids]
          .sort(([a], [b]) => compareStrings(a, b))
          .map(([id, { value, from }]) => ({ name: id, value, from })),
        overrides: node.flow.overrides.map((entry) => entry.value),
        removes: node.flow.removes.map((entry) => entry.value),
        latency: node.flow.latency,
        effectiveLatency: effectiveLatency(node.chain, graph.nodes),
        root: buildTrie(built.routes),
        fixtureCount,
        routeCount: built.routes.size,
      }),
    );
  }
  const base = data.get(DEFAULT_SCENARIO);
  if (base === undefined) throw new Error('a valid tree always has the default scenario');
  const names = [...data.keys()].sort(compareStrings);
  const ordered = new Map(names.map((name) => [name, data.get(name) as ScenarioData]));
  const summary: FixtureSnapshot = Object.freeze({
    version: snapshotVersion(scenarios.get(DEFAULT_SCENARIO)?.routes ?? new Map(), ordered, provenance.files),
    fixtureCount: base.fixtureCount,
    routeCount: base.routeCount,
  });
  return {
    ok: true,
    snapshot: registerSnapshot(summary, {
      version: summary.version,
      root: base.root,
      scenarios: ordered,
      provenance: provenance.records,
    }),
    warnings: warnings.sorted(),
  };
}

/**
 * Reads every provenance file: `invalid-provenance`
 * for a malformed one, `stale-provenance` for an entry whose file is gone,
 * and `promotions-pending` with the count of entries awaiting review. Each
 * remaining entry is compared with its file's current digest.
 */
function collectProvenance(
  sources: ReadonlyMap<string, ScenarioSource>,
  errors: ErrorCollector,
  warnings: WarningCollector,
): { readonly records: readonly ProvenanceRecord[]; readonly files: readonly SourceFile[] } {
  const records: ProvenanceRecord[] = [];
  const files: SourceFile[] = [];
  for (const source of [...sources.values()].sort((a, b) => compareStrings(a.name, b.name))) {
    for (const [dir, metas] of [...source.provenance].sort(([a], [b]) => compareStrings(a, b))) {
      const own = new Map((source.dirs.get(dir) ?? []).map((file) => [file.name, file]));
      for (const meta of metas.sort((a, b) => compareStrings(a.key, b.key))) {
        files.push(meta);
        const parsed = parseProvenance(meta.name, meta.bytes);
        if (!parsed.ok) {
          errors.add('invalid-provenance', meta.key, `invalid provenance file: ${parsed.message}`);
          continue;
        }
        for (const name of Object.keys(parsed.document.files).sort(compareStrings)) {
          const entry = parsed.document.files[name] as ProvenanceEntry;
          const file = own.get(name);
          if (file === undefined) {
            warnings.push(
              Object.freeze({
                code: 'stale-provenance',
                source: 'fixtures',
                path: meta.key,
                message: `the provenance entry for "${name}" names a file that no longer exists; remove the entry`,
              }),
            );
            continue;
          }
          const digest = fileDigest(file.bytes);
          records.push(
            Object.freeze({
              scenario: source.name,
              file: `/${dir}/${name}`,
              source: file.key,
              meta: meta.key,
              kind: parseFileName(name).kind === 'headers' ? ('headers' as const) : ('response' as const),
              entry,
              digest,
              modified: digest !== entry.digest,
            }),
          );
        }
      }
    }
  }
  const pending = records.filter((record) => record.entry.review === 'pending').length;
  if (pending > 0) {
    warnings.push(
      Object.freeze({
        code: 'promotions-pending',
        source: 'fixtures',
        path: '',
        message: `${String(pending)} promoted ${pending === 1 ? 'file is' : 'files are'} pending review; check them and mark them reviewed`,
      }),
    );
  }
  return { records: Object.freeze(records), files };
}

interface GraphNode {
  readonly flow: Flow;
  readonly parent: string | null;
  /** The scenario first, ending with "default". */
  readonly chain: readonly string[];
}

/**
 * Parses every `flow.yaml` and orders the scenarios parents first. A scenario whose flow, parent or
 * chain is broken is left out,
 * and so are its descendants: their errors are the broken ancestor's.
 */
function buildGraph(
  sources: ReadonlyMap<string, ScenarioSource>,
  errors: ErrorCollector,
): { readonly nodes: Map<string, GraphNode>; readonly order: readonly string[] } {
  const flows = new Map<string, { flow: Flow; parent: string | null; key: string }>();
  for (const [name, source] of sources) {
    let flow = EMPTY_FLOW;
    if (source.flow !== null) {
      const parsed = parseFlow(source.flow.bytes);
      if (!parsed.ok) {
        for (const problem of parsed.problems) errors.add(problem.code, source.flow.key, problem.message, problem);
        continue;
      }
      flow = parsed.flow;
    }
    const key = source.flow?.key ?? name;
    if (name === DEFAULT_SCENARIO && flow.extends !== null) {
      errors.add('invalid-flow', key, '"default" has no parent, so its flow.yaml cannot use "extends"', {
        position: flow.extendsPosition,
        token: 'extends',
      });
      continue;
    }
    const parent = name === DEFAULT_SCENARIO ? null : (flow.extends ?? DEFAULT_SCENARIO);
    if (parent === name) {
      errors.add('scenario-cycle', key, `"${name}" extends itself`, { position: flow.extendsPosition, token: name });
      continue;
    }
    if (parent !== null && !sources.has(parent)) {
      errors.add('unknown-parent-scenario', key, `"extends" names "${parent}", which is not a scenario directory`, {
        position: flow.extendsPosition,
        token: parent,
      });
      continue;
    }
    flows.set(name, { flow, parent, key });
  }

  // Cycles: follow parents from each scenario; a walk that revisits its own path found one.
  const inCycle = new Set<string>();
  for (const start of [...flows.keys()].sort(compareStrings)) {
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && !inCycle.has(current) && flows.has(current)) {
      const index = path.indexOf(current);
      if (index !== -1) {
        const cycle = path.slice(index).sort(compareStrings);
        for (const member of cycle) inCycle.add(member);
        const first = cycle[0] ?? start;
        errors.add(
          'scenario-cycle',
          flows.get(first)?.key ?? first,
          `the scenarios ${cycle.map((member) => `"${member}"`).join(', ')} extend each other in a cycle`,
        );
        break;
      }
      path.push(current);
      current = flows.get(current)?.parent ?? null;
    }
  }

  const nodes = new Map<string, GraphNode>();
  const chainOf = (name: string): readonly string[] | null => {
    const known = nodes.get(name);
    if (known !== undefined) return known.chain;
    const entry = flows.get(name);
    if (entry === undefined || inCycle.has(name)) return null;
    const above = entry.parent === null ? [] : chainOf(entry.parent);
    if (above === null) return null;
    const chain = Object.freeze([name, ...above]);
    if (chain.length > MAX_CHAIN) {
      // Reported only where the limit is first passed; deeper descendants inherit the problem.
      if (above.length === MAX_CHAIN) {
        errors.add(
          'scenario-chain-too-deep',
          entry.key,
          `"${name}" is ${String(chain.length)} scenarios from "default" counting both; at most ${String(MAX_CHAIN)} are allowed`,
        );
      }
      return null;
    }
    nodes.set(name, { flow: entry.flow, parent: entry.parent, chain });
    return chain;
  };
  for (const name of [...flows.keys()].sort(compareStrings)) chainOf(name);
  const order = [...nodes.keys()].sort(
    (a, b) => (nodes.get(a)?.chain.length ?? 0) - (nodes.get(b)?.chain.length ?? 0) || compareStrings(a, b),
  );
  return { nodes, order };
}

/** A file's representation key: status, variant, locale and media type, case-insensitively. */
function representationKey(file: SourceFile): string | null {
  const parsed = parseFileName(file.name);
  if (parsed.kind !== 'response') return null;
  return [
    parsed.status,
    parsed.variant ?? '',
    parsed.locale?.toLowerCase() ?? '',
    parsed.mediaType?.toLowerCase() ?? '',
  ].join('\0');
}

/** A response file's identity, or null for any other file. */
function identityOf(file: SourceFile): string | null {
  const parsed = parseFileName(file.name);
  if (parsed.kind === 'invalid') return null;
  return parsed.variant === null ? String(parsed.status) : `${String(parsed.status)}.${parsed.variant}`;
}

/**
 * Builds a scenario's effective tree from its parent's:
 * `overrides`, then `removes`, then its own files replacing by
 * representation key. Sidecars travel with their response files.
 */
function effectiveTree(
  source: ScenarioSource,
  node: GraphNode,
  parent: EffectiveTree | null,
  errors: ErrorCollector,
): EffectiveTree {
  const name = source.name;
  const flowKey = source.flow?.key ?? name;
  const dirs = new Map<string, Map<string, SourceFile>>();
  for (const [dir, entries] of parent?.dirs ?? []) dirs.set(dir, new Map(entries));
  const fresh = new Map<string, HiddenFile[]>();
  const hide = (dir: string, file: SourceFile, by: HiddenFile['by']): void => {
    const parsed = parseFileName(file.name);
    if (parsed.kind !== 'response') return;
    const list = fresh.get(dir) ?? [];
    list.push({
      scenario: file.scenario,
      key: file.key,
      locale: parsed.locale,
      mediaType: parsed.mediaType,
      variant: parsed.variant,
      by,
    });
    fresh.set(dir, list);
  };
  const stale = (entry: FlowReference, what: string): void => {
    errors.add(
      'stale-scenario-reference',
      flowKey,
      `"${entry.value}" names no ${what} in "${node.parent ?? ''}"'s effective tree, so it changes nothing; check whether it was renamed`,
      { position: entry.position, token: entry.value },
    );
  };

  // 1. `overrides`: nothing in the named method directory is inherited.
  for (const entry of node.flow.overrides) {
    const dir = splitReference(entry.value, 'endpoint')?.dir ?? '';
    const inherited = dirs.get(dir);
    if (inherited === undefined) {
      stale(entry, 'method directory');
      continue;
    }
    for (const file of inherited.values()) hide(dir, file, 'overrides');
    dirs.delete(dir);
  }

  // 2. `removes`: the named file leaves the inherited set.
  for (const entry of node.flow.removes) {
    const reference = splitReference(entry.value, 'file');
    const dir = reference?.dir ?? '';
    const fileName = reference?.file ?? '';
    const own = source.dirs.get(dir) ?? [];
    const target = [...(dirs.get(dir)?.values() ?? [])].find(
      (file) => file.name === fileName && parseFileName(file.name).kind !== 'headers',
    );
    const targetKey = target === undefined ? null : representationKey(target);
    if (own.some((file) => file.name === fileName || (targetKey !== null && representationKey(file) === targetKey))) {
      errors.add(
        'contradictory-scenario-reference',
        flowKey,
        `"${entry.value}" is removed, but "${name}" defines that file itself; drop one of the two`,
        { position: entry.position, token: entry.value },
      );
      continue;
    }
    if (target === undefined) {
      stale(entry, 'file');
      continue;
    }
    hide(dir, target, 'removes');
    dirs.get(dir)?.delete(target.key);
  }

  // 3. Own files replace inherited files with the same representation key.
  for (const [dir, own] of source.dirs) {
    const entries = dirs.get(dir) ?? new Map<string, SourceFile>();
    dirs.set(dir, entries);
    const ownKeys = new Set(own.map(representationKey).filter((key) => key !== null));
    // Control files are replaced whole, by name.
    const ownControls = new Set(own.filter((file) => CONTROL_FILE_NAMES.has(file.name)).map((file) => file.name));
    for (const file of [...entries.values()]) {
      const key = representationKey(file);
      if (key !== null && ownKeys.has(key)) {
        hide(dir, file, 'replaced');
        entries.delete(file.key);
      } else if (ownControls.has(file.name)) {
        entries.delete(file.key);
      }
    }
    for (const file of own) entries.set(file.key, file);
  }

  // A sidecar leaves with the last response of its identity in its own scenario; an empty directory leaves too.
  for (const [dir, entries] of dirs) {
    for (const file of [...entries.values()]) {
      if (file.scenario === name) continue;
      const parsed = parseFileName(file.name);
      if (parsed.kind !== 'headers') continue;
      const identity = identityOf(file);
      const used = [...entries.values()].some(
        (other) =>
          other.scenario === file.scenario &&
          parseFileName(other.name).kind === 'response' &&
          identityOf(other) === identity,
      );
      if (!used) entries.delete(file.key);
    }
    const answers = [...entries.values()].some(
      (file) => !CONTROL_FILE_NAMES.has(file.name) && parseFileName(file.name).kind !== 'headers',
    );
    if (entries.size === 0 || (!source.dirs.has(dir) && !answers)) dirs.delete(dir);
  }

  // Hidden files: this scenario's own, then those its ancestors hid, each listed once, nearest holder first.
  const hidden = new Map<string, readonly HiddenFile[]>();
  const distance = new Map(node.chain.map((scenario, index) => [scenario, index]));
  for (const dir of dirs.keys()) {
    const list = [...(fresh.get(dir) ?? []), ...(parent?.hidden.get(dir) ?? [])];
    if (list.length === 0) continue;
    const ordered = list
      .map((file, index) => ({ file, index }))
      .sort(
        (a, b) =>
          (distance.get(a.file.scenario) ?? 0) - (distance.get(b.file.scenario) ?? 0) ||
          compareStrings(a.file.key, b.file.key) ||
          a.index - b.index,
      )
      .map(({ file }) => file);
    hidden.set(dir, Object.freeze(ordered));
  }

  const ids = new Map(parent?.ids ?? []);
  for (const { name: id, value } of node.flow.ids) ids.set(id, { value, from: name });
  return { dirs, hidden, ids };
}

interface RouteContext {
  readonly aliases: ReadonlyMap<string, ClockExpansion>;
  readonly validated: Map<string, StoredMethod | null>;
  readonly reporter: TreeReporter;
  readonly errors: ErrorCollector;
  readonly warnings: WarningCollector;
  /** Fixture CORS is on, so sidecar `Access-Control-*` headers are dropped. */
  readonly dropCors: boolean;
}

/** Validates one scenario's effective tree with every rule and collects its routes. */
function buildRoutes(
  scenario: string,
  tree: EffectiveTree,
  chain: readonly string[],
  context: RouteContext,
): Map<string, RouteDraft> {
  const { reporter, errors, warnings } = context;
  const report = (code: StartupErrorCode, rel: string, message: string, detail?: ErrorDetail): void => {
    reporter.add(scenario, code, rel, message, detail);
  };
  const dirsWithSubdirs = new Set<string>();
  for (const dir of tree.dirs.keys()) {
    const parts = dir.split('/');
    for (let end = 1; end < parts.length; end++) dirsWithSubdirs.add(parts.slice(0, end).join('/'));
  }
  const distance = new Map(chain.map((name, index) => [name, index]));

  const routes = new Map<string, RouteDraft>();
  for (const dir of [...tree.dirs.keys()].sort(compareStrings)) {
    const entries = [...(tree.dirs.get(dir)?.values() ?? [])].sort((a, b) => compareStrings(a.key, b.key));
    const parts = dir.split('/');
    const method = parts[parts.length - 1] ?? '';
    const rawSegments = parts.slice(0, -1);
    let structural = true;

    if (dirsWithSubdirs.has(dir)) {
      report(
        'misplaced-file',
        dir,
        'this directory holds response files and subdirectories; response files belong only in the last (method) directory',
      );
      structural = false;
    }
    if (!isUppercaseMethodToken(method)) {
      report(
        'invalid-method',
        dir,
        `"${method}" holds response files, so it must be an uppercase HTTP method directory such as GET`,
        { token: method },
      );
      structural = false;
    }
    const segments = decodeRouteSegments(rawSegments, report);
    const key = entries.map((entry) => entry.key).join('\0');
    let response = context.validated.get(key);
    if (response === undefined) {
      const template = segments === null ? null : templateKey(segments);
      const pathParameters =
        segments === null ? null : segments.flatMap((segment) => (segment.kind === 'param' ? [segment.name] : []));
      response = validateMethodDirectory(
        `${scenario}/${dir}`,
        entries,
        (holder) => (template === null ? '' : endpointId(holder, method, template)),
        { aliases: context.aliases, pathParameters },
        (file) => (file.scenario === scenario ? file.name : file.key),
        errors,
        warnings,
        context.dropCors,
      );
      context.validated.set(key, response);
    }
    if (response !== null) reportScenarioIds(scenario, tree, response, errors);
    if (!structural || segments === null || response === null) continue;

    const logicalKey = JSON.stringify(templateKey(segments));
    const route = routes.get(logicalKey) ?? {
      segments,
      raw: rawSegments,
      rawDirs: new Map<string, string>(),
      methods: new Map(),
      hidden: new Map(),
    };
    // Name the source directory that holds the nearest files, so a message points at what to rename.
    const holder =
      entries.map((entry) => entry.scenario).sort((a, b) => (distance.get(a) ?? 0) - (distance.get(b) ?? 0))[0] ??
      scenario;
    const spelling = rawSegments.join('/');
    if (!route.rawDirs.has(spelling)) route.rawDirs.set(spelling, [holder, ...rawSegments].join('/'));
    if (!route.methods.has(method)) {
      route.methods.set(method, response);
      const hidden = tree.hidden.get(dir);
      if (hidden !== undefined) route.hidden.set(method, hidden);
    }
    routes.set(logicalKey, route);
  }

  reportAmbiguousRoutes(routes, report);
  reportTemplateConflicts(routes, report);
  return routes;
}

/**
 * `unknown-scenario-id`: every `{{$scenario.ids.<name>}}` a
 * method's files and controls use must exist in each scenario that has them.
 */
function reportScenarioIds(scenario: string, tree: EffectiveTree, stored: StoredMethod, errors: ErrorCollector): void {
  for (const use of stored.scenarioIds) {
    if (tree.ids.has(use.name)) continue;
    const known = [...tree.ids.keys()].sort(compareStrings);
    const suggestion = suggest(use.name, known);
    errors.add(
      'unknown-scenario-id',
      use.path,
      `scenario "${scenario}" has no id "${use.name}"${known.length === 0 ? '; add it under "ids" in its flow.yaml' : `; its ids are ${known.join(', ')}`}${suggestion === null ? '' : `; did you mean "${suggestion}"?`}`,
      { position: use.position, token: use.token },
    );
  }
}

/** Top-level directory names that differ only by case cannot coexist on common filesystems. */
function reportNameCollisions(names: ReadonlySet<string>, errors: ErrorCollector): void {
  const byFolded = new Map<string, string[]>();
  for (const name of names) {
    const folded = name.normalize('NFC').toLowerCase();
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), name]);
  }
  for (const spellings of byFolded.values()) {
    if (spellings.length < 2) continue;
    const sorted = spellings.sort(compareStrings);
    errors.add(
      'case-conflict',
      sorted[0] ?? '',
      `${sorted.map((name) => `"${name}"`).join(' and ')} differ only by case, which is not portable across filesystems`,
    );
  }
}

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

type TreeReport = (code: StartupErrorCode, rel: string, message: string, detail?: ErrorDetail) => void;

/** Decodes a route's directory names into literal and template segments, or reports why it cannot. */
function decodeRouteSegments(rawSegments: readonly string[], report: TreeReport): RouteSegment[] | null {
  const segments: RouteSegment[] = [];
  const bound = new Set<string>();
  let ok = true;
  for (const [index, raw] of rawSegments.entries()) {
    const path = rawSegments.slice(0, index + 1).join('/');
    const decoded = decodePathSegment(raw);
    if (!decoded.ok) {
      report('invalid-path-segment', path, `directory name ${decoded.reason}`, { token: raw });
      ok = false;
      continue;
    }
    const value = decoded.value;
    if (value.includes('{') || value.includes('}')) {
      const name = PARAMETER.exec(value)?.[1];
      if (name === undefined) {
        report(
          'invalid-path-parameter',
          path,
          `"${raw}" is not a path parameter: write the whole directory name as {name}, where name is a letter or "_" followed by letters, digits or "_"`,
          { token: raw },
        );
        ok = false;
      } else if (bound.has(name)) {
        report(
          'duplicate-path-parameter',
          path,
          `the route already binds {${name}}; give each parameter a distinct name`,
          {
            token: raw,
          },
        );
        ok = false;
      } else {
        bound.add(name);
        segments.push({ kind: 'param', name });
      }
      continue;
    }
    if (index === 0 && value === RESERVED_SEGMENT) {
      report('reserved-path', path, `"/${RESERVED_SEGMENT}" is reserved for Janus operational APIs`, { token: raw });
      ok = false;
      continue;
    }
    segments.push({ kind: 'literal', value });
  }
  return ok ? segments : null;
}

/** Canonical template segments: decoded literals, and `{name}` for parameters (never ambiguous: literals have no braces). */
export function templateKey(segments: readonly RouteSegment[]): string[] {
  return segments.map((segment) => (segment.kind === 'param' ? `{${segment.name}}` : segment.value));
}

interface ParsedResponse {
  readonly file: SourceFile;
  readonly status: number;
  readonly mediaType: string | null;
  readonly extension: string | null;
  readonly locale: string | null;
  readonly variant: string | null;
}

/** What one header sidecar contributes to every response of its identity. */
interface StatusHeaders {
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly dropped: readonly { readonly name: string; readonly values: readonly string[] }[];
  /** The `Content-Type` to send instead of the filename's media type, when the sidecar sets one. */
  readonly contentType: string | null;
  /** Replayed header values with tokens. */
  readonly dynamic: HeaderScan;
  /** The sidecar file and its digest. */
  readonly file: { readonly source: string; readonly digest: string; readonly bytes: Uint8Array };
}

/** The control files of one method directory as parsed, before their references are checked. */
interface ParsedControls {
  readonly controls: StoredControls;
  readonly identities: readonly { readonly file: SourceFile; readonly reference: IdentityReference }[];
  readonly files: StoredMethod['controlFiles'];
  readonly scenarioIds: readonly ScenarioIdUse[];
  /** The directory has `sequence.yaml` or a rule sequence, or a broken file that may hold one. */
  readonly sequencePosition: boolean;
}

/**
 * Parses the control files of one effective method directory, reporting `invalid-control` and `conflicting-controls`.
 */
function parseMethodControls(
  dir: string,
  entries: readonly SourceFile[],
  pathParameters: readonly string[] | null,
  errors: ErrorCollector,
): ParsedControls {
  const context = { pathParameters };
  const identities: { file: SourceFile; reference: IdentityReference }[] = [];
  const scenarioIds: ScenarioIdUse[] = [];
  const files: { name: string; scenario: string; bytes: Uint8Array }[] = [];
  // An object, so the closure's write is visible to the checks below.
  const state = { broken: false };
  const read = <T>(name: string, parse: (bytes: Uint8Array) => ControlResult<T>): HeldControl<T> | null => {
    const file = entries.find((entry) => entry.name === name);
    if (file === undefined) return null;
    files.push({ name, scenario: file.scenario, bytes: file.bytes });
    const parsed = parse(file.bytes);
    if (!parsed.ok) {
      state.broken = true;
      for (const problem of parsed.problems) addControlProblem(errors, file.key, problem);
      return null;
    }
    for (const reference of parsed.identities) identities.push({ file, reference });
    return Object.freeze({ control: parsed.control, scenario: file.scenario });
  };
  const rules = read(VARIANTS_FILE_NAME, (bytes) => parseVariants(bytes, context));
  const pages = read(PAGES_FILE_NAME, (bytes) => parsePages(bytes, context));
  const sequence = read(SEQUENCE_FILE_NAME, parseSequence);
  const expect = read(EXPECT_FILE_NAME, (bytes) => parseExpect(bytes, context));
  const fault = read(FAULT_FILE_NAME, (bytes) => parseFault(bytes, context));

  const fileOf = (name: string): SourceFile | undefined => entries.find((entry) => entry.name === name);
  const useIds = (name: string, conditions: Parameters<typeof scenarioIdLiterals>[0]): void => {
    const file = fileOf(name);
    if (file === undefined) return;
    for (const literal of scenarioIdLiterals(conditions)) {
      scenarioIds.push({ name: literal.name, path: file.key, position: literal.position, token: literal.written });
    }
  };
  for (const rule of rules?.control.rules ?? []) useIds(VARIANTS_FILE_NAME, rule.when);
  if (expect !== null) useIds(EXPECT_FILE_NAME, expect.control.expect);
  for (const rule of fault?.control.rules ?? []) useIds(FAULT_FILE_NAME, rule.when);

  const hasPages = fileOf(PAGES_FILE_NAME) !== undefined;
  const hasSequence = fileOf(SEQUENCE_FILE_NAME) !== undefined;
  if (hasPages && hasSequence) {
    errors.add(
      'conflicting-controls',
      dir,
      'pages.yaml and sequence.yaml cannot both decide one method; keep one of them',
    );
  }
  const ruleSequence = rules?.control.rules.some((rule) => rule.steps !== null) ?? false;
  return {
    controls: Object.freeze({ rules, pages, sequence, expect, fault }),
    identities,
    files: Object.freeze(files.sort((a, b) => compareStrings(a.name, b.name)).map((file) => Object.freeze(file))),
    scenarioIds,
    sequencePosition: hasSequence || ruleSequence || (state.broken && fileOf(VARIANTS_FILE_NAME) !== undefined),
  };
}

function addControlProblem(errors: ErrorCollector, key: string, problem: ControlProblem): void {
  errors.add(problem.code, key, problem.message, { position: problem.position, token: problem.token });
}

/**
 * Validates the files of one effective method directory; returns its responses
 * when valid. `dir` locates directory-level problems; `endpointFor` gives the
 * endpoint ID of the scenario holding a file, from which its fixture ID is
 * derived; `display` names a file in messages. A sidecar
 * applies to the responses of its identity that its own scenario holds.
 */
function validateMethodDirectory(
  dir: string,
  entries: readonly SourceFile[],
  endpointFor: (scenario: string) => string,
  grammar: { readonly aliases: ReadonlyMap<string, ClockExpansion>; readonly pathParameters: readonly string[] | null },
  display: (file: SourceFile) => string,
  errors: ErrorCollector,
  warnings: WarningCollector,
  dropCors: boolean,
): StoredMethod | null {
  const responses: ParsedResponse[] = [];
  const sidecars: { file: SourceFile; status: number; variant: string | null }[] = [];
  let accepts: AcceptsPolicy | null = null;
  let acceptsScenario: string | null = null;
  let invalidNames = false;

  for (const file of entries) {
    if (file.name === ACCEPTS_FILE_NAME) {
      const parsed = parseAccepts(file.bytes);
      acceptsScenario = file.scenario;
      if (parsed.ok) accepts = parsed.policy;
      else {
        for (const problem of parsed.problems) errors.add('invalid-accepts', file.key, problem.message, problem);
      }
      continue;
    }
    if (CONTROL_FILE_NAMES.has(file.name)) continue;
    const parsed = parseFileName(file.name);
    if (parsed.kind === 'invalid') {
      errors.add(parsed.code, file.key, parsed.message, { token: file.name });
      invalidNames = true;
    } else if (parsed.kind === 'response') {
      responses.push({ file, ...parsed });
    } else {
      sidecars.push({ file, status: parsed.status, variant: parsed.variant });
    }
  }
  const controls = parseMethodControls(dir, entries, grammar.pathParameters, errors);

  const plain = responses.filter((response) => response.variant === null);
  if (plain.length === 0) {
    if (!invalidNames) {
      errors.add(
        'missing-response',
        dir,
        responses.length === 0
          ? 'the method directory has no response file'
          : 'the method directory has only named variants; add a plain response, such as 200.json, to answer when no control decides',
      );
    }
    for (const sidecar of sidecars) {
      errors.add('orphan-header-sidecar', sidecar.file.key, 'no response file uses this header sidecar');
    }
    return null;
  }
  const identities = groupIdentities(dir, responses, display, errors);
  if (identities === null) return null;

  const before = errors.size;
  const context: GrammarContext = { ...grammar, sequencePosition: controls.sequencePosition };
  const bodies = new Map<string, BodyScan>();
  for (const { file, status, mediaType, extension } of responses) {
    if (mediaType === null) {
      if (file.bytes.length > 0) {
        errors.add('invalid-bodyless', file.key, `status ${String(status)} is bodyless, so the file must be empty`);
      }
      continue;
    }
    const kind = bodyKind(mediaType);
    let scan: BodyScan | null = null;
    if (extension === 'json' || kind === 'json') {
      const json = parseJson(file.bytes);
      // Templates are keyed by JSON Pointer, so a repeated key would share one.
      const repeated = json.ok && kind === 'json' && json.text.includes('{{$') ? duplicateKey(json.text) : null;
      if (repeated !== null) {
        errors.add('invalid-json', file.key, repeated.message, repeated);
      } else if (json.ok) {
        if (kind === 'json') scan = scanJsonBody(json.text, hasBom(file.bytes) ? 1 : 0, context);
      } else if (extension === 'json') {
        errors.add('invalid-json', file.key, json.problem.message, json.problem);
      } else if (includesTokenStart(file.bytes)) {
        // Only .json files must be JSON; one with dynamic values must be, to be rendered.
        errors.add(
          'invalid-json',
          file.key,
          `a ${mediaType} body with dynamic values must be valid JSON; ${json.problem.message}`,
          json.problem,
        );
      }
    }
    if (kind === 'text') {
      const text = decodeKeepingBom(file.bytes);
      if (text === null) {
        errors.add('invalid-text-body', file.key, `a ${mediaType} body must be valid UTF-8`);
      } else {
        scan = scanTextBody(text, context);
      }
    }
    if (scan === null) continue;
    for (const problem of scan.problems) errors.add(problem.code, file.key, problem.message, problem);
    if (scan.fullyDynamic) {
      warnings.push(
        Object.freeze({
          code: 'fully-dynamic-fixture',
          source: 'fixtures',
          path: file.key,
          line: 1,
          column: 1,
          message:
            'the body is only dynamic values, with no literal content; check that this fixture is meant to echo or generate everything',
        }),
      );
    }
    bodies.set(file.key, scan);
  }

  // A sidecar applies to every representation of its identity in its scenario, whatever the locale or media type.
  const statusHeaders = new Map<string, StatusHeaders>();
  const headersKey = (scenario: string, status: number, variant: string | null): string =>
    `${scenario}\0${String(status)}\0${variant ?? ''}`;
  for (const sidecar of sidecars) {
    const users = responses.filter(
      (response) =>
        response.status === sidecar.status &&
        response.variant === sidecar.variant &&
        response.file.scenario === sidecar.file.scenario,
    );
    const identity = sidecar.variant === null ? String(sidecar.status) : `${String(sidecar.status)}.${sidecar.variant}`;
    if (users.length === 0) {
      errors.add(
        'orphan-header-sidecar',
        sidecar.file.key,
        `no ${identity} response in this directory uses this header sidecar`,
      );
      continue;
    }
    const result = parseHeaderSidecar(sidecar.file.bytes, { dropCors });
    for (const problem of result.problems) errors.add(problem.code, sidecar.file.key, problem.message, problem);
    for (const header of result.computed) {
      warnings.push(
        Object.freeze({
          code: 'janus-computed-header',
          source: 'fixtures',
          path: sidecar.file.key,
          line: header.position.line,
          column: header.position.column,
          message: `"${header.written}" is computed by Janus and is dropped when served; remove it`,
        }),
      );
    }
    for (const header of result.cors) {
      warnings.push(
        Object.freeze({
          code: 'cors-header-ignored',
          source: 'fixtures',
          path: sidecar.file.key,
          line: header.position.line,
          column: header.position.column,
          message: `"${header.written}" is dropped when served, because cors.fixtures.origins sets fixture CORS headers`,
        }),
      );
    }
    const contentType = applyContentType(sidecar.file.key, result, users, errors, warnings);
    if (users.some((response) => response.locale !== null) && result.headers.has('content-language')) {
      errors.add(
        'status-header-conflict',
        sidecar.file.key,
        '"Content-Language" cannot be set here: localized responses take it from their file names',
      );
    }
    const raw = parseJson(sidecar.file.bytes);
    const values = raw.ok && typeof raw.value === 'object' && raw.value !== null ? raw.value : {};
    const dynamic = raw.ok
      ? scanHeaderSidecar(raw.text, new Set(result.headers.keys()), context)
      : { templates: new Map(), tokens: [], problems: [] };
    for (const problem of dynamic.problems) errors.add(problem.code, sidecar.file.key, problem.message, problem);
    statusHeaders.set(headersKey(sidecar.file.scenario, sidecar.status, sidecar.variant), {
      headers: result.headers,
      file: { source: sidecar.file.key, digest: fileDigest(sidecar.file.bytes), bytes: sidecar.file.bytes.slice() },
      dynamic,
      contentType,
      dropped: result.computed
        .map((header) => ({ name: header.name, values: sidecarValues(values, header.written) }))
        .sort((x, y) => compareStrings(x.name, y.name)),
    });
  }
  for (const { file, status, variant } of responses) {
    if (
      requiresLocation(status) &&
      statusHeaders.get(headersKey(file.scenario, status, variant))?.headers.has('location') !== true
    ) {
      const sidecar = variant === null ? `${String(status)}.headers.json` : `${String(status)}.${variant}.headers.json`;
      errors.add(
        'status-header-conflict',
        file.key,
        `redirect status ${String(status)} requires a Location header in ${sidecar}`,
      );
    }
  }

  // Every identity a control names must exist here.
  const names = [...identities.keys()];
  for (const { file, reference } of controls.identities) {
    if (identities.has(reference.identity)) continue;
    const suggestion = suggest(reference.identity, names);
    errors.add(
      'unknown-identity',
      file.key,
      `"${reference.identity}" names no response in ${dir}${suggestion === null ? '' : `; did you mean "${suggestion}"?`}`,
      { position: reference.position, token: reference.token },
    );
  }
  if (errors.size > before) return null;
  reportEtagMismatch(controls.controls, statusHeaders, entries, warnings);

  const localizedSet = responses.some((response) => response.locale !== null);
  const scenarioIds: ScenarioIdUse[] = [...controls.scenarioIds];
  const stored = new Map<string, StoredIdentity>();
  for (const [name, groups] of identities) {
    let fallback: RepresentationGroup | null = null;
    const localized: RepresentationGroup[] = [];
    for (const group of groups) {
      const first = group[0];
      if (first === undefined) continue;
      const { status, locale, variant } = first;
      const bodyless = isBodylessStatus(status);
      const representations = group.map(({ file, mediaType }) => {
        const sidecar = statusHeaders.get(headersKey(file.scenario, status, variant));
        const headers = new Map(sidecar?.headers);
        const wire = mediaType === null ? null : (sidecar?.contentType ?? mediaType);
        if (wire !== null) headers.set('content-type', Object.freeze([wire]));
        if (locale !== null) headers.set('content-language', Object.freeze([locale]));
        const varyOn = [...(bodyless ? [] : ['Accept']), ...(localizedSet ? ['Accept-Language'] : [])];
        addVary(headers, varyOn);
        const override =
          mediaType !== null && wire !== null && mediaTypeEssence(wire) !== mediaTypeEssence(mediaType)
            ? Object.freeze({ representation: mediaType, wire })
            : null;
        const body = bodies.get(file.key);
        const dynamic = dynamicFixture(
          body?.body ?? null,
          body?.tokens ?? [],
          sidecar?.dynamic.templates ?? new Map(),
          sidecar?.dynamic.tokens ?? [],
        );
        for (const token of body?.tokens ?? []) scenarioIdUse(token, file.key, scenarioIds);
        for (const token of sidecar?.dynamic.tokens ?? []) scenarioIdUse(token, file.key, scenarioIds);
        return storeResponse({
          id: fixtureId(endpointFor(file.scenario), locale, mediaType, variant),
          scenario: file.scenario,
          dynamic,
          status,
          merged: headers,
          body: mediaType === null ? null : file.bytes,
          source: file.key,
          mediaType,
          locale,
          variant,
          identity: name,
          dropped: sidecar?.dropped ?? [],
          contentTypeOverride: override,
          sidecar: sidecar?.file ?? null,
        });
      });
      const built: RepresentationGroup = Object.freeze({
        locale,
        key: locale?.toLowerCase() ?? null,
        status,
        variant,
        bodyless,
        representations: Object.freeze(representations),
      });
      if (locale === null) fallback = built;
      else localized.push(built);
    }
    localized.sort((a, b) => compareStrings(a.key ?? '', b.key ?? ''));
    const first = groups[0]?.[0];
    stored.set(
      name,
      Object.freeze({
        name,
        status: first?.status ?? 0,
        variant: first?.variant ?? null,
        fallback,
        localized: Object.freeze(localized),
      }),
    );
  }

  // The plain responses together: every plain identity's groups.
  const plainIdentities = [...stored.values()].filter((identity) => identity.variant === null);
  const plainFallback = plainIdentities.find((identity) => identity.fallback !== null)?.fallback ?? null;
  const plainLocalized = plainIdentities
    .flatMap((identity) => identity.localized)
    .sort((a, b) => compareStrings(a.key ?? '', b.key ?? ''));
  return Object.freeze({
    fallback: plainFallback,
    localized: Object.freeze(plainLocalized),
    identities: stored,
    accepts,
    acceptsScenario,
    controls: controls.controls,
    controlFiles: controls.files,
    scenarioIds: Object.freeze(dedupeScenarioIds(scenarioIds)),
  });
}

/** Records a `{{$scenario.ids.<name>}}` token of a response file. */
function scenarioIdUse(
  token: { readonly expression: string; readonly category: string },
  path: string,
  out: ScenarioIdUse[],
): void {
  if (token.category !== 'context') return;
  const match = /^scenario\.ids\.(.+)$/.exec(token.expression);
  if (match === null) return;
  out.push({ name: match[1] ?? '', path, position: undefined, token: `{{$${token.expression}}}` });
}

function dedupeScenarioIds(uses: readonly ScenarioIdUse[]): ScenarioIdUse[] {
  const seen = new Set<string>();
  return uses.filter((use) => {
    const key = [use.name, use.path, use.position?.line, use.position?.column].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `etag-mismatch`: a `matchesETag` rule whose tag the plain
 * `200`'s `ETag` never produces, so a client can never present it.
 */
function reportEtagMismatch(
  controls: StoredControls,
  statusHeaders: ReadonlyMap<string, StatusHeaders>,
  entries: readonly SourceFile[],
  warnings: WarningCollector,
): void {
  const rules = controls.rules;
  if (rules === null) return;
  const etags = [...statusHeaders]
    .filter(([key]) => {
      const [, status, variant] = key.split('\0');
      return status === '200' && variant === '';
    })
    .flatMap(([, headers]) => headers.headers.get('etag') ?? []);
  const current = etags.length === 0 ? null : parseEntityTag(etags[0]?.trim() ?? '');
  if (current === null) return;
  const file = entries.find((entry) => entry.name === VARIANTS_FILE_NAME);
  for (const rule of rules.control.rules) {
    for (const condition of rule.when) {
      if (condition.test.kind !== 'matchesETag' || weakMatch(condition.test.tag, current)) continue;
      warnings.push(
        Object.freeze({
          code: 'etag-mismatch',
          source: 'fixtures',
          path: file?.key ?? '',
          ...(condition.position === undefined
            ? {}
            : { line: condition.position.line, column: condition.position.column }),
          message: `rule ${String(rule.number)} matches ${condition.test.written}, but the plain 200 sends ETag ${etags[0] ?? ''}, so a client never presents that tag`,
        }),
      );
    }
  }
}

/**
 * Applies a sidecar `Content-Type` to the responses of its status
 * and returns the value to send, or null to send each filename's media type.
 */
function applyContentType(
  key: string,
  result: SidecarResult,
  users: readonly ParsedResponse[],
  errors: ErrorCollector,
  warnings: WarningCollector,
): string | null {
  const contentType = result.contentType;
  if (contentType === undefined) return null;
  const detail = { position: contentType.position, token: 'Content-Type' };
  if (users.some((response) => response.mediaType === null)) {
    errors.add('status-header-conflict', key, '"Content-Type" cannot be set for a bodyless status', detail);
    return null;
  }
  const mediaTypes = [...new Set(users.map((response) => (response.mediaType ?? '').toLowerCase()))].sort(
    compareStrings,
  );
  const [mediaType] = mediaTypes;
  if (mediaType === undefined) return null;
  if (mediaTypes.length > 1) {
    errors.add(
      'status-header-conflict',
      key,
      `"Content-Type" cannot be set here: this status has several media types (${mediaTypes.join(', ')}), and one sidecar cannot override them all`,
      detail,
    );
    return null;
  }
  const parsed = parseMediaType(contentType.value);
  const warn = (code: 'redundant-content-type' | 'content-type-override', message: string): void => {
    warnings.push(
      Object.freeze({
        code,
        source: 'fixtures',
        path: key,
        line: contentType.position.line,
        column: contentType.position.column,
        message,
      }),
    );
  };
  if (mediaTypeEssence(contentType.value) !== mediaType) {
    warn(
      'content-type-override',
      `"Content-Type" overrides the file name's media type "${mediaType}"; Accept negotiation still uses the file name`,
    );
    return contentType.value;
  }
  if (parsed !== null && parsed.parameters.length === 0) {
    warn(
      'redundant-content-type',
      '"Content-Type" repeats the media type the response file name already sets; remove it',
    );
    return null;
  }
  // Same type and subtype with parameters added (e.g. charset): sent as written.
  return contentType.value;
}

/** A sidecar member's values as strings, for Atlas to show dropped headers. */
function sidecarValues(object: object, name: string): readonly string[] {
  const raw = (object as Record<string, unknown>)[name];
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : [];
  return Object.freeze(values);
}

/**
 * Splits a method's responses into identities: the plain
 * responses by status, then each variant, with the grouping rules
 * applied to the plain responses together and within each variant. A variant
 * name belongs to one status. Returns identity name → its groups.
 */
function groupIdentities(
  dir: string,
  responses: readonly ParsedResponse[],
  display: (file: SourceFile) => string,
  errors: ErrorCollector,
): Map<string, ParsedResponse[][]> | null {
  const before = errors.size;
  const identities = new Map<string, ParsedResponse[][]>();
  const plain = groupRepresentations(
    dir,
    responses.filter((response) => response.variant === null),
    display,
    errors,
    '',
  );
  const byVariant = new Map<string, ParsedResponse[]>();
  for (const response of responses) {
    if (response.variant === null) continue;
    byVariant.set(response.variant, [...(byVariant.get(response.variant) ?? []), response]);
  }
  const named: [string, ParsedResponse[][]][] = [];
  for (const variant of [...byVariant.keys()].sort(compareStrings)) {
    const list = byVariant.get(variant) ?? [];
    const statuses = [...new Set(list.map((response) => response.status))].sort((a, b) => a - b);
    if (statuses.length > 1) {
      errors.add(
        'duplicate-variant',
        dir,
        `the variant name "${variant}" is used with statuses ${statuses.join(' and ')} (${list.map((entry) => display(entry.file)).join(', ')}); a variant name names one response, so rename one`,
        { token: variant },
      );
      continue;
    }
    const groups = groupRepresentations(dir, list, display, errors, ` of ${String(statuses[0] ?? '')}.${variant}`);
    if (groups !== null) named.push([`${String(statuses[0] ?? '')}.${variant}`, groups]);
  }
  if (plain === null || errors.size > before) return null;
  const statuses = [...new Set(plain.map((group) => group[0]?.status ?? 0))].sort((a, b) => a - b);
  for (const status of statuses) {
    identities.set(
      String(status),
      plain.filter((group) => group[0]?.status === status),
    );
  }
  for (const [name, groups] of named) identities.set(name, groups);
  return identities;
}

/**
 * Splits responses into representation groups by locale:
 * each group has one status and at most one file per media type, and a
 * bodyless status is alone in its group. Groups are returned neutral first,
 * each sorted by lower-cased media type. `label` names a variant in messages.
 */
function groupRepresentations(
  dir: string,
  responses: readonly ParsedResponse[],
  display: (file: SourceFile) => string,
  errors: ErrorCollector,
  label: string,
): ParsedResponse[][] | null {
  const before = errors.size;
  const names = (list: readonly ParsedResponse[]): string => list.map((entry) => display(entry.file)).join(', ');

  const byLocale = new Map<string, ParsedResponse[]>();
  for (const response of responses) {
    const key = response.locale === null ? '' : `[${response.locale.toLowerCase()}]`;
    byLocale.set(key, [...(byLocale.get(key) ?? []), response]);
  }
  const groups: ParsedResponse[][] = [];
  for (const key of [...byLocale.keys()].sort(compareStrings)) {
    const group = (byLocale.get(key) ?? []).sort(
      (a, b) =>
        compareStrings((a.mediaType ?? '').toLowerCase(), (b.mediaType ?? '').toLowerCase()) ||
        compareStrings(a.file.name, b.file.name),
    );
    groups.push(group);
    const which = `${label} ${key === '' ? 'without a locale' : `for locale ${group[0]?.locale ?? key}`}`.trim();
    const statuses = new Set(group.map((response) => response.status));
    const bodyless = group.filter((response) => response.mediaType === null);
    if (bodyless.length > 0 && group.length > 1) {
      errors.add(
        'multiple-responses',
        dir,
        `a bodyless status must be the only response ${which}; found ${names(group)}`,
      );
      continue;
    }
    if (statuses.size > 1) {
      errors.add(
        'multiple-responses',
        dir,
        `every response ${which} must have the same status, since only Accept chooses between them; found ${names(group)}`,
      );
      continue;
    }
    const byMediaType = new Map<string, ParsedResponse[]>();
    for (const response of group) {
      const mediaType = (response.mediaType ?? '').toLowerCase();
      byMediaType.set(mediaType, [...(byMediaType.get(mediaType) ?? []), response]);
    }
    for (const [mediaType, same] of byMediaType) {
      if (same.length < 2) continue;
      errors.add(
        'duplicate-representation',
        dir,
        `${names(same)} are all ${mediaType} ${which}; media types and language tags are case-insensitive, so keep one`,
      );
    }
  }
  return errors.size === before ? groups : null;
}

/** The first key repeated within one object of valid JSON, as a located problem; null when there is none. */
function duplicateKey(text: string): (ErrorDetail & { readonly message: string }) | null {
  const scan = scanJson(text, { rejectDuplicateKeys: true });
  if (scan.ok) return null;
  return {
    message: `invalid JSON: ${scan.message}`,
    position: scan.position,
    ...(scan.token === undefined ? {} : { token: scan.token }),
  };
}

/** True when the bytes contain `{{$`. */
function includesTokenStart(bytes: Uint8Array): boolean {
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0x7b && bytes[i + 1] === 0x7b && bytes[i + 2] === 0x24) return true;
  }
  return false;
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** Strict UTF-8 that keeps a leading BOM, so token offsets match the Atlas preview. */
function decodeKeepingBom(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Adds `names` to `Vary` without duplicates, keeping what the fixture already sets; nothing is added beside `*`. */
function addVary(headers: Map<string, readonly string[]>, names: readonly string[]): void {
  const vary = headers.get('vary') ?? [];
  const tokens = new Set(vary.flatMap((value) => value.split(',')).map((token) => token.trim().toLowerCase()));
  if (tokens.has('*')) return;
  const missing = names.filter((name) => !tokens.has(name.toLowerCase()));
  if (missing.length > 0) headers.set('vary', Object.freeze([...vary, missing.join(', ')]));
}

interface StoreInput extends Omit<StoredResponse, 'headers' | 'body'> {
  readonly merged: ReadonlyMap<string, readonly string[]>;
  readonly body: Uint8Array | null;
}

function storeResponse(input: StoreInput): StoredResponse {
  const { merged, body, ...rest } = input;
  const headers: Record<string, readonly string[]> = {};
  for (const name of [...merged.keys()].sort(compareStrings)) headers[name] = merged.get(name) ?? [];
  return Object.freeze({
    ...rest,
    headers: Object.freeze(headers),
    body: body === null ? null : body.slice(),
    dropped: Object.freeze(rest.dropped.map((entry) => Object.freeze({ ...entry }))),
  });
}

/**
 * Rejects logical paths reachable from more than one source spelling
 * (percent-encoding, Unicode normalisation) and paths that differ only by case,
 * which common case-insensitive filesystems cannot represent.
 */
function reportAmbiguousRoutes(routes: ReadonlyMap<string, RouteDraft>, report: TreeReport): void {
  for (const route of routes.values()) {
    if (route.rawDirs.size < 2) continue;
    const dirs = [...route.rawDirs.values()].sort(compareStrings);
    report(
      'duplicate-route',
      (dirs[0] ?? '').split('/').slice(1).join('/'),
      `${dirs.join(' and ')} all define ${formatTemplate(route.segments)} after percent-decoding and Unicode normalisation`,
    );
  }

  // Parameter names are not compared here: two template children are `reportTemplateConflicts`'s to report.
  const byFoldedPrefix = new Map<string, Map<string, string>>();
  for (const route of routes.values()) {
    for (let end = 1; end <= route.segments.length; end++) {
      const prefix = route.segments.slice(0, end);
      const spelling = formatTemplate(unnamed(prefix));
      // Fold the decoded values: `%C3%A9` and `%C3%89` are é and É.
      const folded = JSON.stringify(
        prefix.map((segment) => (segment.kind === 'param' ? null : segment.value.normalize('NFC').toLowerCase())),
      );
      const spellings = byFoldedPrefix.get(folded) ?? new Map<string, string>();
      if (!spellings.has(spelling)) spellings.set(spelling, formatTemplate(prefix));
      byFoldedPrefix.set(folded, spellings);
    }
  }
  for (const spellings of byFoldedPrefix.values()) {
    if (spellings.size < 2) continue;
    const sorted = [...spellings.values()].sort(compareStrings);
    report(
      'case-conflict',
      (sorted[0] ?? '').slice(1),
      `${sorted.join(' and ')} differ only by case, which is not portable across filesystems`,
    );
  }
}

/** Replaces parameter names with "" so prefixes that differ only in a parameter name fold together. */
function unnamed(segments: readonly RouteSegment[]): RouteSegment[] {
  return segments.map((segment) => (segment.kind === 'param' ? { kind: 'param', name: '' } : segment));
}

/** A directory may have at most one template child. */
function reportTemplateConflicts(routes: ReadonlyMap<string, RouteDraft>, report: TreeReport): void {
  const byParent = new Map<string, { path: string; template: string; names: Set<string> }>();
  for (const route of routes.values()) {
    route.segments.forEach((segment, index) => {
      if (segment.kind !== 'param') return;
      const parent = route.segments.slice(0, index);
      const key = JSON.stringify(templateKey(parent));
      const entry = byParent.get(key) ?? {
        path: route.raw.slice(0, index).join('/'),
        template: formatTemplate(parent),
        names: new Set<string>(),
      };
      entry.names.add(segment.name);
      byParent.set(key, entry);
    });
  }
  for (const { path, template, names } of byParent.values()) {
    if (names.size < 2) continue;
    const listed = [...names]
      .sort(compareStrings)
      .map((name) => `{${name}}`)
      .join(' and ');
    report(
      'multiple-template-children',
      path,
      `${listed} are both template directories under ${template}; a directory may have at most one template child`,
    );
  }
}

function buildTrie(routes: ReadonlyMap<string, RouteDraft>): RouteNode {
  interface MutableNode {
    readonly segments: readonly RouteSegment[];
    readonly children: Map<string, MutableNode>;
    param: { readonly name: string; readonly node: MutableNode } | null;
    readonly methods: Map<string, StoredMethod>;
    readonly shadowed: Map<string, readonly ShadowedFile[]>;
  }
  const create = (segments: readonly RouteSegment[]): MutableNode => ({
    segments,
    children: new Map(),
    param: null,
    methods: new Map(),
    shadowed: new Map(),
  });
  const root = create([]);
  for (const route of routes.values()) {
    let node = root;
    route.segments.forEach((segment, index) => {
      const prefix = route.segments.slice(0, index + 1);
      if (segment.kind === 'param') {
        node.param ??= { name: segment.name, node: create(prefix) };
        node = node.param.node;
        return;
      }
      let child = node.children.get(segment.value);
      if (child === undefined) {
        child = create(prefix);
        node.children.set(segment.value, child);
      }
      node = child;
    });
    const template = templateKey(route.segments);
    for (const [method, response] of route.methods) {
      node.methods.set(method, response);
      const hidden = route.hidden.get(method) ?? [];
      node.shadowed.set(
        method,
        Object.freeze(
          hidden.map((file) =>
            Object.freeze({
              scenario: file.scenario,
              fixtureId: fixtureId(
                endpointId(file.scenario, method, template),
                file.locale,
                file.mediaType,
                file.variant,
              ),
              by: file.by,
            }),
          ),
        ),
      );
    }
  }
  const freeze = (node: MutableNode): RouteNode =>
    Object.freeze({
      children: new Map([...node.children].map(([segment, child]) => [segment, freeze(child)])),
      param: node.param === null ? null : Object.freeze({ name: node.param.name, node: freeze(node.param.node) }),
      methods: new Map(node.methods),
      shadowed: new Map(node.shadowed),
      segments: Object.freeze(node.segments.map((segment) => Object.freeze({ ...segment }))),
    });
  return freeze(root);
}

/**
 * Core accepts any uppercase method token, but the transport may
 * refuse some before Janus sees them. Each source directory named after such a
 * method is warned about once; it validates, yet is never served.
 */
function reportUnreceivableMethods(
  sources: ReadonlyMap<string, ScenarioSource>,
  receivable: ReadonlySet<string>,
  warnings: WarningCollector,
): void {
  for (const source of sources.values()) {
    for (const dir of source.dirs.keys()) {
      const method = dir.slice(dir.lastIndexOf('/') + 1);
      if (!isUppercaseMethodToken(method) || receivable.has(method)) continue;
      warnings.push(
        Object.freeze({
          code: 'unreceivable-method',
          source: 'fixtures',
          path: `${source.name}/${dir}`,
          token: method,
          message: `"${method}" is a valid method token, but the HTTP server cannot receive it, so this directory is never served`,
        }),
      );
    }
  }
}

/** The scenario's own `latency`, else the nearest ancestor's that sets one. */
function effectiveLatency(
  chain: readonly string[],
  nodes: ReadonlyMap<string, { readonly flow: Flow }>,
): ScenarioData['effectiveLatency'] {
  for (const name of chain) {
    const profile = nodes.get(name)?.flow.latency ?? null;
    if (profile !== null) return { profile, scenario: name };
  }
  return null;
}

/**
 * A stable identifier over the logical content: route templates, methods,
 * accepted media types, representation groups, statuses, headers, dropped
 * headers, body bytes and file names of `default`, then, when the tree has more, every scenario's
 * declarations and effective routes with the scenario holding each file. A
 * tree with only `default` and no `flow.yaml` keeps its version.
 */
function snapshotVersion(
  routes: ReadonlyMap<string, RouteDraft>,
  scenarios: ReadonlyMap<string, ScenarioData>,
  provenance: readonly SourceFile[],
): string {
  const writer = new CanonicalWriter().string('janus-snapshot/3');
  writeRoutes(writer, [...routes.values()], false);
  const base = scenarios.get(DEFAULT_SCENARIO);
  const plain =
    scenarios.size === 1 &&
    base !== undefined &&
    base.description === null &&
    base.ids.length === 0 &&
    base.overrides.length === 0 &&
    base.removes.length === 0 &&
    base.latency === null;
  if (!plain) {
    writer.string('scenarios').number(scenarios.size);
    for (const scenario of scenarios.values()) {
      writer
        .string(scenario.name)
        .string(scenario.parent ?? '')
        .string(scenario.description ?? '');
      writer.number(scenario.ids.length);
      for (const id of scenario.ids) writer.string(id.name).string(id.value).string(id.from);
      for (const list of [scenario.overrides, scenario.removes]) {
        writer.number(list.length);
        for (const entry of list) writer.string(entry);
      }
      // A scenario without latency keeps its earlier version.
      if (scenario.latency !== null) writer.string('latency').string(formatLatency(scenario.latency));
      writeRoutes(writer, collectRoutes(scenario.root), true);
    }
  }
  // A review changes what Atlas reports, so it changes the version; a tree without provenance keeps its own.
  if (provenance.length > 0) {
    writer.string(PROVENANCE_FORMAT).number(provenance.length);
    for (const file of provenance) writer.string(file.key).bytes(file.bytes);
  }
  return toHex(writer.digest()).slice(0, 16);
}

interface RouteContent {
  readonly segments: readonly RouteSegment[];
  readonly methods: ReadonlyMap<string, StoredMethod>;
}

function collectRoutes(root: RouteNode): RouteContent[] {
  const out: RouteContent[] = [];
  const visit = (node: RouteNode): void => {
    if (node.methods.size > 0) out.push(node);
    for (const child of node.children.values()) visit(child);
    if (node.param !== null) visit(node.param.node);
  };
  visit(root);
  return out;
}

function writeRoutes(writer: CanonicalWriter, routes: readonly RouteContent[], holders: boolean): void {
  const keyed = routes.map((route) => ({ route, key: JSON.stringify(templateKey(route.segments)) }));
  const ordered = keyed.sort((a, b) => compareStrings(a.key, b.key)).map(({ route }) => route);
  writer.number(ordered.length);
  for (const route of ordered) {
    writer.number(route.segments.length);
    for (const segment of route.segments) {
      if (segment.kind === 'param') writer.string('param').string(segment.name);
      else writer.string('literal').string(segment.value);
    }
    const methods = [...route.methods.keys()].sort(compareStrings);
    writer.number(methods.length);
    for (const method of methods) {
      const stored = route.methods.get(method);
      if (stored === undefined) continue;
      writer.string(method);
      if (stored.accepts === null) writer.string('accepts-any');
      else {
        writer.string('accepts').number(stored.accepts.mediaTypes.length);
        for (const mediaType of stored.accepts.mediaTypes) writer.string(mediaType);
        writer.string(stored.accepts.allowMissingContentType ?? '');
        if (holders) writer.string(stored.acceptsScenario ?? '');
      }
      if (stored.fallback === null) writer.string('no-fallback');
      else writeGroup(writer.string('fallback'), stored.fallback, holders);
      writer.number(stored.localized.length);
      for (const group of stored.localized) writeGroup(writer.string(group.locale ?? ''), group, holders);
      // Named variants and control files; a tree without them keeps its version.
      const named = [...stored.identities.values()].filter((identity) => identity.variant !== null);
      if (named.length > 0) {
        writer.string('variants').number(named.length);
        for (const identity of named) {
          writer.string(identity.name);
          if (identity.fallback === null) writer.string('no-fallback');
          else writeGroup(writer.string('fallback'), identity.fallback, holders);
          writer.number(identity.localized.length);
          for (const group of identity.localized) writeGroup(writer.string(group.locale ?? ''), group, holders);
        }
      }
      if (stored.controlFiles.length > 0) {
        writer.string('controls').number(stored.controlFiles.length);
        for (const file of stored.controlFiles) {
          writer.string(file.name).bytes(file.bytes);
          if (holders) writer.string(file.scenario);
        }
      }
    }
  }
}

function writeGroup(writer: CanonicalWriter, group: RepresentationGroup, holders: boolean): void {
  writer.number(group.representations.length);
  for (const response of group.representations) {
    writeResponse(writer, response);
    if (holders) writer.string(response.scenario);
  }
}

function writeResponse(writer: CanonicalWriter, response: StoredResponse): void {
  writer.number(response.status).string(response.mediaType ?? '');
  const names = Object.keys(response.headers).sort(compareStrings);
  writer.number(names.length);
  for (const name of names) {
    const values = response.headers[name] ?? [];
    writer.string(name).number(values.length);
    for (const value of values) writer.string(value);
  }
  if (response.body === null) writer.string('bodyless');
  else writer.string('body').bytes(response.body);
  // A file name spelling change changes the version; so does a dropped header Atlas shows.
  writer.string(response.source).number(response.dropped.length);
  for (const { name, values } of response.dropped) {
    writer.string(name).number(values.length);
    for (const value of values) writer.string(value);
  }
}

interface ErrorDetail {
  readonly position?: TextPosition | undefined;
  readonly token?: string | undefined;
}

class ErrorCollector {
  readonly #errors = new Map<string, StartupError>();

  get size(): number {
    return this.#errors.size;
  }

  add(code: StartupErrorCode, path: string, message: string, detail: ErrorDetail = {}): void {
    const { position, token } = detail;
    const key = [code, path, message, position?.line, position?.column, token].join('\0');
    if (this.#errors.has(key)) return;
    this.#errors.set(
      key,
      Object.freeze({
        code,
        source: 'fixtures' as const,
        path,
        ...(position === undefined ? {} : { line: position.line, column: position.column }),
        ...(token === undefined ? {} : { token }),
        message,
      }),
    );
  }

  sorted(): readonly StartupError[] {
    return sortStartupProblems([...this.#errors.values()]);
  }
}

/**
 * Reports problems of an effective tree at `<scenario>/<path below the
 * scenario root>`. A descendant that inherits the same problem unchanged is
 * not told again: it is reported once, for the nearest scenario to `default`
 * that has it, which scenarios are validated in order of.
 */
class TreeReporter {
  readonly #seen = new Set<string>();
  readonly #errors: ErrorCollector;

  constructor(errors: ErrorCollector) {
    this.#errors = errors;
  }

  add(scenario: string, code: StartupErrorCode, rel: string, message: string, detail: ErrorDetail = {}): void {
    const signature = [code, rel, message, detail.position?.line, detail.position?.column, detail.token].join('\0');
    if (this.#seen.has(signature)) return;
    this.#seen.add(signature);
    this.#errors.add(code, rel === '' ? scenario : `${scenario}/${rel}`, message, detail);
  }
}

/** Warnings about a file inherited by several scenarios are reported once. */
class WarningCollector {
  readonly #warnings = new Map<string, StartupWarning>();

  push(warning: StartupWarning): void {
    const key = [warning.code, warning.path, warning.line, warning.column, warning.message].join('\0');
    if (!this.#warnings.has(key)) this.#warnings.set(key, warning);
  }

  sorted(): readonly StartupWarning[] {
    return sortStartupProblems([...this.#warnings.values()]);
  }
}

function deepFreezeScenario(scenario: ScenarioData): ScenarioData {
  return Object.freeze({
    ...scenario,
    chain: Object.freeze([...scenario.chain]),
    ids: Object.freeze(scenario.ids.map((id) => Object.freeze({ ...id }))),
    overrides: Object.freeze([...scenario.overrides]),
    removes: Object.freeze([...scenario.removes]),
  });
}
