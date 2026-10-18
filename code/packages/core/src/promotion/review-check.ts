import { snapshotData } from '../fixtures/snapshot.js';
import type { FixtureSnapshot, StartupError } from '../types/index.js';

/**
 * `janus validate --require-reviewed`: one
 * `promotion-unreviewed` error per provenance entry still pending, naming
 * its scenario and file key.
 */
export function unreviewedPromotions(snapshot: FixtureSnapshot): readonly StartupError[] {
  return snapshotData(snapshot)
    .provenance.filter((record) => record.entry.review === 'pending')
    .map((record) =>
      Object.freeze({
        code: 'promotion-unreviewed' as const,
        source: 'fixtures' as const,
        path: record.source,
        message: `${record.file} in scenario "${record.scenario}" was promoted from ${record.entry.capture} and is pending review; mark it reviewed`,
      }),
    );
}
