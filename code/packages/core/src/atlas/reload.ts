import { isScenarioName } from '../fixtures/flow.js';
import { isUppercaseMethodToken } from '../http/token.js';
import type { StartupError, StartupWarning } from '../types/index.js';
import type { AtlasReloadProblem, AtlasReloadResult, AtlasReloadSummary } from './types.js';

/**
 * Locates a fixture problem by endpoint and file name, never by
 * filesystem path: `default/v1/products/{productId}/GET/200.json`
 * becomes `GET /v1/products/{productId}` and `200.json` in scenario `default`;
 * any other scenario directory is stripped the same way.
 * Problems outside a method directory get the nearest path template and no file.
 */
export function reloadProblem(problem: StartupError | StartupWarning): AtlasReloadProblem {
  const segments = problem.source === 'fixtures' ? problem.path.split('/').filter((part) => part !== '') : [];
  // Everything below a scenario directory is the route; a top-level name that is no scenario has none.
  const top = segments[0];
  const scenario = top !== undefined && isScenarioName(top) ? top : null;
  const route = scenario === null ? [] : segments.slice(1);
  let method: string | null = null;
  let file: string | null = null;
  let template = route;
  const last = route.length - 1;
  if (last >= 1 && isMethod(route[last - 1] ?? '')) {
    method = route[last - 1] ?? null;
    file = route[last] ?? null;
    template = route.slice(0, last - 1);
  } else if (last >= 0 && isMethod(route[last] ?? '')) {
    method = route[last] ?? null;
    template = route.slice(0, last);
  } else if (last >= 0 && (route[last] ?? '').includes('.')) {
    // A stray file: its directory is the nearest template.
    template = route.slice(0, last);
  }
  return {
    code: problem.code,
    scenario,
    endpoint: { method, path: `/${template.join('/')}` },
    file,
    line: problem.line ?? null,
    column: problem.column ?? null,
    message: problem.message,
  };
}

/** The brief form health and the event stream report. */
export function reloadSummary(result: AtlasReloadResult): AtlasReloadSummary {
  return { outcome: result.outcome, errorCount: result.errors.length, finishedAt: result.finishedAt };
}

/** A method directory name: an uppercase token with at least one letter, so `204` stays a file. */
function isMethod(segment: string): boolean {
  return isUppercaseMethodToken(segment) && /[A-Z]/.test(segment);
}
