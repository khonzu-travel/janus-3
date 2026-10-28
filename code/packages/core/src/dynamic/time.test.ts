import { describe, expect, it } from 'vitest';

import { parseExpression } from './grammar.js';
import { evaluateClock, formatClock, isValidTimeZone, parseRfc3339, rfc3339 } from './time.js';

// Rendered against 2026-09-15T14:22:08Z (a Tuesday).
const INSTANT = Date.UTC(2026, 8, 15, 14, 22, 8);

function render(expression: string, instant = INSTANT, timezone = 'UTC'): string | number {
  const parsed = parseExpression(expression);
  if (!parsed.ok) throw new Error(parsed.message);
  const spec = parsed.token.spec;
  if (spec.category !== 'clock') throw new Error('not a clock token');
  const zone = spec.zone ?? timezone;
  return formatClock(evaluateClock(spec.start, spec.steps, zone, instant), spec.format, zone);
}

describe('clock bases', () => {
  it.each([
    ['now', '2026-09-15T14:22:08Z'],
    ['today', '2026-09-15'],
  ])('%s renders %s', (expression, expected) => {
    expect(render(expression)).toBe(expected);
  });

  it('renders today in the active timezone, never the host zone', () => {
    const late = Date.UTC(2026, 8, 15, 23, 30);
    expect(render('today', late, 'UTC')).toBe('2026-09-15');
    expect(render('today', late, 'Asia/Tokyo')).toBe('2026-09-16');
    expect(render('today', late, 'America/Los_Angeles')).toBe('2026-09-15');
  });
});

describe('aliases', () => {
  it.each([
    ['tomorrow', 'today+1d', '2026-09-16'],
    ['yesterday', 'today-1d', '2026-09-14'],
    ['oneWeekFromToday', 'today+1w', '2026-09-22'],
    ['oneWeekAgo', 'today-1w', '2026-09-08'],
    ['oneMonthFromToday', 'today+1mo', '2026-10-15'],
    ['oneYearFromToday', 'today+1y', '2027-09-15'],
    ['startOfDay', null, '2026-09-15T00:00:00Z'],
    ['endOfDay', null, '2026-09-15T23:59:59Z'],
    ['startOfMonth', null, '2026-09-01'],
    ['endOfMonth', null, '2026-09-30'],
    ['epoch', 'now:unix', Math.floor(INSTANT / 1000)],
  ])('%s is %s', (alias, equivalent, expected) => {
    expect(render(alias)).toEqual(expected);
    if (equivalent !== null) expect(render(equivalent)).toEqual(expected);
  });

  it('snaps endOfDay to 23:59:59.999', () => {
    expect(render('endOfDay:unixMillis')).toBe(Date.UTC(2026, 8, 15, 23, 59, 59, 999));
    expect(render('endOfDay:"HH:mm:ss.SSS"')).toBe('23:59:59.999');
  });

  it('snaps startOfDay in the active timezone', () => {
    // 14:22 UTC is 23:22 in Tokyo, whose day began at 15:00 UTC the day before.
    expect(render('startOfDay', INSTANT, 'Asia/Tokyo')).toBe('2026-09-14T15:00:00Z');
    expect(render('startOfDay@Asia/Tokyo')).toBe('2026-09-15T00:00:00+09:00');
  });

  it('adds the token’s offsets after an alias', () => {
    expect(render('tomorrow+1d')).toBe('2026-09-17');
    expect(render('epoch:date')).toBe('2026-09-15');
  });
});

