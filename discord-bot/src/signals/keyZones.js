/**
 * Where the signals this codebase already computes independently happen to
 * land on the same price — not a new read, just noticing when the ones
 * that exist agree with each other.
 *
 * Only support/resistance (swing-pivot clustering) and fair value gaps
 * (candle-body imbalance) are combined here, because those are the only two
 * genuinely independent mechanisms in this file's family. A pattern's
 * neckline is tempting to add too, but every detector in patterns.js builds
 * its neckline from the exact same swing pivots findSupportResistance
 * already clusters — so "the neckline matches the support level" is not two
 * signals agreeing, it is one signal agreeing with itself under a second
 * name. Reporting that as confluence would be exactly the kind of
 * manufactured confidence this whole file's family exists to refuse.
 */

/**
 * Clusters support/resistance levels and open fair value gap edges, and
 * returns only the clusters where both a level AND a gap edge land within
 * `tolerancePct` of each other.
 */
export function findKeyZones({ levels = [], fairValueGaps = [] } = {}, { tolerancePct = 0.0015 } = {}) {
  const points = [
    ...(levels ?? []).map((level) => ({ price: level.price, source: level.type })),
    ...(fairValueGaps ?? []).flatMap((gap) => [
      { price: gap.high, source: gap.bias + ' fvg' },
      { price: gap.low, source: gap.bias + ' fvg' },
    ]),
  ].filter((point) => Number.isFinite(point.price) && point.price > 0);

  if (points.length < 2) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const point of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && (point.price - last.max) / last.max <= tolerancePct) {
      last.points.push(point);
      last.max = Math.max(last.max, point.price);
    } else {
      clusters.push({ points: [point], max: point.price });
    }
  }

  const isLevel = (source) => source === 'support' || source === 'resistance';
  const isGap = (source) => source.endsWith(' fvg');

  return clusters
    .filter((cluster) => {
      const sources = cluster.points.map((p) => p.source);
      return sources.some(isLevel) && sources.some(isGap);
    })
    .map((cluster) => ({
      price: Number((cluster.points.reduce((sum, p) => sum + p.price, 0) / cluster.points.length).toFixed(2)),
      sources: [...new Set(cluster.points.map((p) => p.source))],
    }));
}

/** Whether `price` falls inside an already-found key zone, for a caller deciding how to draw an existing line. */
export function matchingZone(zones, price, { tolerancePct = 0.0015 } = {}) {
  if (!Number.isFinite(price)) return null;
  return (zones ?? []).find((zone) => Math.abs(zone.price - price) / price <= tolerancePct) ?? null;
}
