/**
 * Geometry for the small charts, kept out of the components so it is tested
 * as numbers rather than eyeballed as pixels.
 */

/**
 * The SVG path for a sparkline: a polyline across `width`, values scaled to
 * `height` with the minimum pinned at 0 (a sparkline that floats its baseline
 * makes 3 clicks look like 300). 1px inset so a 2px stroke is not clipped.
 */
export function sparkPath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  const inset = 1;
  const h = height - inset * 2;
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(inset + h - (v / max) * h).toFixed(1)}`,
    )
    .join(' ');
}

/** A rounded-up axis maximum that splits into 4 whole ticks: 37 -> 40, 1,234 -> 1,600. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = factor * magnitude;
    if (candidate >= value && Number.isInteger(candidate / 4)) return candidate;
  }
  return 10 * magnitude;
}

/**
 * Which of N sequential steps a value falls in (0 = none at all). Steps are
 * linear in the value: the heatmap is read for "where is it busy", and a log
 * scale would flatten the peak that question is about.
 */
export function heatStep(value: number, max: number, steps: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(steps, Math.ceil((value / max) * steps)));
}
