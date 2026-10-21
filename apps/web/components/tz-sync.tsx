'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export const TZ_COOKIE = 'tz';

/**
 * Tell the server the viewer's time zone, once.
 *
 * Reports cut days at the viewer's midnight, and the server renders the first
 * paint, so it has to know the zone before the first fetch. The browser is the
 * only one who knows it: this writes it to a cookie and, if the page was
 * rendered in a different zone, asks for one re-render. After that the cookie
 * is sent with every request and nothing here runs again.
 */
export function TzSync({ rendered }: { readonly rendered: string }) {
  const router = useRouter();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || zone === rendered) return;
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [rendered, router]);
  return null;
}
