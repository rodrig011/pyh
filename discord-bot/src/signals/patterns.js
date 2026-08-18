/**
 * Real chart-pattern detection over the same candles the dashboard already
 * draws — swing-point geometry checked against real thresholds, not a model
 * asked to eyeball a picture and improvise a percentage.
 *
 * The honest limit, stated up front, the same way whales.js states its own:
 * on a noisy short-timeframe tape, "not detected" is the correct answer most
 * of the time. Every detector here returns `null` when the real criteria are
 * not met — never a low-confidence guess dressed up as a reading — because a
 * pattern panel that always has something to say is exactly the decorative
 * "AI" feature this codebase has refused to build everywhere else.
 *
 * None of this feeds the trading engine. It is a second, purely descriptive
 * read for a person looking at the chart, the same relationship whales.js and
 * confluence.js already have with the model.
 */

/**
 * Swing highs and lows — a candle counts as a swing high when its high is
 * the maximum within `lookback` candles on both sides (a "fractal"), and
 * symmetrically for lows. The standard, simplest real definition of a pivot;
 * `lookback` trades noise for how far back a pivot has to be confirmed.
 */
export function findPivots(candles, { lookback = 2 } = {}) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return { highs, lows };

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const window_ = candles.slice(i - lookback, i + lookback + 1);
    const high = candles[i].high;
    const low = candles[i].low;
    if (window_.every((c) => c.high <= high)) highs.push({ index: i, time: candles[i].time, price: high });
    if (window_.every((c) => c.low >= low)) lows.push({ index: i, time: candles[i].time, price: low });
  }
  return { highs: mergeAdjacent(highs, Math.max), lows: mergeAdjacent(lows, Math.min) };
}

/**
 * A flat top or a rounded bottom passes the fractal test at more than one
 * candle in a row — the same swing counted several times, which turns "three
 * pivots" into what is really one pivot plus noise. Collapsed into a single
 * point at the most extreme candle in each run, so a shoulder-head-shoulder
 * check sees three swings, not five.
 */
