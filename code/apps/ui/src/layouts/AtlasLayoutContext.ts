import type { Health, Inventory, Scenarios } from '../atlas/client.js';
import type { ScenarioSelection } from '../scenarios/selection.js';

/** Snapshot-level data shared with routed pages through the outlet context. */
export interface AtlasLayoutContext {
  readonly health: Health;
  /** The selected scenario's inventory. */
  readonly inventory: Inventory | undefined;
  readonly inventoryError: Error | null;
  readonly scenario: ScenarioSelection;
  /** Every scenario; undefined while loading, or from a server without them. */
  readonly scenarios: Scenarios | undefined;
}
