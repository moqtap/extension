/**
 * A track's series swatch: the design system's categorical colours
 * `chart-1` … `chart-8` in the order tracks were first seen. Past the
 * eighth, tracks share `chart-8`, the system's "Other". The track's name is
 * always written beside the swatch, so the colour never stands alone.
 */
export function trackColourClass(colorIndex: number): string {
  const series = Math.min(colorIndex, 7) + 1
  return series === 1 ? 'mq-swatch' : `mq-swatch mq-swatch--${series}`
}