function mergeAdjacent(pivots, extremeFn) {
  if (pivots.length === 0) return pivots;
  const merged = [pivots[0]];
  for (let i = 1; i < pivots.length; i += 1) {
    const prev = merged[merged.length - 1];
    const current = pivots[i];
    if (current.index - prev.index <= 2) {
      if (extremeFn(current.price, prev.price) === current.price) merged[merged.length - 1] = current;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

const say = (bias, quality, extra) => ({ bias, quality: Math.round(Math.max(0, Math.min(100, quality))), ...extra });

/**
 * Two peaks at roughly the same level with a real valley between them — the
 * most recent qualifying pair, since a live structure read cares about now,
 * not the cleanest example somewhere in the last four hours.
 */
export function detectDoubleTop(
  candles,
  { peakToleranceRatio = 0.0035, minValleyDepthRatio = 0.004, minSeparation = 3, lookback = 2 } = {},
) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const { highs, lows } = findPivots(candles, { lookback });
  if (highs.length < 2) return null;

  for (let i = highs.length - 1; i > 0; i -= 1) {
    const p2 = highs[i];
    const p1 = highs[i - 1];
    if (p2.index - p1.index < minSeparation) continue;

    const avgPeak = (p1.price + p2.price) / 2;
    const peakDiff = Math.abs(p1.price - p2.price) / avgPeak;
    if (peakDiff > peakToleranceRatio) continue;

    const between = lows.filter((low) => low.index > p1.index && low.index < p2.index);
    if (between.length === 0) continue;
    const valley = between.reduce((min, low) => (low.price < min.price ? low : min), between[0]);
    const valleyDepth = (avgPeak - valley.price) / avgPeak;
    if (valleyDepth < minValleyDepthRatio) continue;

    const peakScore = Math.max(0, 1 - peakDiff / peakToleranceRatio);
    const depthScore = Math.min(1, valleyDepth / (minValleyDepthRatio * 3));
    const lastClose = candles[candles.length - 1].close;
    const confirmed = lastClose < valley.price;

    return say('bearish', (peakScore * 0.5 + depthScore * 0.5) * 100, {
      label: 'Double Top',
      neckline: valley.price,
      peaks: [p1.price, p2.price],
      confirmed,
      note: confirmed
        ? 'Neckline broken — the pattern has already played out.'
        : 'Two peaks near the same level, waiting for a clean neckline break.',
    });
  }
  return null;
}

/** The mirror of a double top: two troughs at roughly the same level. */
export function detectDoubleBottom(
  candles,
  { troughToleranceRatio = 0.0035, minPeakHeightRatio = 0.004, minSeparation = 3, lookback = 2 } = {},
) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const { highs, lows } = findPivots(candles, { lookback });
  if (lows.length < 2) return null;

  for (let i = lows.length - 1; i > 0; i -= 1) {
    const t2 = lows[i];
    const t1 = lows[i - 1];
    if (t2.index - t1.index < minSeparation) continue;

    const avgTrough = (t1.price + t2.price) / 2;
    const troughDiff = Math.abs(t1.price - t2.price) / avgTrough;
    if (troughDiff > troughToleranceRatio) continue;

    const between = highs.filter((high) => high.index > t1.index && high.index < t2.index);
    if (between.length === 0) continue;
    const peak = between.reduce((max, high) => (high.price > max.price ? high : max), between[0]);
    const peakHeight = (peak.price - avgTrough) / avgTrough;
    if (peakHeight < minPeakHeightRatio) continue;

    const troughScore = Math.max(0, 1 - troughDiff / troughToleranceRatio);
    const heightScore = Math.min(1, peakHeight / (minPeakHeightRatio * 3));
    const lastClose = candles[candles.length - 1].close;
    const confirmed = lastClose > peak.price;

    return say('bullish', (troughScore * 0.5 + heightScore * 0.5) * 100, {
      label: 'Double Bottom',
      neckline: peak.price,
      troughs: [t1.price, t2.price],
      confirmed,
      note: confirmed
        ? 'Neckline broken — the pattern has already played out.'
        : 'Two troughs near the same level, waiting for a clean neckline break.',
    });
  }
  return null;
}

/** Head above two roughly-equal shoulders. */
export function detectHeadAndShoulders(
  candles,
  { shoulderToleranceRatio = 0.006, minHeadProminenceRatio = 0.004, minSeparation = 3, lookback = 2 } = {},
) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const { highs, lows } = findPivots(candles, { lookback });
  if (highs.length < 3) return null;

  for (let i = highs.length - 1; i >= 2; i -= 1) {
    const h3 = highs[i];
    const h2 = highs[i - 1];
    const h1 = highs[i - 2];
    if (h2.index - h1.index < minSeparation || h3.index - h2.index < minSeparation) continue;
    if (h2.price <= h1.price || h2.price <= h3.price) continue;

    const avgShoulder = (h1.price + h3.price) / 2;
    const shoulderDiff = Math.abs(h1.price - h3.price) / avgShoulder;
    if (shoulderDiff > shoulderToleranceRatio) continue;

    const headProminence = (h2.price - avgShoulder) / avgShoulder;
    if (headProminence < minHeadProminenceRatio) continue;

    const valley1 = lows.filter((low) => low.index > h1.index && low.index < h2.index).sort((a, b) => a.price - b.price)[0];
    const valley2 = lows.filter((low) => low.index > h2.index && low.index < h3.index).sort((a, b) => a.price - b.price)[0];
    if (!valley1 || !valley2) continue;
    const neckline = (valley1.price + valley2.price) / 2;

    const shoulderScore = Math.max(0, 1 - shoulderDiff / shoulderToleranceRatio);
    const headScore = Math.min(1, headProminence / (minHeadProminenceRatio * 3));
    const lastClose = candles[candles.length - 1].close;
    const confirmed = lastClose < neckline;

    return say('bearish', (shoulderScore * 0.5 + headScore * 0.5) * 100, {
      label: 'Head & Shoulders',
      neckline,
      shoulders: [h1.price, h3.price],
      head: h2.price,
      confirmed,
      note: confirmed ? 'Neckline broken — the pattern has already played out.' : 'Head above two roughly-equal shoulders, waiting on the neckline.',
    });
  }
  return null;
}

