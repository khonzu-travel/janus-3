import type { ClockStep, FormatSpec, PatternField, Unit } from './types.js';

/**
 * Calendar arithmetic and formatting. Pure: every
 * function takes the instant it works on. Timezone rules come from the
 * platform's `Intl` data; the host's own zone is never consulted.
 */

/** The ECMAScript Date range, in epoch milliseconds. */
export const MAX_INSTANT = 8.64e15;

const DAY = 86_400_000;
const UNIT_MS: Readonly<Record<Exclude<Unit, 'mo' | 'y'>, number>> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: DAY,
  w: 7 * DAY,
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let cached = formatters.get(zone);
  if (cached === undefined) {
    try {
      cached = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        era: 'short',
      });
    } catch {
      cached = null;
    }
    formatters.set(zone, cached);
  }
  return cached;
}

/** An IANA zone name, or a fixed offset from UTC in milliseconds (the offset an RFC 3339 value carries). */
export type Zone = string | number;

/** True for a zone `Intl` knows (IANA names, `UTC`). Offsets such as `+02:00` are not zones. */
export function isValidTimeZone(zone: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone) && formatter(zone) !== null;
}

/** True when the zone is UTC itself, so `:datetime` writes `Z` rather than an offset. */
export function isUtcZone(zone: string): boolean {
  return ['utc', 'etc/utc', 'etc/uct', 'uct', 'etc/zulu', 'zulu', 'universal', 'etc/universal'].includes(
    zone.toLowerCase(),
  );
}

/** The zone's offset from UTC at `instant`, in milliseconds (local = instant + offset). */
export function zoneOffset(zone: Zone, instant: number): number {
  if (typeof zone === 'number') return zone;
  if (isUtcZone(zone)) return 0;
  const format = formatter(zone);
  if (format === null) throw new RangeError(`unknown time zone ${zone}`);
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(instant)) parts[part.type] = part.value;
  // Astronomical year numbering: 1 BC is year 0.
  const year = parts['era'] === 'BC' ? 1 - Number(parts['year']) : Number(parts['year']);
  const local =
    civil(year, Number(parts['month']) - 1, Number(parts['day'])) +
    Number(parts['hour']) * 3_600_000 +
    Number(parts['minute']) * 60_000 +
    Number(parts['second']) * 1000;
  return local - (instant - mod(instant, 1000));
}

/** Local wall time (as if it were UTC) → the instant it names in `zone`. Gap times move forward. */
export function localToInstant(zone: Zone, local: number): number {
  const guess = local - zoneOffset(zone, local);
  return local - zoneOffset(zone, guess);
}

/** Epoch milliseconds of a proleptic Gregorian date at 00:00 UTC; any year, months may overflow. */
export function civil(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date.getTime();
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** A clock value mid-evaluation: an exact instant (`now`) or a local wall time (`today`). */
export interface ClockValue {
  readonly mode: 'instant' | 'local';
  readonly ms: number;
}

export interface EvaluatedClock {
  readonly instant: number;
  /** Wall time in the zone, as if it were UTC. */
  readonly local: number;
  readonly offset: number;
}

/**
 * Applies a clock token's start and steps. `now` stays an exact instant, so
 * `d` and smaller add exact durations; `today` is a local date, so every unit
 * moves the calendar. `mo` and `y` clamp to the last day of the target month.
 */
export function evaluateClock(
  start: 'now' | 'today',
  steps: readonly ClockStep[],
  zone: string,
  instant: number,
): EvaluatedClock {
  return evaluateSteps(
    start === 'now'
      ? { mode: 'instant', ms: instant }
      : { mode: 'local', ms: floorDay(instant + zoneOffset(zone, instant)) },
    steps,
    zone,
  );
}

/** Applies steps to an instant or a local wall time, as `evaluateClock` does for `now` and `today`. */
export function evaluateSteps(start: ClockValue, steps: readonly ClockStep[], zone: Zone): EvaluatedClock {
  const toLocal = (ms: number): number => ms + zoneOffset(zone, ms);
  let value = start;
  checkRange(value.ms);
  const inLocal = (change: (local: number) => number): void => {
    if (value.mode === 'local') value = { mode: 'local', ms: change(value.ms) };
    else value = { mode: 'instant', ms: localToInstant(zone, change(toLocal(value.ms))) };
  };
  for (const step of steps) {
    if (step.kind === 'add') {
      if (step.unit === 'mo' || step.unit === 'y') {
        const months = step.unit === 'y' ? step.amount * 12 : step.amount;
        inLocal((local) => addMonths(local, months));
      } else {
        value = { mode: value.mode, ms: value.ms + step.amount * UNIT_MS[step.unit] };
      }
    } else {
      inLocal((local) => snap(local, step.to));
    }
    checkRange(value.ms);
  }
  const result =
    value.mode === 'instant'
      ? { instant: value.ms, local: toLocal(value.ms) }
      : { instant: localToInstant(zone, value.ms), local: value.ms };
  checkRange(result.instant);
  return { ...result, offset: result.local - result.instant };
}

function checkRange(ms: number): void {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_INSTANT) throw new RangeError('the date is out of range');
}

function floorDay(local: number): number {
  return local - mod(local, DAY);
}

