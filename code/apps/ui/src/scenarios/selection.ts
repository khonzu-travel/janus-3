import { useSearchParams } from 'react-router';

import type { Health } from '../atlas/client.js';
import { SCENARIO_NAME } from '../atlas/wire.js';

/**
 * The selected scenario lives in the hash (`#/…?scenario=payment-declined`), so a link opens the
 * same scenario. Absent means the
 * configured default, which is what a request with no scenario gets.
 */
export const SCENARIO_PARAM = 'scenario';

export interface ScenarioSelection {
  /** The scenario the views show. */
  readonly name: string;
  /** The name the hash asks for, to send with the inventory request; null for the configured default. */
  readonly requested: string | null;
  /** The server lists scenarios; false for an older server, which has only `default`. */
  readonly supported: boolean;
}

/** The scenario named in `search`, or null when it names none or a malformed one. */
export function scenarioFromSearch(search: URLSearchParams): string | null {
  const value = search.get(SCENARIO_PARAM);
  return value !== null && SCENARIO_NAME.test(value) ? value : null;
}

export function selectionOf(health: Health | undefined, search: URLSearchParams): ScenarioSelection {
  const supported = health?.capabilities.scenarios === true;
  const configured = health?.configuredDefaultScenario ?? 'default';
  const requested = supported ? scenarioFromSearch(search) : null;
  return { name: requested ?? configured, requested: requested === configured ? null : requested, supported };
}

export function useScenarioSelection(health: Health | undefined): ScenarioSelection {
  const [search] = useSearchParams();
  return selectionOf(health, search);
}

/** `search` with `name` selected; the configured default is left out, so links stay short. */
export function withScenario(search: URLSearchParams, name: string, configured: string): URLSearchParams {
  const next = new URLSearchParams(search);
  if (name === configured) next.delete(SCENARIO_PARAM);
  else next.set(SCENARIO_PARAM, name);
  return next;
}

/** Only the scenario, as a `?…` string for links that leave the inventory's filters behind. */
export function scenarioSearch(search: URLSearchParams): string {
  const name = scenarioFromSearch(search);
  return name === null ? '' : `?${SCENARIO_PARAM}=${name}`;
}