/** The mirror: a trough below two roughly-equal shoulders. */
export function detectInverseHeadAndShoulders(
  candles,
  { shoulderToleranceRatio = 0.006, minHeadProminenceRatio = 0.004, minSeparation = 3, lookback = 2 } = {},
) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const { highs, lows } = findPivots(candles, { lookback });
  if (lows.length < 3) return null;

  for (let i = lows.length - 1; i >= 2; i -= 1) {
    const h3 = lows[i];
    const h2 = lows[i - 1];
    const h1 = lows[i - 2];
    if (h2.index - h1.index < minSeparation || h3.index - h2.index < minSeparation) continue;
    if (h2.price >= h1.price || h2.price >= h3.price) continue;

    const avgShoulder = (h1.price + h3.price) / 2;
    const shoulderDiff = Math.abs(h1.price - h3.price) / avgShoulder;
    if (shoulderDiff > shoulderToleranceRatio) continue;

    const headProminence = (avgShoulder - h2.price) / avgShoulder;
    if (headProminence < minHeadProminenceRatio) continue;

    const peak1 = highs.filter((h) => h.index > h1.index && h.index < h2.index).sort((a, b) => b.price - a.price)[0];
    const peak2 = highs.filter((h) => h.index > h2.index && h.index < h3.index).sort((a, b) => b.price - a.price)[0];
    if (!peak1 || !peak2) continue;
    const neckline = (peak1.price + peak2.price) / 2;

    const shoulderScore = Math.max(0, 1 - shoulderDiff / shoulderToleranceRatio);
    const headScore = Math.min(1, headProminence / (minHeadProminenceRatio * 3));
    const lastClose = candles[candles.length - 1].close;
    const confirmed = lastClose > neckline;

    return say('bullish', (shoulderScore * 0.5 + headScore * 0.5) * 100, {
      label: 'Inverse Head & Shoulders',
      neckline,
      shoulders: [h1.price, h3.price],
      head: h2.price,
      confirmed,
      note: confirmed ? 'Neckline broken — the pattern has already played out.' : 'Trough below two roughly-equal shoulders, waiting on the neckline.',
    });
  }
  return null;
}

/**
 * A rounded decline-and-recovery (the cup) followed by a shallower pullback
 * (the handle). Split the lookback window into thirds — left rim, bottom,
 * right rim — the simplest real check for "rounded", not a straight V, is
 * that the low sits away from both edges of the middle third rather than
 * immediately at either one.
 */