function addMonths(local: number, months: number): number {
  const date = new Date(local);
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = mod(total, 12);
  const day = Math.min(date.getUTCDate(), daysInMonth(year, month));
  return civil(year, month, day) + mod(local, DAY);
}

function daysInMonth(year: number, month: number): number {
  return new Date(civil(year, month + 1, 0)).getUTCDate();
}

function snap(local: number, to: 'startOfDay' | 'endOfDay' | 'startOfMonth' | 'endOfMonth'): number {
  const date = new Date(local);
  const time = mod(local, DAY);
  switch (to) {
    case 'startOfDay':
      return floorDay(local);
    case 'endOfDay':
      return floorDay(local) + DAY - 1;
    case 'startOfMonth':
      return civil(date.getUTCFullYear(), date.getUTCMonth(), 1) + time;
    case 'endOfMonth':
      return (
        civil(date.getUTCFullYear(), date.getUTCMonth(), daysInMonth(date.getUTCFullYear(), date.getUTCMonth())) + time
      );
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A formatted clock value: a string, or a number for `:unix` and `:unixMillis`. */
export function formatClock(value: EvaluatedClock, format: FormatSpec, zone: Zone): string | number {
  const local = new Date(value.local);
  switch (format.kind) {
    case 'unix':
      return Math.floor(value.instant / 1000);
    case 'unixMillis':
      return value.instant;
    case 'utc':
      return rfc3339(value.instant - mod(value.instant, 1000));
    case 'date':
      return `${year4(local)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    case 'time':
      return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    case 'datetime': {
      const date = `${year4(local)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
      const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
      const utc = typeof zone === 'number' ? zone === 0 : isUtcZone(zone);
      return `${date}T${time}${utc ? 'Z' : offsetText(value.offset)}`;
    }
    case 'http': {
      const utc = new Date(value.instant);
      return `${DAYS[utc.getUTCDay()] ?? ''}, ${pad(utc.getUTCDate())} ${MONTHS[utc.getUTCMonth()] ?? ''} ${year4(utc)} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())} GMT`;
    }
    case 'pattern':
      return format.parts
        .map((part) => (part.kind === 'literal' ? part.text : field(part.field, local, value)))
        .join('');
  }
}

function field(name: PatternField, local: Date, value: EvaluatedClock): string {
  switch (name) {
    case 'yyyy':
      return year4(local);
    case 'yy':
      return pad(mod(local.getUTCFullYear(), 100));
    case 'MM':
      return pad(local.getUTCMonth() + 1);
    case 'M':
      return String(local.getUTCMonth() + 1);
    case 'MMM':
      return MONTHS[local.getUTCMonth()] ?? '';
    case 'dd':
      return pad(local.getUTCDate());
    case 'd':
      return String(local.getUTCDate());
    case 'HH':
      return pad(local.getUTCHours());
    case 'H':
      return String(local.getUTCHours());
    case 'mm':
      return pad(local.getUTCMinutes());
    case 'ss':
      return pad(local.getUTCSeconds());
    case 'SSS':
      return String(local.getUTCMilliseconds()).padStart(3, '0');
    case 'EEE':
      return DAYS[local.getUTCDay()] ?? '';
    case 'XXX':
      return value.offset === 0 ? 'Z' : offsetText(value.offset);
  }
}

/** RFC 3339 in UTC; fractional seconds only when the instant has them. */
export function rfc3339(instant: number): string {
  const date = new Date(instant);
  const ms = date.getUTCMilliseconds();
  const fraction = ms === 0 ? '' : `.${String(ms).padStart(3, '0')}`;
  return `${year4(date)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${fraction}Z`;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses an RFC 3339 date-time with an offset ("2026-01-01T00:00:00Z",
 * "2026-01-01T09:00:00+09:00"). Fractions beyond milliseconds are truncated.
 * Returns null for anything else, including impossible dates and leap seconds.
 */
export function parseRfc3339(text: string): number | null {
  return parseRfc3339WithOffset(text)?.instant ?? null;
}

/** `parseRfc3339`, also returning the offset the text was written in, in milliseconds. */
export function parseRfc3339WithOffset(text: string): { readonly instant: number; readonly offset: number } | null {
  const match = RFC3339.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 0 || month > 11 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59)
    return null;
  let offset = 0;
  if (zulu === undefined) {
    const offsetHours = Number(oh);
    const offsetMinutes = Number(om);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offset = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  const ms = Number((fraction ?? '').padEnd(3, '0').slice(0, 3));
  return {
    instant: civil(year, month, day) + hour * 3_600_000 + minute * 60_000 + second * 1000 + ms - offset,
    offset,
  };
}

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An RFC 3339 full-date ("2026-11-01") as a local wall time at midnight, or null for anything else. */
export function parseRfc3339Date(text: string): number | null {
  const match = FULL_DATE.exec(text);
  if (match === null) return null;
  const [, y, mo, d] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  if (month < 0 || month > 11 || day < 1 || day > daysInMonth(year, month)) return null;
  return civil(year, month, day);
}

function offsetText(offset: number): string {
  const minutes = Math.round(Math.abs(offset) / 60_000);
  return `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function year4(date: Date): string {
  const year = date.getUTCFullYear();
  return year < 0
    ? `-${String(-year).padStart(6, '0')}`
    : year > 9999
      ? `+${String(year)}`
      : String(year).padStart(4, '0');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
