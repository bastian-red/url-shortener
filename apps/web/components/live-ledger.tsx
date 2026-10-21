'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * One EventSource for the whole ledger (`/api/live`), fanned out to the rows.
 *
 * The API subscribes to the links that exist when the stream opens, so the
 * page remounts this provider (a `key` of the link ids) whenever the set
 * changes: a link created a second ago gets its clicks too.
 *
 * Each row shows its server-rendered count plus whatever arrived since, and a
 * "+N" badge for a moment after a click lands. The badge is a glyph and a
 * number, so the change is legible without colour or motion; under
 * prefers-reduced-motion it simply appears and disappears.
 */
interface LiveState {
  readonly added: Record<string, number>;
  readonly recent: Record<string, number>;
}

const LiveContext = createContext<LiveState>({ added: {}, recent: {} });

export function LiveLedger({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<LiveState>({ added: {}, recent: {} });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/live');
    source.onopen = () => setOpen(true);
    source.onerror = () => setOpen(false);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    source.addEventListener('click', (event) => {
      let click: { linkId?: unknown; bot?: unknown };
      try {
        click = JSON.parse((event as MessageEvent<string>).data) as typeof click;
      } catch {
        return;
      }
      // The column counts humans, like the server-rendered number beside it.
      if (typeof click.linkId !== 'string' || click.bot === true) return;
      const id = click.linkId;
      setState((s) => ({
        added: { ...s.added, [id]: (s.added[id] ?? 0) + 1 },
        recent: { ...s.recent, [id]: (s.recent[id] ?? 0) + 1 },
      }));
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => setState((s) => ({ ...s, recent: { ...s.recent, [id]: 0 } })), 1800),
      );
    });
    return () => {
      source.close();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  return (
    <LiveContext.Provider value={state}>
      <div data-live={open ? 'open' : 'connecting'}>{children}</div>
    </LiveContext.Provider>
  );
}

export function LiveCount({
  linkId,
  initial,
}: {
  readonly linkId: string;
  readonly initial: number;
}) {
  const { added, recent } = useContext(LiveContext);
  const total = initial + (added[linkId] ?? 0);
  const bump = recent[linkId] ?? 0;
  return (
    <span className="count" data-testid={`count-${linkId}`}>
      {bump > 0 ? (
        <span className="bump" key={`${linkId}-${String(total)}`}>
          +{bump}
        </span>
      ) : null}
      {new Intl.NumberFormat('en-US').format(total)}
    </span>
  );
}