export function detectCupAndHandle(
  candles,
  { rimToleranceRatio = 0.006, minCupDepthRatio = 0.006, maxHandleDepthRatio = 0.55, handleCandles = 8 } = {},
) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const cupWindow = candles.slice(0, candles.length - handleCandles);
  const handle = candles.slice(candles.length - handleCandles);
  if (cupWindow.length < 24 || handle.length < 3) return null;

  const third = Math.floor(cupWindow.length / 3);
  const left = cupWindow.slice(0, third);
  const middle = cupWindow.slice(third, cupWindow.length - third);
  const right = cupWindow.slice(cupWindow.length - third);
  if (left.length < 4 || middle.length < 4 || right.length < 4) return null;

  const leftRim = Math.max(...left.map((c) => c.high));
  const rightRim = Math.max(...right.map((c) => c.high));
  const rimAvg = (leftRim + rightRim) / 2;
  const rimDiff = Math.abs(leftRim - rightRim) / rimAvg;
  if (rimDiff > rimToleranceRatio) return null;

  let bottomIndex = 0;
  let bottomPrice = middle[0].low;
  middle.forEach((c, i) => {
    if (c.low < bottomPrice) { bottomPrice = c.low; bottomIndex = i; }
  });
  const cupDepth = (rimAvg - bottomPrice) / rimAvg;
  if (cupDepth < minCupDepthRatio) return null;

  // "Rounded" rather than a V: the bottom is not glued to either edge of the
  // middle third.
  const edgeGuard = Math.max(1, Math.floor(middle.length * 0.15));
  if (bottomIndex < edgeGuard || bottomIndex > middle.length - 1 - edgeGuard) return null;

  const handleHigh = Math.max(...handle.map((c) => c.high));
  const handleLow = Math.min(...handle.map((c) => c.low));
  const handleDepth = (handleHigh - handleLow) / rimAvg;
  if (handleDepth > cupDepth * maxHandleDepthRatio) return null; // handle deeper than a shallow pullback -- not a handle

  const rimScore = Math.max(0, 1 - rimDiff / rimToleranceRatio);
  const depthScore = Math.min(1, cupDepth / (minCupDepthRatio * 3));
  const handleScore = Math.max(0, 1 - handleDepth / (cupDepth * maxHandleDepthRatio || 1));
  const quality = (rimScore * 0.4 + depthScore * 0.35 + handleScore * 0.25) * 100;

  const lastClose = candles[candles.length - 1].close;
  const confirmed = lastClose > rimAvg;

  return say('bullish', quality, {
    label: 'Cup & Handle',
    rim: rimAvg,
    cupLow: bottomPrice,
    confirmed,
    note: confirmed ? 'Broke back above the rim — the pattern has already played out.' : 'Rounded recovery back to the rim, with a shallow pullback since. Waiting on a break above the rim.',
  });
}

/** The mirror: a rounded rally-and-decline back to the starting level. */
export function detectReverseCupAndHandle(
  candles,
  { rimToleranceRatio = 0.006, minCupHeightRatio = 0.006, maxHandleDepthRatio = 0.55, handleCandles = 8 } = {},
) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const cupWindow = candles.slice(0, candles.length - handleCandles);
  const handle = candles.slice(candles.length - handleCandles);
  if (cupWindow.length < 24 || handle.length < 3) return null;

  const third = Math.floor(cupWindow.length / 3);
  const left = cupWindow.slice(0, third);
  const middle = cupWindow.slice(third, cupWindow.length - third);
  const right = cupWindow.slice(cupWindow.length - third);
  if (left.length < 4 || middle.length < 4 || right.length < 4) return null;

  const leftRim = Math.min(...left.map((c) => c.low));
  const rightRim = Math.min(...right.map((c) => c.low));
  const rimAvg = (leftRim + rightRim) / 2;
  const rimDiff = Math.abs(leftRim - rightRim) / rimAvg;
  if (rimDiff > rimToleranceRatio) return null;

  let topIndex = 0;
  let topPrice = middle[0].high;
  middle.forEach((c, i) => {
    if (c.high > topPrice) { topPrice = c.high; topIndex = i; }
  });
  const cupHeight = (topPrice - rimAvg) / rimAvg;
  if (cupHeight < minCupHeightRatio) return null;

  const edgeGuard = Math.max(1, Math.floor(middle.length * 0.15));
  if (topIndex < edgeGuard || topIndex > middle.length - 1 - edgeGuard) return null;

  const handleHigh = Math.max(...handle.map((c) => c.high));
  const handleLow = Math.min(...handle.map((c) => c.low));
  const handleDepth = (handleHigh - handleLow) / rimAvg;
  if (handleDepth > cupHeight * maxHandleDepthRatio) return null;

  const rimScore = Math.max(0, 1 - rimDiff / rimToleranceRatio);
  const heightScore = Math.min(1, cupHeight / (minCupHeightRatio * 3));
  const handleScore = Math.max(0, 1 - handleDepth / (cupHeight * maxHandleDepthRatio || 1));
  const quality = (rimScore * 0.4 + heightScore * 0.35 + handleScore * 0.25) * 100;

  const lastClose = candles[candles.length - 1].close;
  const confirmed = lastClose < rimAvg;

  return say('bearish', quality, {
    label: 'Reverse Cup & Handle',
    rim: rimAvg,
    cupHigh: topPrice,
    confirmed,
    note: confirmed ? 'Broke back below the rim — the pattern has already played out.' : 'Rounded decline back to the rim, with a shallow bounce since. Waiting on a break below the rim.',
  });
}

