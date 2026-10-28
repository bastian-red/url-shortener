'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import { analyticsSchema, type Analytics, type Dimension } from '@links/shared';

import {
  bucketLabel,
  bucketTitle,
  dimensionLabel,
  formatCompact,
  formatCount,
  formatPercent,
} from '../lib/format';
import { brushRange, bucketAt } from '../lib/range';
import { BOARD_W, ROW_H, routeBoard } from '../lib/route';
import { heatStep, niceMax } from '../lib/spark';

/**
 * The link page's report: one timeline for the whole range, and everything
 * below it (the totals, five breakdowns, the week grid) scoped to whatever the
 * author brushes on it.
 *
 * The brush is the signature interaction: drag across the
 * bars, or focus the chart and use the arrow keys (Shift extends, Enter
 * applies, Escape clears). The scoped numbers come from the API for exactly the
 * brushed hours, so the breakdowns are real numbers for that window, never the
 * whole range's numbers scaled down.
 */

/**
 * The timeline is drawn in CSS pixels at the width it is shown at (measured,
 * 720 before hydration), so its 11px axis labels stay 11px on a phone instead
 * of shrinking with a fixed viewBox to an unreadable 5px.
 */
const DEFAULT_W = 720;
const MIN_W = 280;
const H = 200;
const PAD = { top: 10, right: 8, bottom: 24, left: 44 };
const PLOT_H = H - PAD.top - PAD.bottom;
const TOP_ROWS = 6;

const DIMENSION_TITLES: Record<Dimension, string> = {
  country: 'Countries',
  referrer: 'Referrers',
  device: 'Devices',
  browser: 'Browsers',
  os: 'Operating systems',
};

interface Props {
  readonly linkId: string;
  readonly slug: string;
  readonly initial: Analytics;
}

type Selection = { a: number; b: number } | null;

