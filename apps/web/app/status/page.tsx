import Link from 'next/link';

import { statusSchema, type Status } from '@links/shared';

import { Brand } from '../../components/brand';
import { apiBaseUrl } from '../../lib/config';
import { formatCount, formatLatency } from '../../lib/format';

export const metadata = { title: 'Status' };
export const dynamic = 'force-dynamic';

/**
 * Public, like the API's /health: every service, its dependencies and the click
 * pipeline, fed by the API's GET /status. A page that 500s when a dependency is
 * down cannot tell you the dependency is down, so a failure to reach the API is
 * rendered, not thrown.
 */
async function load(): Promise<Status | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    const parsed = statusSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const SERVICE_TEXT: Record<string, string> = {
  api: 'Links, analytics and accounts',
  redirect: 'Answers every short link (Go)',
  'click-worker': 'Turns visits into analytics',
};

export default async function StatusPage() {
  const status = await load();
  const allOk = status !== null && status.services.every((s) => s.status === 'ok');

  return (
    <>
      <header className="app-bar">
        <Brand />
        <nav className="app-bar-nav" aria-label="Site">
          <Link href="/">Links</Link>
          <Link href="/status" aria-current="page">
            Status
          </Link>
        </nav>
      </header>
      <main id="main" className="page" style={{ display: 'grid', gap: 20 }}>
        <div>
          <h1 style={{ fontSize: 28 }}>Status</h1>
          <p
            className="status"
            data-tone={allOk ? 'ok' : 'off'}
            style={{ marginTop: 8, fontSize: 15 }}
            data-testid="overall"
          >
            <span aria-hidden="true">{allOk ? '●' : '▲'}</span>
            {status === null
              ? 'The API is not answering'
              : allOk
                ? 'Every service is up'
                : 'Something is degraded'}
          </p>
        </div>

        {status === null ? null : (
          <>
            <div className="status-grid">
              {status.services.map((service) => (
                <section
                  key={service.service}
                  className="panel"
                  aria-labelledby={`svc-${service.service}`}
                  data-service={service.service}
                >
                  <div className="panel-head" style={{ marginBottom: 4 }}>
                    <h2 id={`svc-${service.service}`} className="service-name">
                      {service.service}
                    </h2>
                    <span className="status" data-tone={service.status === 'ok' ? 'ok' : 'off'}>
                      <span aria-hidden="true">
                        {service.status === 'ok'
                          ? '●'
                          : service.status === 'unreachable'
                            ? '✕'
                            : '▲'}
                      </span>
                      {service.status === 'ok'
                        ? 'Up'
                        : service.status === 'unreachable'
                          ? 'Unreachable'
                          : 'Degraded'}
                    </span>
                  </div>
                  <p className="panel-note" style={{ margin: 0 }}>
                    {SERVICE_TEXT[service.service]}
                  </p>
                  {service.status === 'unreachable' ? (
                    <p className="checks detail-text">No answer ({service.detail}).</p>
                  ) : (
                    <ul className="checks">
                      {service.checks.map((check) => (
                        <li key={check.name}>
                          <span>
                            <span aria-hidden="true">{check.status === 'ok' ? '✓ ' : '✕ '}</span>
                            {check.name}
                            {check.detail === null ? null : (
                              <span className="detail-text"> · {check.detail}</span>
                            )}
                          </span>
                          <span className="tabular mono">
                            {check.status === 'ok' ? formatLatency(check.latencyMs) : 'failing'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>

            <section className="panel" aria-labelledby="pipeline-title">
              <div className="panel-head">
                <h2 id="pipeline-title" className="panel-title">
                  Click pipeline
                </h2>
                <span className="panel-note">Since the worker last started</span>
              </div>
              {status.pipeline === null ? (
                <p className="breakdown-empty">The worker is not reporting.</p>
              ) : (
                <dl className="pipeline">
                  <div>
                    <dt>Waiting in the stream</dt>
                    <dd>
                      {status.pipeline.lag === null ? 'n/a' : formatCount(status.pipeline.lag)}
                    </dd>
                  </div>
                  <div>
                    <dt>Being processed</dt>
                    <dd>{formatCount(status.pipeline.pending)}</dd>
                  </div>
                  <div>
                    <dt>Clicks stored</dt>
                    <dd>{formatCount(status.pipeline.inserted)}</dd>
                  </div>
                  <div>
                    <dt>Duplicates ignored</dt>
                    <dd>{formatCount(status.pipeline.duplicates)}</dd>
                  </div>
                  <div>
                    <dt>Dead-lettered</dt>
                    <dd>{formatCount(status.pipeline.dead)}</dd>
                  </div>
                </dl>
              )}
            </section>
            <p className="panel-note">
              Checked {new Date(status.checkedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
            </p>
          </>
        )}
      </main>
    </>
  );
}
