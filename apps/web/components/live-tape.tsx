'use client';

import { useEffect, useState } from 'react';

import { liveClickSchema, type LiveClick } from '@links/shared';

import { clock, countryName, dimensionLabel } from '../lib/format';

const KEEP = 50;

type State = 'connecting' | 'live' | 'offline';

const STATE_TEXT: Record<State, { glyph: string; word: string }> = {
  connecting: { glyph: '○', word: 'Connecting' },
  live: { glyph: '●', word: 'Live' },
  offline: { glyph: '◌', word: 'Reconnecting' },
};

/**
 * Clicks as they arrive, newest first: "14:37:12 · United Kingdom / Mobile ·
 * Mobile Safari · from t.co". EventSource reconnects on its own after a drop;
 * the state is shown as a glyph and a word, and new rows are announced politely
 * (one at a time, not the whole list).
 */
export function LiveTape({
  linkId,
  timeZone,
}: {
  readonly linkId: string;
  readonly timeZone: string;
}) {
  const [clicks, setClicks] = useState<LiveClick[]>([]);
  const [state, setState] = useState<State>('connecting');

  useEffect(() => {
    const source = new EventSource(`/api/links/${linkId}/live`);
    source.onopen = () => setState('live');
    source.onerror = () => setState('offline');
    source.addEventListener('click', (event) => {
      const parsed = liveClickSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (!parsed.success) return;
      setClicks((current) =>
        [parsed.data, ...current.filter((c) => c.id !== parsed.data.id)].slice(0, KEEP),
      );
    });
    return () => source.close();
  }, [linkId]);

  const display = STATE_TEXT[state];
  const latest = clicks[0];

  return (
    <aside className="tape" aria-labelledby="tape-title">
      <div className="tape-head">
        <h2 id="tape-title" className="panel-title">
          Arriving now
        </h2>
        <span className="tape-state" data-state={state} data-testid="tape-state">
          <span aria-hidden="true">{display.glyph}</span>
          {display.word}
        </span>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {latest === undefined
          ? ''
          : `New click from ${countryName(latest.country)}, ${latest.device}`}
      </p>
      {clicks.length === 0 ? (
        <p className="tape-empty">
          Open the short link in another tab and the click lands here within a second or two.
        </p>
      ) : (
        <ol className="tape-list" data-testid="tape">
          {clicks.map((c) => (
            <li key={c.id} className="tape-item">
              <time className="tape-time" dateTime={c.at}>
                {clock(c.at, timeZone)}
              </time>
              <span className="tape-where">
                {countryName(c.country)} · {dimensionLabel('device', c.device)}
              </span>
              <span className="tape-how">
                {[
                  c.browser || 'Unknown browser',
                  c.os,
                  c.referrer === '' ? 'direct' : `from ${c.referrer}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
