import Link from 'next/link';
import { notFound } from 'next/navigation';

import { analyticsSchema, linkSchema } from '@links/shared';

import { AppBar, Footer } from '../../../../components/app-bar';
import { CopyButton } from '../../../../components/copy-button';
import { EditLink } from '../../../../components/edit-link';
import { LiveTape } from '../../../../components/live-tape';
import { Report } from '../../../../components/report';
import { StatusBadge } from '../../../../components/status-badge';
import { TzSync } from '../../../../components/tz-sync';
import { ApiError, apiFetch, query } from '../../../../lib/api';
import { isRangeKey, presetRange, RANGE_PRESETS, type RangeKey } from '../../../../lib/range';
import { requireUser } from '../../../../lib/session';
import { viewerTimeZone } from '../../../../lib/viewer';
import { deleteLinkAction, setDisabledAction, updateLinkAction } from '../../actions';

export const metadata = { title: 'Link' };

/** One link: what it is, where it goes, and every click it has carried. */
export default async function LinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[a-z0-9]{20,40}$/u.test(id)) notFound();
  const range: RangeKey = isRangeKey(sp.range) ? sp.range : '7d';
  const user = await requireUser(`/links/${id}${range === '7d' ? '' : `?range=${range}`}`);
  const timeZone = await viewerTimeZone();
  const window = presetRange(range, new Date());

  let link;
  let analytics;
  try {
    [link, analytics] = await Promise.all([
      apiFetch(user, `/links/${id}`, linkSchema),
      apiFetch(
        user,
        `/links/${id}/analytics${query({ ...window, tz: timeZone })}`,
        analyticsSchema,
      ),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <>
      <AppBar user={user} current="links" />
      <TzSync rendered={timeZone} />
      <main id="main" className="page">
        <div className="detail">
          <div className="detail-main">
            <header className="detail-head">
              <nav className="detail-crumbs" aria-label="Breadcrumb">
                <Link href="/">← All links</Link>
              </nav>
              <h1 className="detail-title">{link.title ?? `/${link.slug}`}</h1>
              <div className="detail-short">
                <code className="detail-short-url" data-testid="short-url" translate="no">
                  {link.shortUrl}
                </code>
                <CopyButton value={link.shortUrl} label="Copy link" />
                <StatusBadge status={link.status} />
              </div>
              <p className="detail-dest">
                Goes to{' '}
                <a href={link.url} rel="noopener noreferrer nofollow">
                  {link.url}
                </a>
                {link.expiresAt === null ? null : (
                  <>
                    {' '}
                    · expires{' '}
                    {new Date(link.expiresAt).toLocaleString('en-GB', {
                      timeZone,
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </>
                )}
                {link.maxClicks === null ? null : (
                  <> · limit {link.maxClicks.toLocaleString('en-US')} visits</>
                )}
              </p>
              <div className="detail-actions">
                <a
                  className="button button-small"
                  href={`/api/links/${link.id}/qr?format=png&size=1024&download=1`}
                >
                  QR code (PNG)
                </a>
                <a
                  className="button button-small"
                  href={`/api/links/${link.id}/qr?format=svg&download=1`}
                >
                  QR code (SVG)
                </a>
                <form action={setDisabledAction}>
                  <input type="hidden" name="id" value={link.id} />
                  <input type="hidden" name="disabled" value={link.disabled ? 'false' : 'true'} />
                  <button className="button button-small" type="submit">
                    {link.disabled ? 'Turn back on' : 'Turn off'}
                  </button>
                </form>
              </div>
            </header>

            <nav className="ranges" aria-label="Range">
              {(Object.keys(RANGE_PRESETS) as RangeKey[]).map((key) => (
                <Link
                  key={key}
                  href={`/links/${link.id}?range=${key}`}
                  aria-current={key === range ? 'page' : undefined}
                >
                  {key}
                </Link>
              ))}
            </nav>

            <Report linkId={link.id} slug={link.slug} initial={analytics} />

            <details className="panel">
              <summary className="panel-title" style={{ cursor: 'pointer' }}>
                Edit link
              </summary>
              <div style={{ marginTop: 14 }}>
                <EditLink link={link} timeZone={timeZone} action={updateLinkAction} />
              </div>
            </details>

            <details className="panel">
              <summary className="panel-title button-danger" style={{ cursor: 'pointer' }}>
                Delete link
              </summary>
              <form action={deleteLinkAction} className="edit" style={{ marginTop: 14 }}>
                <input type="hidden" name="id" value={link.id} />
                <p style={{ margin: 0 }}>
                  Visitors will get “No link here”. The slug <code>/{link.slug}</code> stays
                  reserved forever, so a printed QR code can never send its scans to somebody else.
                </p>
                <div>
                  <button className="button button-danger" type="submit">
                    Delete /{link.slug}
                  </button>
                </div>
              </form>
            </details>
          </div>
          <LiveTape linkId={link.id} timeZone={timeZone} />
        </div>
      </main>
      <Footer />
    </>
  );
}
