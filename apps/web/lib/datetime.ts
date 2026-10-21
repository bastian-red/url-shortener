/**
 * `datetime-local` gives a wall-clock time with no zone. The browser's offset
 * is posted alongside it (`tzOffset`, minutes, as `Date#getTimezoneOffset`
 * reports it) so "18:00" means 18:00 where the author is, not on the server.
 */
export function localToIso(local: string, offsetMinutes: number): string | null {
  if (local === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) + offsetMinutes * 60_000).toISOString();
}

/** The reverse, for pre-filling a `datetime-local` input in the viewer's zone. */
export function isoToLocal(iso: string | null, timeZone: string): string {
  if (iso === null) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
