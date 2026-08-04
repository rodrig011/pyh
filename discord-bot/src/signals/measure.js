/**
 * The answer to "what daily growth will we have", computed rather than assumed.
 *
 * Two scores, from the same recorded observations:
 *
 *   - The MARKET's. Kalshi's mid, scored against what happened.
 *   - The MODEL's. Our probability, scored on exactly the same rows.
 *
 * Whichever is lower is the better forecaster. If the market wins, there is no
 * business here and no amount of engineering changes that. If the model wins,
 * the size of the gap is the edge, in cents, and the daily growth follows from
 * it by arithmetic rather than by hope.
 *
 * The reason this file matters more than the whole rest of the engine: every
 * other number produced so far is conditional on an edge existing. This one
 * measures whether it does.
 */

/**
 * Brier score: mean squared error of a probability against a 0/1 outcome.
 *
 * Lower is better. 0.25 is what you get by always saying 50%, so a forecaster
 * above 0.25 is worse than a coin and the honest response is to stop.
 */
export function brier(pairs) {
  const rows = (pairs ?? []).filter(
    (row) => Number.isFinite(row?.probability) && (row.outcome === 0 || row.outcome === 1),
  );
  if (rows.length === 0) return null;
  return rows.reduce((total, row) => total + (row.probability - row.outcome) ** 2, 0) / rows.length;
}

/**
 * How well a forecaster's stated probabilities match reality, bucketed.
 *
 * A Brier score can be good for the wrong reason. Calibration is the check
 * that cannot be faked: of everything called 70%, about 70% must happen. A
 * model that is confident and wrong shows up here and nowhere else.
 */
export function calibrationBuckets(pairs, { buckets = 10 } = {}) {
  const out = Array.from({ length: buckets }, (_, i) => ({
    from: i / buckets,
    to: (i + 1) / buckets,
    n: 0,
    predicted: 0,
    actual: 0,
  }));

  for (const row of pairs ?? []) {
    if (!Number.isFinite(row?.probability)) continue;
    if (row.outcome !== 0 && row.outcome !== 1) continue;
    const index = Math.min(buckets - 1, Math.floor(row.probability * buckets));
    out[index].n += 1;
    out[index].predicted += row.probability;
    out[index].actual += row.outcome;
  }

  return out
    .filter((bucket) => bucket.n > 0)
    .map((bucket) => ({
      ...bucket,
      predicted: bucket.predicted / bucket.n,
      actual: bucket.actual / bucket.n,
    }));
}

/**
 * The market's own mispricing, in cents, with the error bar it deserves.
 *
 * `mean` is the systematic part — the market being consistently high or low,
 * which is the kind of edge a strategy can live on. `meanAbsolute` is how far
 * it wanders in either direction, which is noise unless something predicts the
 * direction.
 *
 * The standard error is the whole point. A mean mispricing of 2¢ from forty
 * observations is nothing; the same 2¢ from four thousand is a business.
 */
export function mispricing(observations) {
  const rows = (observations ?? []).filter(
    (row) => (row?.outcome === 0 || row?.outcome === 1) && Number.isFinite(row?.bid) && Number.isFinite(row?.ask),
  );
  if (rows.length < 2) return null;

  // The market said (mid) and the truth was 100 or 0. The difference is what
  // the market got wrong on that observation.
  const errors = rows.map((row) => (row.bid + row.ask) / 2 - row.outcome * 100);
  const mean = errors.reduce((t, x) => t + x, 0) / errors.length;
  const variance = errors.reduce((t, x) => t + (x - mean) ** 2, 0) / (errors.length - 1);
  const standardError = Math.sqrt(variance / errors.length);

  return {
    n: errors.length,
    meanCents: mean,
    meanAbsoluteCents: errors.reduce((t, x) => t + Math.abs(x), 0) / errors.length,
    standardErrorCents: standardError,
    // Two standard errors either side. If this straddles zero, the market is
    // not measurably biased and the honest headline is "no evidence".
    ci95: [mean - 2 * standardError, mean + 2 * standardError],
    significant: Math.abs(mean) > 2 * standardError,
  };
}

/**
 * Everything, from a recorded log. The one function worth calling.
 */
export function measureEdge(observations, { spreadAware = true } = {}) {
  const settled = (observations ?? []).filter((row) => row?.outcome === 0 || row?.outcome === 1);
  if (settled.length === 0) {
    return { ready: false, reason: 'nothing has settled yet', settled: 0 };
  }

  const marketPairs = settled.map((row) => ({
    probability: (row.bid + row.ask) / 200,
    outcome: row.outcome,
  }));
  const modelPairs = settled
    .filter((row) => Number.isFinite(row.model))
    .map((row) => ({ probability: row.model, outcome: row.outcome }));

  const marketBrier = brier(marketPairs);
  const modelBrier = brier(modelPairs);

  // What the model would have made per contract, taking only what it liked and
  // paying the ask to get it. Not a backtest — no sizing, no exits — but it is
  // computed from prices that really existed, which is more than any
  // simulation in this repository can say.
  let takenCount = 0;
  let takenCents = 0;
  for (const row of settled) {
    if (!Number.isFinite(row.model)) continue;
    const upCost = spreadAware ? row.ask : (row.bid + row.ask) / 2;
    const downCost = 100 - (spreadAware ? row.bid : (row.bid + row.ask) / 2);

    const upEdge = row.model * 100 - upCost;
    const downEdge = (1 - row.model) * 100 - downCost;

    if (upEdge >= downEdge && upEdge > 0) {
      takenCount += 1;
      takenCents += row.outcome * 100 - upCost;
    } else if (downEdge > 0) {
      takenCount += 1;
      takenCents += (1 - row.outcome) * 100 - downCost;
    }
  }

  return {
    ready: true,
    settled: settled.length,
    scored: modelPairs.length,
    marketBrier,
    modelBrier,
    // The only comparison that decides whether any of this is a business.
    modelBeatsMarket:
      marketBrier !== null && modelBrier !== null ? modelBrier < marketBrier : null,
    brierGap: marketBrier !== null && modelBrier !== null ? marketBrier - modelBrier : null,
    mispricing: mispricing(settled),
    calibration: calibrationBuckets(modelPairs),
    marketCalibration: calibrationBuckets(marketPairs),
    taken: takenCount,
    // Gross cents per contract taken, before fees. The fee is roughly 2¢ at mid
    // prices, so anything under that is a loss wearing a nice hat.
    centsPerTrade: takenCount > 0 ? takenCents / takenCount : null,
  };
}

/**
 * Turns a measured per-trade edge into the number actually being asked about.
 *
 * Growth compounds per trade, so the daily figure depends on how many trades a
 * day there are — which is why scanning more markets is the only lever here
 * that is not capped by the maths.
 */
export function dailyGrowth({ centsPerTrade, entryCents = 50, tradesPerDay, feeCents = 2 }) {
  if (!Number.isFinite(centsPerTrade) || !(entryCents > 0) || !(tradesPerDay > 0)) return null;

  const netPerTrade = centsPerTrade - feeCents;
  const returnPerTrade = netPerTrade / entryCents;

  return {
    netCentsPerTrade: netPerTrade,
    returnPerTrade,
    // Compounded, but only over the fraction of the bankroll actually staked —
    // betting everything on each trade is how a positive edge still ends at
    // zero.
    dailyPercent: (Math.pow(1 + returnPerTrade * 0.05, tradesPerDay) - 1) * 100,
    assumesStakeFraction: 0.05,
  };
}