/**
 * A sharp decline (the pole) followed by tight, controlled consolidation
 * (the flag) that has not given back much of the drop. Continuation, not
 * reversal — this is a bearish read on a downtrend still in progress.
 */
export function detectBearFlag(
  candles,
  { minPoleDropRatio = 0.006, poleCandles = 10, flagCandles = 10, maxFlagRangeRatio = 0.45 } = {},
) {
  if (!Array.isArray(candles) || candles.length < poleCandles + flagCandles) return null;
  const flag = candles.slice(candles.length - flagCandles);
  const pole = candles.slice(candles.length - flagCandles - poleCandles, candles.length - flagCandles);
  if (pole.length < poleCandles || flag.length < flagCandles) return null;

  const poleStart = pole[0].high;
  const poleEnd = Math.min(...pole.map((c) => c.low));
  const poleDrop = (poleStart - poleEnd) / poleStart;
  if (poleDrop < minPoleDropRatio) return null;

  const flagHigh = Math.max(...flag.map((c) => c.high));
  const flagLow = Math.min(...flag.map((c) => c.low));
  const flagRange = (flagHigh - flagLow) / poleStart;
  // The flag has to be tight relative to the move that made it, or it is not
  // a pause, it is just more of the same volatility.
  if (flagRange > poleDrop * maxFlagRangeRatio) return null;

  // The flag must not have already retraced most of the pole -- that would
  // be a reversal, not a pause.
  const retraced = (flagHigh - poleEnd) / (poleStart - poleEnd);
  if (retraced > 0.55) return null;

  const tightnessScore = Math.max(0, 1 - flagRange / (poleDrop * maxFlagRangeRatio));
  const poleScore = Math.min(1, poleDrop / (minPoleDropRatio * 3));
  const retraceScore = Math.max(0, 1 - retraced / 0.55);
  const quality = (tightnessScore * 0.4 + poleScore * 0.3 + retraceScore * 0.3) * 100;

  const lastClose = candles[candles.length - 1].close;
  const confirmed = lastClose < flagLow;

  return say('bearish', quality, {
    label: 'Bear Flag',
    poleTop: poleStart,
    poleBottom: poleEnd,
    flagHigh,
    flagLow,
    confirmed,
    note: confirmed ? 'Broke below the flag — continuation triggered.' : 'Sharp drop, tight pause since. Waiting on a break below the flag.',
  });
}

/**
 * Every detector, in one call — what the dashboard's Pattern Sonar panel
 * reads from. Each entry is either a real, threshold-passing detection or
 * null; nothing here is ever a guess presented as a reading.
 */
export function scanPatterns(candles) {
  return {
    doubleTop: detectDoubleTop(candles),
    doubleBottom: detectDoubleBottom(candles),
    headAndShoulders: detectHeadAndShoulders(candles),
    inverseHeadAndShoulders: detectInverseHeadAndShoulders(candles),
    cupAndHandle: detectCupAndHandle(candles),
    reverseCupAndHandle: detectReverseCupAndHandle(candles),
    bearFlag: detectBearFlag(candles),
  };
}
