/**
 * Support/resistance and fair-value-gap detection over the same candles
 * patterns.js reads — real levels built from where price has actually
 * turned, not a picture guess. Same rule as everywhere else in this file's
 * family: a level with nothing behind it does not get invented, it just
 * does not appear.
 */

import { findPivots } from './patterns.js';

/**
 * Clusters swing pivots into horizontal levels and scores each one from two
 * real, measured things: how many times price has actually come back to
 * test it (`touches`), and how tightly those tests cluster around the same
 * price (`quality`). A level with one clean touch still shows up — it is
 * just scored lower than one with a five-touch history.
 */
export function findSupportResistance(candles, { lookback = 2, tolerancePct = 0.0015, maxPerSide = 2 } = {}) {
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return [];
  const { highs, lows } = findPivots(candles, { lookback });
  const currentPrice = candles[candles.length - 1].close;
  const byDistance = (a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);

  // Nearest levels on EACH side, picked separately -- a handful of minor,
  // closely-spaced supports must not crowd out the one resistance overhead
  // just because they happen to sit nearer to the current price.
  const resistances = clusterLevels(highs.map((p) => p.price), 'resistance', tolerancePct)
    .filter((level) => level.touches >= 1)
    .sort(byDistance)
    .slice(0, maxPerSide);
  const supports = clusterLevels(lows.map((p) => p.price), 'support', tolerancePct)
    .filter((level) => level.touches >= 1)
    .sort(byDistance)
    .slice(0, maxPerSide);

  return [...resistances, ...supports];
}

function clusterLevels(prices, type, tolerancePct) {
  if (prices.length === 0) return [];
  const sorted = [...prices].sort((a, b) => a - b);
  const clusters = [];
  for (const price of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && (price - last.max) / last.max <= tolerancePct) {
      last.members.push(price);
      last.max = Math.max(last.max, price);
      last.min = Math.min(last.min, price);
    } else {
      clusters.push({ members: [price], min: price, max: price });
    }
  }

  return clusters.map((cluster) => {
    const level = cluster.members.reduce((a, b) => a + b, 0) / cluster.members.length;
    // Touches count real swing pivots merged into this level, not raw
    // candles — a flat, directionless stretch has every candle sitting near
    // the same price without ever actually testing it as a level.
    const touches = cluster.members.length;
    const touchScore = Math.min(1, touches / 5);
    const spread = cluster.max - cluster.min;
    const tightnessScore = Math.max(0, Math.min(1, 1 - spread / (level * tolerancePct)));
    const quality = Math.round((touchScore * 0.6 + tightnessScore * 0.4) * 100);
    return { type, price: Number(level.toFixed(2)), touches, quality };
  });
}

/**
 * Classic three-candle fair value gap: candle[i-2] and candle[i] leave a
 * price zone candle[i-1] never traded back through. Only gaps price has not
 * yet filled are returned — the moment a later candle trades back into one,
 * it is no longer a real open zone, so it drops off the list.
 */
export function findFairValueGaps(candles, { minGapRatio = 0.001, maxGaps = 2 } = {}) {
  if (!Array.isArray(candles) || candles.length < 5) return [];
  const gaps = [];

  for (let i = 2; i < candles.length; i += 1) {
    const left = candles[i - 2];
    const right = candles[i];
    if (left.high < right.low) {
      const size = (right.low - left.high) / left.high;
      if (size >= minGapRatio) gaps.push({ bias: 'bullish', low: left.high, high: right.low, index: i, time: right.time });
    } else if (left.low > right.high) {
      const size = (left.low - right.high) / right.high;
      if (size >= minGapRatio) gaps.push({ bias: 'bearish', low: right.high, high: left.low, index: i, time: right.time });
    }
  }

  const open = gaps.filter((gap) => {
    for (let j = gap.index + 1; j < candles.length; j += 1) {
      const c = candles[j];
      if (gap.bias === 'bullish' && c.low <= gap.high) return false;
      if (gap.bias === 'bearish' && c.high >= gap.low) return false;
    }
    return true;
  });

  return open.slice(-maxGaps).map((gap) => ({
    bias: gap.bias,
    low: Number(gap.low.toFixed(2)),
    high: Number(gap.high.toFixed(2)),
    time: gap.time,
  }));
}
