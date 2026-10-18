import type { EndpointItem } from '../atlas/client.js';
import { scenarioFromSearch } from '../scenarios/selection.js';

/**
 * Search, method filters and folder state for the inventory.
 * All of it lives in the hash (`#/?q=…&method=GET&method=POST`), so a filtered
 * view can be shared and survives a refresh.
 */
export interface InventoryFilter {
  /** Case-insensitive substring of the path template or the method. */
  readonly query: string;
  /** Selected methods; none means all. */
  readonly methods: readonly string[];
  /** Folders the user collapsed or expanded, overriding the defaults. */
  readonly collapsed: readonly string[];
  readonly expanded: readonly string[];
  /** The selected scenario, kept so every inventory link stays in it. */
  readonly scenario: string | null;
  /** Only endpoints with at least one file of the scenario itself. */
  readonly ownOnly: boolean;
}

export const INVENTORY_PARAMS = {
  query: 'q',
  method: 'method',
  collapsed: 'collapse',
  expanded: 'expand',
  scenario: 'scenario',
  own: 'own',
} as const;

export function filterFromSearch(search: URLSearchParams): InventoryFilter {
  return {
    query: search.get(INVENTORY_PARAMS.query) ?? '',
    methods: unique(search.getAll(INVENTORY_PARAMS.method).map((method) => method.toUpperCase())),
    collapsed: unique(search.getAll(INVENTORY_PARAMS.collapsed)),
    expanded: unique(search.getAll(INVENTORY_PARAMS.expanded)),
    scenario: scenarioFromSearch(search),
    ownOnly: search.get(INVENTORY_PARAMS.own) === '1',
  };
}

/** Replaces the inventory's entries in `search`, leaving everything else (e.g. the explorer's) as is. */
export function filterToSearch(filter: InventoryFilter, search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const name of Object.values(INVENTORY_PARAMS)) next.delete(name);
  if (filter.query !== '') next.set(INVENTORY_PARAMS.query, filter.query);
  for (const method of filter.methods) next.append(INVENTORY_PARAMS.method, method);
  for (const path of filter.collapsed) next.append(INVENTORY_PARAMS.collapsed, path);
  for (const path of filter.expanded) next.append(INVENTORY_PARAMS.expanded, path);
  if (filter.scenario !== null) next.set(INVENTORY_PARAMS.scenario, filter.scenario);
  if (filter.ownOnly) next.set(INVENTORY_PARAMS.own, '1');
  return next;
}

/** Only the inventory's entries, as a `?…` string for links that should keep the filtered view. */
export function inventorySearch(search: URLSearchParams): string {
  const kept = filterToSearch(filterFromSearch(search), new URLSearchParams());
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
}

export function isFiltering(filter: InventoryFilter): boolean {
  return filter.query.trim() !== '' || filter.methods.length > 0 || filter.ownOnly;
}

/** Each inventory's paths and methods in lower case, by position, computed once per inventory. */
const loweredOf = new WeakMap<readonly EndpointItem[], { readonly paths: string[]; readonly methods: string[] }>();

function lowered(items: readonly EndpointItem[]): { readonly paths: string[]; readonly methods: string[] } {
  let cached = loweredOf.get(items);
  if (cached === undefined) {
    cached = {
      paths: items.map((item) => item.path.toLowerCase()),
      methods: items.map((item) => item.method.toLowerCase()),
    };
    loweredOf.set(items, cached);
  }
  return cached;
}

/** Computes the lower-case forms ahead of the first keystroke, which would otherwise pay for all of them. */
export function prepareSearch(items: readonly EndpointItem[]): void {
  lowered(items);
}

/** The last result per inventory: typing usually narrows it, and only its matches need checking again. */
const lastOf = new WeakMap<
  readonly EndpointItem[],
  {
    readonly needle: string;
    readonly methods: string;
    /** The position in the inventory of each match. */
    readonly at: readonly number[];
  }
>();

/**
 * The endpoints the filter shows, in inventory order. Linear in the inventory,
 * or in the last result when the new search contains the last one, since
 * every match of the new search then matched the last.
 */
export function filterEndpoints(items: readonly EndpointItem[], filter: InventoryFilter): readonly EndpointItem[] {
  if (!isFiltering(filter)) return items;
  const needle = filter.query.trim().toLowerCase();
  const methods = filter.methods.length === 0 ? null : new Set(filter.methods);
  const methodsKey = `${filter.methods.join(' ')}${filter.ownOnly ? ' own' : ''}`;
  const last = lastOf.get(items);
  const narrowing = last !== undefined && last.methods === methodsKey && needle.includes(last.needle);
  const { paths, methods: methodNames } = lowered(items);
  const matched: EndpointItem[] = [];
  const at: number[] = [];
  const check = (index: number) => {
    const item = items[index] as EndpointItem;
    if (methods !== null && !methods.has(item.method)) return;
    if (filter.ownOnly && item.origin === 'inherited') return;
    if (
      needle !== '' &&
      !(paths[index] as string).includes(needle) &&
      !(methodNames[index] as string).includes(needle)
    ) {
      return;
    }
    matched.push(item);
    at.push(index);
  };
  if (narrowing) for (const index of last.at) check(index);
  else for (let index = 0; index < items.length; index++) check(index);
  // Everything matched: the same list, so the tree built from it is reused.
  const visible = matched.length === items.length ? items : matched;
  lastOf.set(items, { needle, methods: methodsKey, at });
  return visible;
}

/** The methods present in the inventory, in a conventional order, then alphabetically. */
export function methodsIn(items: readonly EndpointItem[]): string[] {
  const order = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  const present = new Set(items.map((item) => item.method));
  const rank = (method: string) => {
    const index = order.indexOf(method);
    return index === -1 ? order.length : index;
  };
  return [...present].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** "the search “prod” and the methods GET, POST": what an empty result was filtered by. */
export function describeFilter(filter: InventoryFilter): string {
  const parts: string[] = [];
  if (filter.query.trim() !== '') parts.push(`the search “${filter.query.trim()}”`);
  if (filter.methods.length === 1) parts.push(`the method ${filter.methods[0] ?? ''}`);
  if (filter.methods.length > 1) parts.push(`the methods ${filter.methods.join(', ')}`);
  if (filter.ownOnly) parts.push('the scenario’s own endpoints');
  return parts.join(' and ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}