export function Report({ linkId, slug, initial }: Props) {
  const [scope, setScope] = useState<{ from: string; to: string } | null>(null);
  const [scoped, setScoped] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    async (range: { from: string; to: string } | null) => {
      setScope(range);
      setError(null);
      if (range === null) {
        setScoped(null);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams({ from: range.from, to: range.to, tz: initial.tz });
        const response = await fetch(`/api/links/${linkId}/analytics?${params.toString()}`);
        if (!response.ok) throw new Error(String(response.status));
        setScoped(analyticsSchema.parse(await response.json()));
      } catch {
        setError('That window could not be loaded. The whole range is still shown.');
        setScoped(null);
      } finally {
        setLoading(false);
      }
    },
    [initial.tz, linkId],
  );

  // A new range from the server (the preset links) drops any brush on the old one.
  useEffect(() => {
    setScope(null);
    setScoped(null);
  }, [initial.from, initial.to]);

  const view = scoped ?? initial;

  return (
    <div className="report" data-ready="true">
      <Kpis report={view} />
      <section className="panel" aria-labelledby="timeline-title">
        <div className="panel-head">
          <h2 id="timeline-title" className="panel-title">
            Clicks per {initial.bucket}
          </h2>
          <span className="panel-note">Times in {initial.tz}</span>
        </div>
        <Timeline report={initial} scope={scope} onBrush={(range) => void apply(range)} />
        {scope === null ? null : (
          <div className="scope" role="status" style={{ marginTop: 12 }}>
            <span>
              Showing {loading ? '…' : formatCount(view.totals.clicks)} clicks from{' '}
              <strong>{bucketTitle(scope.from, initial.bucket, initial.tz)}</strong> to{' '}
              <strong>
                {bucketTitle(
                  new Date(Date.parse(scope.to) - 1).toISOString(),
                  initial.bucket,
                  initial.tz,
                )}
              </strong>
            </span>
            <button type="button" className="button button-small" onClick={() => void apply(null)}>
              Show the whole range
            </button>
          </div>
        )}
        {error === null ? null : (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
      </section>

      <div className="breakdowns" aria-busy={loading}>
        <RouteBoard slug={slug} report={view} />
        <section className="panel" aria-labelledby="audience-title">
          <div className="panel-head">
            <h2 id="audience-title" className="panel-title">
              What they clicked on
            </h2>
          </div>
          <div className="audience">
            {(['device', 'browser', 'os'] as const).map((dimension) => (
              <Breakdown key={dimension} dimension={dimension} report={view} />
            ))}
          </div>
        </section>
        <WeekGrid report={view} />
      </div>
    </div>
  );
}

/**
 * The three totals, as one strip of figures rather than three cards, each with
 * the sentence that says what it counts. "Visitors" is the honest one to word
 * carefully: the visitor hash rotates its key daily and the distinct set is
 * kept per hour, so a person who clicks twice in one hour counts once, and the
 * same person tomorrow counts again.
 */
function Kpis({ report }: { readonly report: Analytics }) {
  const { clicks, visitors, bots } = report.totals;
  return (
    <dl className="kpis">
      <div className="kpi">
        <dt className="kpi-label">Clicks</dt>
        <dd className="kpi-value" data-testid="kpi-clicks">
          {formatCount(clicks)}
        </dd>
        <dd className="kpi-sub">From people. Bots and link previews are left out.</dd>
      </div>
      <div className="kpi">
        <dt className="kpi-label">Visitors</dt>
        <dd className="kpi-value">{formatCount(visitors)}</dd>
        <dd className="kpi-sub">Someone clicking twice in the same hour counts once.</dd>
      </div>
      <div className="kpi">
        <dt className="kpi-label">Bots and previews</dt>
        <dd className="kpi-value">{formatCount(bots)}</dd>
        <dd className="kpi-sub">Slack, chat and social unfurls, crawlers. Not in Clicks.</dd>
      </div>
    </dl>
  );
}

function Timeline({
  report,
  scope,
  onBrush,
}: {
  readonly report: Analytics;
  readonly scope: { from: string; to: string } | null;
  readonly onBrush: (range: { from: string; to: string } | null) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setW(Math.max(MIN_W, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const PLOT_W = W - PAD.left - PAD.right;
  const [drag, setDrag] = useState<Selection>(null);
  const [keyboard, setKeyboard] = useState<Selection>(null);
  const [hover, setHover] = useState<number | null>(null);

  const series = report.series;
  const n = series.length;
  const buckets = series.map((s) => s.t);
  const max = niceMax(Math.max(0, ...series.map((s) => s.clicks)));
  const slot = PLOT_W / Math.max(1, n);
  // Thin marks with a 2px surface gap (dataviz): never wider than 18px.
  const barW = Math.max(1, Math.min(18, slot - 2));
  const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

  // Which buckets the current scope covers, for fading the rest.
  const inScope = (t: string) => scope === null || (t >= scope.from && t < scope.to);
  const live = drag ?? keyboard;

  const indexAt = (event: PointerEvent<SVGRectElement>) => {
    const box = svg.current!.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * W - PAD.left;
    return bucketAt(x, PLOT_W, n);
  };

  const commit = (selection: Selection) => {
    if (selection === null) return;
    onBrush(brushRange(buckets, report.to, selection.a, selection.b));
  };

  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    const cursor = keyboard ?? { a: n - 1, b: n - 1 };
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (step !== 0) {
      event.preventDefault();
      const b = Math.max(0, Math.min(n - 1, cursor.b + step));
      setKeyboard(event.shiftKey ? { a: cursor.a, b } : { a: b, b });
      setHover(b);
    } else if (event.key === 'Enter' && keyboard !== null) {
      event.preventDefault();
      commit(keyboard);
      setKeyboard(null);
    } else if (event.key === 'Escape') {
      setKeyboard(null);
      onBrush(null);
    }
  };

  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  // About one date label per 110px, so labels never collide at any width.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(PLOT_W / 110))));
  const hovered = hover === null ? null : series[hover];

  return (
    <div className="timeline" ref={box}>
      <svg
        ref={svg}
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        aria-labelledby="timeline-title timeline-desc"
      >
        <desc id="timeline-desc">
          {`Bar chart of ${formatCount(report.totals.clicks)} clicks over ${String(n)} ${report.bucket}s. The same numbers are in the table below.`}
        </desc>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
              {formatCompact(t)}
            </text>
          </g>
        ))}
        {series.map((point, i) =>
          i % labelEvery === 0 ? (
            <text
              key={point.t}
              className="axis-label"
              x={PAD.left + i * slot + slot / 2}
              y={H - 6}
              textAnchor="middle"
            >
              {bucketLabel(point.t, report.bucket, report.tz)}
            </text>
          ) : null,
        )}
        {series.map((point, i) => {
          const h = Math.max(point.clicks > 0 ? 1 : 0, PLOT_H - (y(point.clicks) - PAD.top));
          return (
            <rect
              key={point.t}
              className="bar"
              data-out={!inScope(point.t)}
              x={PAD.left + i * slot + (slot - barW) / 2}
              y={PAD.top + PLOT_H - h}
              width={barW}
              height={h}
              rx={Math.min(2, barW / 2)}
            />
          );
        })}
        {live === null ? null : (
          <rect
            className="brush"
            x={PAD.left + Math.min(live.a, live.b) * slot}
            y={PAD.top}
            width={(Math.abs(live.b - live.a) + 1) * slot}
            height={PLOT_H}
          />
        )}
        {hover === null ? null : (
          <line
            className="hover-line"
            x1={PAD.left + hover * slot + slot / 2}
            x2={PAD.left + hover * slot + slot / 2}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
          />
        )}
        <g
          tabIndex={0}
          role="slider"
          aria-label="Select a time window"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, n - 1)}
          aria-valuenow={keyboard?.b ?? n - 1}
          aria-valuetext={
            hovered === null || hovered === undefined
              ? 'Use the arrow keys to move, Shift to extend, Enter to apply, Escape to clear'
              : `${bucketTitle(hovered.t, report.bucket, report.tz)}: ${formatCount(hovered.clicks)} clicks`
          }
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_W}
            height={PLOT_H}
            fill="transparent"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const i = indexAt(event);
              setDrag({ a: i, b: i });
            }}
            onPointerMove={(event) => {
              const i = indexAt(event);
              setHover(i);
              if (drag !== null) setDrag({ a: drag.a, b: i });
            }}
            onPointerUp={() => {
              commit(drag);
              setDrag(null);
            }}
            onPointerLeave={() => {
              if (drag === null) setHover(null);
            }}
          />
        </g>
      </svg>
      {hovered === null || hovered === undefined ? null : (
        <div
          className="tooltip"
          style={{
            left: `clamp(0px, calc(${String(((PAD.left + (hover ?? 0) * slot + slot / 2) / W) * 100)}% - 60px), calc(100% - 140px))`,
          }}
        >
          {bucketTitle(hovered.t, report.bucket, report.tz)}
          <strong>{formatCount(hovered.clicks)}</strong>
          clicks
        </div>
      )}
      <p className="timeline-hint">
        Drag across the bars to look at one window. Everything below follows it.
      </p>
      <details className="data-table">
        <summary>Show the numbers as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{report.bucket === 'hour' ? 'Hour' : 'Day'}</th>
              <th scope="col" className="num">
                Clicks
              </th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={point.t}>
                <td>{bucketTitle(point.t, report.bucket, report.tz)}</td>
                <td className="num">{formatCount(point.clicks)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

interface Shown {
  readonly key: string;
  readonly label: string;
  readonly clicks: number;
}

/** The top rows of a dimension, with everything after them folded into "Other (n more)". */
function topRows(report: Analytics, dimension: Dimension): { shown: Shown[]; total: number } {
  const rows = report.breakdowns[dimension];
  const total = report.totals.clicks + (rows.some((r) => r.key === 'bot') ? report.totals.bots : 0);
  const top = rows.slice(0, TOP_ROWS);
  const rest = rows.slice(TOP_ROWS);
  const other = rest.reduce((sum, r) => sum + r.clicks, 0);
  const shown = top.map((r) => ({ key: r.key, label: dimensionLabel(dimension, r.key), clicks: r.clicks }));
  if (other > 0) shown.push({ key: '__other', label: `Other (${String(rest.length)} more)`, clicks: other });
  return { shown, total };
}

function Breakdown({
  dimension,
  report,
}: {
  readonly dimension: Dimension;
  readonly report: Analytics;
}) {
  const { shown, total } = topRows(report, dimension);
  // Bars share one scale across the list: the largest row fills the track.
  const max = Math.max(1, ...shown.map((r) => r.clicks));
  const titleId = `breakdown-${dimension}`;

  return (
    <section className="breakdown" aria-labelledby={titleId} data-dimension={dimension}>
      <h3 id={titleId} className="breakdown-title">
        {DIMENSION_TITLES[dimension]}
      </h3>
      {shown.length === 0 ? (
        <p className="breakdown-empty">No clicks in this window.</p>
      ) : (
        <BreakdownList rows={shown} total={total} max={max} />
      )}
    </section>
  );
}

function BreakdownList({
  rows,
  total,
  max,
}: {
  readonly rows: readonly Shown[];
  readonly total: number;
  readonly max: number;
}) {
  return (
    <ul className="breakdown-list">
      {rows.map((row) => (
        <li
          key={row.key}
          className="breakdown-row"
          title={`${row.label}: ${formatCount(row.clicks)} clicks, ${formatPercent(row.clicks, total)}`}
        >
          <span className="breakdown-label">{row.label}</span>
          <span className="breakdown-value">
            {formatCount(row.clicks)}
            <span>{formatPercent(row.clicks, total)}</span>
          </span>
          <span className="breakdown-track" aria-hidden="true">
            <span
              className="breakdown-fill"
              style={{ width: `${String((row.clicks / max) * 100)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The signature: where the link travelled. Referrers fly in on the left,
 * countries fly out on the right, the short link is the hub, and each leg is
 * weighted by its share of its own side (lib/route.ts says why the two sides
 * are never joined to each other). The lists are real text, so the board reads
 * without the drawing; the drawing is decoration over them and is hidden from
 * assistive technology, and on a phone it is dropped for the lists' own bars.
 */
function RouteBoard({ slug, report }: { readonly slug: string; readonly report: Analytics }) {
  const inbound = topRows(report, 'referrer');
  const outbound = topRows(report, 'country');
  const board = routeBoard(inbound.shown, outbound.shown);
  const empty = inbound.shown.length === 0 && outbound.shown.length === 0;
  const side = (
    dimension: 'referrer' | 'country',
    data: { shown: Shown[]; total: number },
  ) => {
    const max = Math.max(1, ...data.shown.map((r) => r.clicks));
    return (
      <section
        className="route-side"
        data-side={dimension === 'referrer' ? 'in' : 'out'}
        data-dimension={dimension}
        aria-labelledby={`breakdown-${dimension}`}
      >
        <h3 id={`breakdown-${dimension}`} className="breakdown-title">
          {dimension === 'referrer' ? 'Came from' : 'Landed in'}
        </h3>
        {data.shown.length === 0 ? (
          <p className="breakdown-empty">No clicks in this window.</p>
        ) : (
          <BreakdownList rows={data.shown} total={data.total} max={max} />
        )}
      </section>
    );
  };

  return (
    <section className="panel route-board" aria-labelledby="routes-title" style={{ gridColumn: '1 / -1' }}>
      <div className="panel-head">
        <h2 id="routes-title" className="panel-title">
          Where it travelled
        </h2>
        <span className="panel-note">
          Line weight is clicks. Each side adds up on its own: who sent people, and where they were.
        </span>
      </div>
      {empty ? (
        <p className="breakdown-empty">No clicks in this window.</p>
      ) : (
        <div
          className="route-grid"
          style={{ ['--board-h' as string]: `${String(board.height)}px`, ['--row-h' as string]: `${String(ROW_H)}px` }}
        >
          {side('referrer', inbound)}
          <div className="route-map" aria-hidden="true">
            <svg viewBox={`0 0 ${String(BOARD_W)} ${String(board.height)}`} preserveAspectRatio="none">
              {board.legs.map((leg) => (
                <path
                  key={`${leg.side}:${leg.key}`}
                  className="route-leg"
                  data-side={leg.side}
                  d={leg.d}
                  strokeWidth={leg.width}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            <span className="route-hub" style={{ top: board.hubY }} translate="no">
              /{slug}
            </span>
          </div>
          {side('country', outbound)}
        </div>
      )}
    </section>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STEPS = 5;

function WeekGrid({ report }: { readonly report: Analytics }) {
  const max = Math.max(0, ...report.hourOfWeek.flat());
  return (
    <section className="panel" aria-labelledby="week-title" style={{ gridColumn: '1 / -1' }}>
      <div className="panel-head">
        <h2 id="week-title" className="panel-title">
          When people click
        </h2>
        <span className="panel-note">Hour of the week, {report.tz}</span>
      </div>
      <div className="heatmap" aria-hidden="true">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="heatmap-hour">
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
        {report.hourOfWeek.map((row, d) => (
          <WeekRow key={DAYS[d]} day={DAYS[d]!} row={row} max={max} />
        ))}
      </div>
      <div className="heat-legend" aria-hidden="true">
        <span>Fewer</span>
        {Array.from({ length: STEPS + 1 }, (_, s) => (
          <span key={s} className="heat" data-step={s} />
        ))}
        <span>More (peak {formatCount(max)} clicks in one hour)</span>
      </div>
      <details className="data-table">
        <summary>Show the week as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col" className="num">
                Clicks
              </th>
              <th scope="col">Busiest hour</th>
            </tr>
          </thead>
          <tbody>
            {report.hourOfWeek.map((row, d) => {
              const peak = row.indexOf(Math.max(...row));
              const sum = row.reduce((a, b) => a + b, 0);
              return (
                <tr key={DAYS[d]}>
                  <td>{DAYS[d]}</td>
                  <td className="num">{formatCount(sum)}</td>
                  <td>
                    {sum === 0
                      ? 'None'
                      : `${String(peak).padStart(2, '0')}:00 (${formatCount(row[peak] ?? 0)})`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function WeekRow({
  day,
  row,
  max,
}: {
  readonly day: string;
  readonly row: readonly number[];
  readonly max: number;
}) {
  return (
    <>
      <span className="heatmap-day">{day}</span>
      {row.map((value, h) => (
        <span
          key={h}
          className="heat"
          data-step={heatStep(value, max, STEPS)}
          title={`${day} ${String(h).padStart(2, '0')}:00, ${formatCount(value)} clicks`}
        />
      ))}
    </>
  );
}
