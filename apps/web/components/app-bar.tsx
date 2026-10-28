import Link from 'next/link';

import type { SessionUser } from '@links/shared';

import { signOutAction } from '../app/(app)/actions';
import { Brand } from './brand';

export function AppBar({
  user,
  current,
}: {
  readonly user: SessionUser;
  /** Which nav entry this page is, for `aria-current` (the link page is part of Links). */
  readonly current?: 'links' | 'status';
}) {
  return (
    <header className="app-bar">
      <Brand />
      <nav className="app-bar-nav" aria-label="Account">
        <Link href="/" aria-current={current === 'links' ? 'page' : undefined}>
          Links
        </Link>
        <Link href="/status" aria-current={current === 'status' ? 'page' : undefined}>
          Status
        </Link>
        <span className="app-bar-user">{user.name}</span>
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </nav>
    </header>
  );
}

/** DB-IP's licence (CC BY 4.0) requires attribution wherever its data is shown. */
export function Footer() {
  return (
    <footer className="page-footer">
      IP geolocation by <a href="https://db-ip.com">DB-IP</a> (CC BY 4.0). Addresses are never
      stored.
    </footer>
  );
}
