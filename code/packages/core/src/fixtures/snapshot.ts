import type { DynamicFixture } from '../dynamic/fixture.js';
import { formatTemplate, type RouteSegment } from '../http/target.js';
import type { FixtureSnapshot, HeaderMap, HttpMethod } from '../types/index.js';
import type { AcceptsPolicy } from './accepts.js';
import type { ExpectControl, FaultControl, PagesControl, RulesControl, SequenceControl } from './controls.js';
import type { LatencyProfile } from './latency.js';
import type { TextPosition } from './json.js';
import type { ProvenanceEntry } from './provenance.js';

/** One immutable, replayable representation: one file of a method directory. */
export interface StoredResponse {
  /** The Atlas fixture ID (`fx_…`), sent as `X-Mock-Identity`. */
  readonly id: string;
  /** The scenario holding the file, sent as `X-Mock-Resolved-From`. */
  readonly scenario: string;
  readonly status: number;
  /**
   * Lower-cased, frozen headers as served before diagnostics: replayed sidecar
   * headers, the wire `Content-Type`, `Content-Language` and `Vary`. Never a
   * Janus-computed header.
   */
  readonly headers: HeaderMap;
  /** null for bodyless statuses. Never handed out directly: resolution returns a copy. */
  readonly body: Uint8Array | null;
  /** Source-relative path of the response file (provenance for diagnostics only). */
  readonly source: string;
  /** The filename's media type (the representation), or null for a bodyless response. */
  readonly mediaType: string | null;
  /** Language tag exactly as written in the file name, or null. */
  readonly locale: string | null;
  /** The variant name, or null for a plain response. */
  readonly variant: string | null;
  /** The response identity: `200` or `200.empty`. */
  readonly identity: string;
  /** Janus-computed headers the sidecar set, dropped when served; sorted by name. */
  readonly dropped: readonly { readonly name: string; readonly values: readonly string[] }[];
  /** Set when a sidecar `Content-Type` names a different media type than the file name. */
  readonly contentTypeOverride: { readonly representation: string; readonly wire: string } | null;
  /** The body and header templates, when the fixture has tokens or `{{$$` escapes. */
  readonly dynamic: DynamicFixture | null;
  /** The header sidecar this response replays, with its digest; null without one. */
  readonly sidecar: { readonly source: string; readonly digest: string; readonly bytes: Uint8Array } | null;
}

/**
 * The files of one method that share a locale (or share none): one response in
 * one or more media types.
 */
export interface RepresentationGroup {
  /** Language tag as written, or null for the language-neutral group. */
  readonly locale: string | null;
  /** Lower-cased tag, used for matching; null for the neutral group. */
  readonly key: string | null;
  readonly status: number;
  /** The variant name every representation shares, or null for plain responses. */
  readonly variant: string | null;
  /** True for a bodyless status; such a group holds exactly one representation. */
  readonly bodyless: boolean;
  /** Sorted by lower-cased media type. */
  readonly representations: readonly StoredResponse[];
}

/** Representation groups negotiation chooses between: one identity's, or every plain response's. */
export interface RepresentationSet {
  readonly fallback: RepresentationGroup | null;
  /** Sorted by `key`, so negotiation ties resolve the same way on every platform. */
  readonly localized: readonly RepresentationGroup[];
}

/** One response identity: a plain status, or a status and variant name. */
export interface StoredIdentity extends RepresentationSet {
  /** `200` or `200.empty`. */
  readonly name: string;
  readonly status: number;
  readonly variant: string | null;
}

/** A control file of the effective method directory and the scenario whose file it is. */
export interface HeldControl<T> {
  readonly control: T;
  readonly scenario: string;
}

/** The method's control files; null where it has none. */
export interface StoredControls {
  readonly rules: HeldControl<RulesControl> | null;
  readonly pages: HeldControl<PagesControl> | null;
  readonly sequence: HeldControl<SequenceControl> | null;
  readonly expect: HeldControl<ExpectControl> | null;
  readonly fault: HeldControl<FaultControl> | null;
}

/** A `{{$scenario.ids.<name>}}` the method's files use, checked against each scenario's ids. */
export interface ScenarioIdUse {
  readonly name: string;
  /** Source-relative path of the file using it. */
  readonly path: string;
  readonly position: TextPosition | undefined;
  readonly token: string;
}

/**
 * Everything one method directory can answer with. Its plain responses have a
 * language-neutral `fallback` group, localized groups, or both; never neither.
 */
export interface StoredMethod extends RepresentationSet {
  /** Every identity: plain ones by status, then named ones by name. */
  readonly identities: ReadonlyMap<string, StoredIdentity>;
  /** The method's `accepts.yaml`, or null to accept any request body. */
  readonly accepts: AcceptsPolicy | null;
  /** The scenario whose `accepts.yaml` this is; null without one. */
  readonly acceptsScenario: string | null;
  readonly controls: StoredControls;
  /** The raw control files, for the snapshot version. */
  readonly controlFiles: readonly { readonly name: string; readonly scenario: string; readonly bytes: Uint8Array }[];
  readonly scenarioIds: readonly ScenarioIdUse[];
}

/** An inherited file a scenario's effective tree hid at one route and method. */
export interface ShadowedFile {
  /** The ancestor holding the file. */
  readonly scenario: string;
  readonly fixtureId: string;
  readonly by: 'replaced' | 'overrides' | 'removes';
}

/** A node in the route trie. Literal children are keyed by decoded, NFC-normalised segment. */
export interface RouteNode {
  readonly children: ReadonlyMap<string, RouteNode>;
  /** The single template child, if any. */
  readonly param: { readonly name: string; readonly node: RouteNode } | null;
  /** Method → its responses. Empty for a path that is only a prefix of other routes. */
  readonly methods: ReadonlyMap<HttpMethod, StoredMethod>;
  /** Method → the inherited files hidden there, nearest ancestor first. */
  readonly shadowed: ReadonlyMap<HttpMethod, readonly ShadowedFile[]>;
  /** The route template that leads here. */
  readonly segments: readonly RouteSegment[];
}

