import Link from 'next/link';

import { linkListSchema } from '@links/shared';

import { AppBar, Footer } from '../../components/app-bar';
import { CommandBar } from '../../components/command-bar';
import { LiveCount, LiveLedger } from '../../components/live-ledger';
import { Sparkline } from '../../components/sparkline';
import { StatusBadge } from '../../components/status-badge';
import { apiFetch } from '../../lib/api';
import { shortOrigin } from '../../lib/config';
import { formatCount, shortDestination } from '../../lib/format';
import { requireUser } from '../../lib/session';
import { createLinkAction } from './actions';

export const metadata = { title: 'Links' };

/** The ledger: every link, newest first, each with its last day and its live count. */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const user = await requireUser('/');
  const [{ items }, params] = await Promise.all([
    apiFetch(user, '/links', linkListSchema),
    searchParams,
  ]);
  const total = items.reduce((sum, link) => sum + link.clicks, 0);

  return (
    <>
      <AppBar user={user} />
      <main id="main" className="page">
        <CommandBar action={createLinkAction} shortOrigin={shortOrigin} />
        {params.deleted === '1' ? (
          <p className="notice" role="status" style={{ marginTop: 16 }}>
            Link deleted. Its slug stays reserved, so nobody else can claim it.
          </p>
        ) : null}

        <div className="ledger-head">
          <h2 className="ledger-title">Your links</h2>
          <span className="ledger-meta tabular">
            {formatCount(items.length)} links · {formatCount(total)} clicks
          </span>
        </div>

        <LiveLedger key={items.map((link) => link.id).join(' ')}>
          <table className="ledger">
            <caption className="visually-hidden">Your short links, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Link</th>
                <th scope="col">Status</th>
                <th scope="col">Last 24 hours</th>
                <th scope="col" className="num">
                  Clicks
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="ledger-empty">
                    No links yet. Paste one above to make your first.
                  </td>
                </tr>
              ) : (
                items.map((link) => (
                  <tr key={link.id} data-slug={link.slug}>
                    <td className="link-cell">
                      <div className="ledger-link">
                        <div className="ledger-link-title">
                          <Link
                            className="slug-pill"
                            href={`/links/${link.id}`}
                            aria-label={`/${link.slug}, open its clicks`}
                          >
                            {link.slug}
                          </Link>
                          {link.title === null ? null : (
                            <Link href={`/links/${link.id}`}>{link.title}</Link>
                          )}
                        </div>
                        <span className="ledger-dest" title={link.url}>
                          → {shortDestination(link.url)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={link.status} />
                    </td>
                    <td className="spark-cell">
                      <Sparkline values={link.last24h} />
                    </td>
                    <td className="num">
                      <LiveCount linkId={link.id} initial={link.clicks} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </LiveLedger>
      </main>
      <Footer />
    </>
  );
}
