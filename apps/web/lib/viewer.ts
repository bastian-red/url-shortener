import 'server-only';

import { cookies } from 'next/headers';

/**
 * The viewer's time zone, from the cookie `TzSync` writes. UTC until the
 * browser has said otherwise, and UTC for anything that is not a zone this
 * runtime knows: the value goes into an API query, and a garbage zone should
 * degrade to UTC rather than to an error page.
 */
export async function viewerTimeZone(): Promise<string> {
  const raw = (await cookies()).get('tz')?.value;
  if (raw === undefined) return 'UTC';
  const zone = decodeURIComponent(raw);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}