/** One scenario of a snapshot: its declarations and its validated effective tree. */
export interface ScenarioData {
  readonly name: string;
  readonly description: string | null;
  /** Null for `default`. */
  readonly parent: string | null;
  /** The scenario first, ending with "default". */
  readonly chain: readonly string[];
  /** Effective `ids`, sorted by name, each with the scenario whose value wins. */
  readonly ids: readonly { readonly name: string; readonly value: string; readonly from: string }[];
  readonly overrides: readonly string[];
  readonly removes: readonly string[];
  /** The scenario's own `flow.yaml` `latency`, or null. */
  readonly latency: LatencyProfile | null;
  /** The latency along its chain: its own, else the nearest ancestor's, with the scenario that set it. */
  readonly effectiveLatency: { readonly profile: LatencyProfile; readonly scenario: string } | null;
  /** The effective tree. */
  readonly root: RouteNode;
  readonly fixtureCount: number;
  readonly routeCount: number;
}

/** One promoted file and its provenance entry, compared with the file as loaded. */
export interface ProvenanceRecord {
  /** The scenario whose own directory holds the file. */
  readonly scenario: string;
  /** File key below the scenario root: `/v1/payments/POST/402.json`. */
  readonly file: string;
  /** Source-relative path of the file. */
  readonly source: string;
  /** Source-relative path of the provenance file. */
  readonly meta: string;
  readonly kind: 'response' | 'headers';
  readonly entry: ProvenanceEntry;
  /** The file's current digest. */
  readonly digest: string;
  /** True when the file changed since it was promoted. */
  readonly modified: boolean;
}

export interface SnapshotData {
  readonly version: string;
  /** `default`'s effective tree. */
  readonly root: RouteNode;
  /** Every scenario, sorted by name. */
  readonly scenarios: ReadonlyMap<string, ScenarioData>;
  /** Every provenance entry whose file exists, by scenario, then file key. */
  readonly provenance: readonly ProvenanceRecord[];
}

const provenanceIndex = new WeakMap<SnapshotData, ReadonlyMap<string, ProvenanceRecord>>();

/** The provenance record of a file by its source-relative path, if it was promoted. */
export function provenanceOf(snapshot: SnapshotData, source: string): ProvenanceRecord | undefined {
  let index = provenanceIndex.get(snapshot);
  if (index === undefined) {
    index = new Map(snapshot.provenance.map((record) => [record.source, record]));
    provenanceIndex.set(snapshot, index);
  }
  return index.get(source);
}

// Snapshot internals stay private to core: the public `FixtureSnapshot` is a
// summary, and only snapshots produced by `buildSnapshot` can drive an engine.
const internals = new WeakMap<FixtureSnapshot, SnapshotData>();

export function registerSnapshot(summary: FixtureSnapshot, data: SnapshotData): FixtureSnapshot {
  internals.set(summary, data);
  return summary;
}

export function snapshotData(snapshot: FixtureSnapshot): SnapshotData {
  const data = internals.get(snapshot);
  if (data === undefined) throw new TypeError('The fixture snapshot was not created by buildSnapshot().');
  return data;
}

export interface RouteMatch {
  readonly node: RouteNode;
  /** Bound parameters as [name, value], in template order. */
  readonly params: readonly (readonly [string, string])[];
}

export interface RouteSearch {
  /** The route that answers, or undefined when no complete path matched. */
  readonly match: RouteMatch | undefined;
  /**
   * Templates of the nodes the walk entered and then abandoned, in the order
   * tried. Each matched a prefix of the path.
   */
  readonly considered: readonly string[];
}

/**
 * Finds the route for decoded path segments: the first
 * complete path of a depth-first walk that tries a node's literal child before
 * its template child, backtracking when a branch dead-ends. A path matches only
 * at a node with at least one method; `reserved` is never bound to a parameter
 * in the first segment, so templates cannot answer for the Atlas namespace.
 */
export function matchRoute(root: RouteNode, segments: readonly string[], reserved: string): RouteMatch | undefined {
  return searchRoute(root, segments, reserved).match;
}

/** `matchRoute`, also reporting every abandoned prefix so a trace can explain backtracking and misses. */
export function searchRoute(root: RouteNode, segments: readonly string[], reserved: string): RouteSearch {
  const params: [string, string][] = [];
  // Entered nodes in the order tried; null marks one that ended up on the matched path.
  const tried: (RouteNode | null)[] = [];
  const enter = (child: RouteNode, index: number): RouteNode | undefined => {
    const position = tried.push(child) - 1;
    const found = walk(child, index);
    if (found !== undefined) tried[position] = null;
    return found;
  };
  const walk = (node: RouteNode, index: number): RouteNode | undefined => {
    if (index === segments.length) return node.methods.size > 0 ? node : undefined;
    const segment = segments[index] ?? '';
    const literal = node.children.get(segment);
    if (literal !== undefined) {
      const found = enter(literal, index + 1);
      if (found !== undefined) return found;
    }
    if (node.param === null || segment === '' || (index === 0 && segment === reserved)) return undefined;
    params.push([node.param.name, segment]);
    const found = enter(node.param.node, index + 1);
    if (found !== undefined) return found;
    params.pop();
    return undefined;
  };
  const node = walk(root, 0);
  const considered = tried.flatMap((entry) => (entry === null ? [] : [formatTemplate(entry.segments)]));
  return { match: node === undefined ? undefined : { node, params }, considered };
}