describe('offsets', () => {
  it.each([
    ['now+500ms:unixMillis', INSTANT + 500],
    ['now+30s', '2026-09-15T14:22:38Z'],
    ['now+15min', '2026-09-15T14:37:08Z'],
    ['now+2h', '2026-09-15T16:22:08Z'],
    ['now+2h15min', '2026-09-15T16:37:08Z'],
    ['now-1d', '2026-09-14T14:22:08Z'],
    ['now+1w', '2026-09-22T14:22:08Z'],
    ['now+1mo', '2026-10-15T14:22:08Z'],
    ['now-1y', '2025-09-15T14:22:08Z'],
    ['today+1mo-1d', '2026-10-14'],
    ['today + 7d', '2026-09-22'],
  ])('%s is %s', (expression, expected) => {
    expect(render(expression)).toEqual(expected);
  });

  it('clamps months and years to the last day of the target month', () => {
    const jan31 = Date.UTC(2026, 0, 31);
    expect(render('today+1mo', jan31)).toBe('2026-02-28');
    expect(render('today+1mo', Date.UTC(2028, 0, 31))).toBe('2028-02-29');
    expect(render('today-1mo', Date.UTC(2026, 2, 31))).toBe('2026-02-28');
    expect(render('today+1y', Date.UTC(2028, 1, 29))).toBe('2029-02-28');
    expect(render('today+13mo', jan31)).toBe('2027-02-28');
  });

  it('adds exact durations to now, but calendar days to today, across a DST change', () => {
    // Europe/Berlin leaves summer time on 2026-10-25: that day has 25 hours.
    const before = Date.UTC(2026, 9, 24, 22, 30); // 00:30 local on the 25th
    expect(render('now+1d@Europe/Berlin:datetime', before)).toBe('2026-10-25T23:30:00+01:00');
    expect(render('today+1d', before, 'Europe/Berlin')).toBe('2026-10-26');
  });
});

describe('timezones', () => {
  it('overrides the active zone per token', () => {
    expect(render('today@Asia/Tokyo', Date.UTC(2026, 8, 15, 20))).toBe('2026-09-16');
    expect(render('now@Asia/Tokyo')).toBe('2026-09-15T23:22:08+09:00');
    expect(render('now@America/New_York:time')).toBe('10:22:08');
  });

  it('knows IANA zones from Intl and nothing else', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+02:00')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('formats', () => {
  it.each([
    ['now:date', '2026-09-15'],
    ['now:datetime', '2026-09-15T14:22:08Z'],
    ['now:time', '14:22:08'],
    ['now:unix', 1789482128],
    ['now:unixMillis', INSTANT],
    ['now:http', 'Tue, 15 Sep 2026 14:22:08 GMT'],
    ['today:"dd/MM/yyyy"', '15/09/2026'],
    ['now:"yy M d H"', '26 9 15 14'],
    ['now:"EEE, dd MMM yyyy HH:mm:ss"', 'Tue, 15 Sep 2026 14:22:08'],
    ['now:"SSS"', '000'],
    ['now:"XXX"', 'Z'],
    ['now:"yyyy-MM-dd\'T\'HH:mm"', '2026-09-15T14:22'],
    ["now:\"'o''clock' H\"", "o'clock 14"],
  ])('%s is %j', (expression, expected) => {
    expect(render(expression)).toEqual(expected);
  });

  it('uses the offset form in a non-UTC zone, and GMT for :http always', () => {
    expect(render('now@Europe/Paris:datetime')).toBe('2026-09-15T16:22:08+02:00');
    expect(render('now@Europe/Paris:"XXX"')).toBe('+02:00');
    expect(render('now@Europe/Paris:http')).toBe('Tue, 15 Sep 2026 14:22:08 GMT');
    expect(render('now:datetime', INSTANT, 'Asia/Kolkata')).toBe('2026-09-15T19:52:08+05:30');
  });

  it('keeps now in UTC by default, whatever the active zone', () => {
    expect(render('now', INSTANT, 'Asia/Tokyo')).toBe('2026-09-15T14:22:08Z');
  });
});

describe('RFC 3339 instants', () => {
  it.each([
    ['2026-01-01T00:00:00Z', Date.UTC(2026, 0, 1)],
    ['2026-01-01t00:00:00z', Date.UTC(2026, 0, 1)],
    ['2026-01-01T09:00:00+09:00', Date.UTC(2026, 0, 1)],
    ['2025-12-31T19:00:00-05:00', Date.UTC(2026, 0, 1)],
    ['2026-01-01T00:00:00.123456Z', Date.UTC(2026, 0, 1) + 123],
    ['2028-02-29T00:00:00Z', Date.UTC(2028, 1, 29)],
  ])('parses %s', (text, expected) => {
    expect(parseRfc3339(text)).toBe(expected);
  });

  it.each([
    '2026-01-01',
    '2026-01-01T00:00:00',
    '2026-01-01 00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-15T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00',
    'yesterday',
    '',
  ])('rejects %j', (text) => {
    expect(parseRfc3339(text)).toBeNull();
  });

  it('formats in UTC, with milliseconds only when present', () => {
    expect(rfc3339(INSTANT)).toBe('2026-09-15T14:22:08Z');
    expect(rfc3339(INSTANT + 5)).toBe('2026-09-15T14:22:08.005Z');
  });
});
