/** `26-10-17 03:27:06`: two-digit year, month and day, then the 24-hour time. */
export function shortTimestamp(iso: string, timeZone?: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    // An unknown timezone falls back to the browser's own.
    return shortTimestamp(iso);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    format.formatToParts(instant).find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/** A time in a table: short, in the server clock's timezone, with the full ISO time as its tooltip. */
export function Timestamp({ iso, timeZone }: { readonly iso: string; readonly timeZone: string | undefined }) {
  return (
    <time dateTime={iso} title={iso}>
      {shortTimestamp(iso, timeZone)}
    </time>
  );
}
