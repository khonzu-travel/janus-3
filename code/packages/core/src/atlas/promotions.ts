import { compareStrings } from '../canonical.js';
import type {
  ProvenanceNote,
  ProvenanceRefusal,
  ProvenanceRewrite,
  ProvenanceSuggestion,
  ReviewState,
} from '../fixtures/provenance.js';
import type { ProvenanceRecord } from '../fixtures/snapshot.js';

/** A promoted file's provenance as Atlas reports it. Locations and codes, never values. */
export interface AtlasProvenance {
  /** The promoted file's file key, which `POST /_janus/promotions/review` names. */
  readonly file: string;
  readonly capture: string;
  readonly promotedAt: string;
  readonly review: ReviewState;
  readonly reviewedAt: string | null;
  /** True when the file changed since it was promoted. */
  readonly modified: boolean;
  readonly rewrites: readonly ProvenanceRewrite[];
  readonly suggestions: readonly ProvenanceSuggestion[];
  readonly refusals: readonly ProvenanceRefusal[];
  readonly notes: readonly ProvenanceNote[];
}

/** One item of `GET /_janus/promotions`. */
export interface AtlasPromotionItem {
  readonly scenario: string;
  /** File key. */
  readonly file: string;
  /** Set for response files; absent for header sidecars. */
  readonly fixtureId?: string;
  /** The endpoint holding the fixture, set with `fixtureId`, so a client can open it in endpoint detail. */
  readonly endpointId?: string;
  readonly capture: string;
  readonly promotedAt: string;
  readonly review: ReviewState;
  readonly reviewedAt: string | null;
  readonly modified: boolean;
  /** How many items need a reviewer's attention. */
  readonly attention: {
    readonly inferred: number;
    readonly suggestions: number;
    readonly refusals: number;
    readonly notes: number;
  };
}

/** `GET /_janus/promotions`: every promoted file of the snapshot, newest first. */
export interface AtlasPromotionList {
  readonly snapshotVersion: string;
  readonly items: readonly AtlasPromotionItem[];
}

/** What `?review` and `?scenario` filter on. */
export interface PromotionListQuery {
  readonly review?: ReviewState;
  readonly scenario?: string;
}

/** Whether this engine can promote, its mode, and how many promoted files await review. */
export interface AtlasPromotionStatus {
  readonly available: boolean;
  readonly mode: 'staged' | 'auto';
  readonly pending: number;
}

export function projectProvenance(record: ProvenanceRecord): AtlasProvenance {
  const { entry } = record;
  return {
    file: record.file,
    capture: entry.capture,
    promotedAt: entry.promotedAt,
    review: entry.review,
    reviewedAt: entry.reviewedAt ?? null,
    modified: record.modified,
    rewrites: entry.rewrites,
    suggestions: entry.suggestions,
    refusals: entry.refusals,
    notes: entry.notes,
  };
}

/** Every provenance record as a list item, newest first, then by scenario and file key. */
export function projectPromotions(
  records: readonly ProvenanceRecord[],
  fixtureOf: (record: ProvenanceRecord) => { readonly fixtureId: string; readonly endpointId: string } | undefined,
): readonly AtlasPromotionItem[] {
  return records
    .map((record): AtlasPromotionItem => {
      const { entry } = record;
      const fixture = record.kind === 'response' ? fixtureOf(record) : undefined;
      return {
        scenario: record.scenario,
        file: record.file,
        ...(fixture === undefined ? {} : { fixtureId: fixture.fixtureId, endpointId: fixture.endpointId }),
        capture: entry.capture,
        promotedAt: entry.promotedAt,
        review: entry.review,
        reviewedAt: entry.reviewedAt ?? null,
        modified: record.modified,
        attention: {
          inferred: entry.rewrites.filter((rewrite) => rewrite.tier === 'inferred').length,
          suggestions: entry.suggestions.length,
          refusals: entry.refusals.length,
          notes: entry.notes.length,
        },
      };
    })
    .sort(
      (a, b) =>
        compareStrings(b.promotedAt, a.promotedAt) ||
        compareStrings(a.scenario, b.scenario) ||
        compareStrings(a.file, b.file),
    );
}

/** The list filtered by `?review` and `?scenario`. */
export function filterPromotions(
  items: readonly AtlasPromotionItem[],
  query: PromotionListQuery,
): readonly AtlasPromotionItem[] {
  return items.filter(
    (item) =>
      (query.review === undefined || item.review === query.review) &&
      (query.scenario === undefined || item.scenario === query.scenario),
  );
}
