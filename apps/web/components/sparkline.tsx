import { formatCount } from '../lib/format';
import { sparkPath } from '../lib/spark';

const WIDTH = 120;
const HEIGHT = 28;

/**
 * 24 hourly buckets as a line. `role="img"` with the total in words, so the
 * row says "312 clicks in the last 24 hours" to a screen reader instead of
 * nothing; the exact count is also in the next column.
 */
export function Sparkline({ values }: { readonly values: readonly number[] }) {
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      role="img"
      aria-label={`${formatCount(total)} clicks in the last 24 hours`}
    >
      <line className="spark-base" x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
      <path d={sparkPath(values, WIDTH, HEIGHT)} />
    </svg>
  );
}
