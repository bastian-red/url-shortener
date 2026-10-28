/**
 * Geometry for the report's route board: referrers fly in on the left, the
 * short link is the hub, countries fly out on the right, and each leg's weight
 * is its share of that side's clicks.
 *
 * **What the board must never claim.** The rollups hold one dimension at a
 * time, so there is no "slack.com visitors in Germany" number. Every leg joins
 * a row to the hub, never a referrer to a country, and each side is scaled to
 * its own total. A line from a referrer straight to a country would draw a
 * joint distribution the data does not have.
 *
 * The SVG uses one coordinate per CSS pixel vertically (rows are ROW_H tall in
 * both the HTML lists and the drawing, so a leg always ends on its row) and a
 * fixed BOARD_W horizontally, stretched with non-scaling strokes.
 */

export const ROW_H = 44;
export const BOARD_W = 240;
export const HUB_X = BOARD_W / 2;
/** Leg weight in px: the thinnest still reads as a line, the heaviest stays below a row's text height. */
export const MIN_STROKE = 1.5;
export const MAX_STROKE = 12;

export interface RouteRow {
  readonly key: string;
  readonly clicks: number;
}

export interface Leg {
  readonly key: string;
  readonly side: 'in' | 'out';
  readonly d: string;
  readonly width: number;
  /** Row centre, for tests and for placing anything else on the leg. */
  readonly y: number;
}

export interface Board {
  readonly height: number;
  readonly hubY: number;
  readonly legs: readonly Leg[];
}

/** Centre of row `i` in a side of `n` rows, the side centred in a board `height` tall. */
export function rowCentre(i: number, n: number, height: number): number {
  return (height - n * ROW_H) / 2 + i * ROW_H + ROW_H / 2;
}

/** Stroke width for a share in [0, 1]; a row with no clicks draws no leg at all. */
export function legWidth(share: number): number {
  return MIN_STROKE + (MAX_STROKE - MIN_STROKE) * Math.max(0, Math.min(1, share));
}

const fixed = (v: number) => Number(v.toFixed(2));

export function routeBoard(inbound: readonly RouteRow[], outbound: readonly RouteRow[]): Board {
  const height = Math.max(inbound.length, outbound.length, 1) * ROW_H;
  const hubY = height / 2;
  const side = (rows: readonly RouteRow[], dir: 'in' | 'out'): Leg[] => {
    // Scaled to the side's largest row, so the heaviest leg is always MAX_STROKE:
    // the two sides are compared within themselves, never against each other.
    const max = Math.max(0, ...rows.map((r) => r.clicks));
    return rows.flatMap((row, i) => {
      if (row.clicks <= 0 || max === 0) return [];
      const y = rowCentre(i, rows.length, height);
      const d =
        dir === 'in'
          ? `M0 ${String(fixed(y))} C${String(HUB_X * 0.55)} ${String(fixed(y))} ${String(HUB_X * 0.45)} ${String(hubY)} ${String(HUB_X)} ${String(hubY)}`
          : `M${String(HUB_X)} ${String(hubY)} C${String(HUB_X + HUB_X * 0.55)} ${String(hubY)} ${String(HUB_X + HUB_X * 0.45)} ${String(fixed(y))} ${String(BOARD_W)} ${String(fixed(y))}`;
      return [{ key: row.key, side: dir, d, width: fixed(legWidth(row.clicks / max)), y: fixed(y) }];
    });
  };
  return { height, hubY, legs: [...side(inbound, 'in'), ...side(outbound, 'out')] };
}
