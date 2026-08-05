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
/**
 * Mean and error bar of a per-market quantity, clustered by market.
 *
 * The correction that stops this whole file from lying. A 15-minute market is
 * sampled every 30 seconds, so it contributes about thirty observations — and
 * all thirty share ONE outcome. Treating them as thirty independent facts
 * understates the error bar by the square root of thirty, about five and a
 * half times, which is the difference between "we measured a 2¢ edge" and "we
 * have no idea".
 *
 * The independent unit is the market, not the observation. So each market is
 * collapsed to its own average first, and the spread ACROSS markets is what
 * the error bar is built from.
 */
export function clusteredMean(rows, valueOf, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const value = valueOf(row);
    if (!Number.isFinite(value)) continue;
    const bucket = groups.get(key) ?? { total: 0, n: 0 };
    bucket.total += value;
    bucket.n += 1;
    groups.set(key, bucket);
  }

  const means = [...groups.values()].map((bucket) => bucket.total / bucket.n);
  if (means.length < 2) return null;

  const mean = means.reduce((t, x) => t + x, 0) / means.length;
  const variance = means.reduce((t, x) => t + (x - mean) ** 2, 0) / (means.length - 1);
  const standardError = Math.sqrt(variance / means.length);

  return {
    mean,
    standardError,
    clusters: means.length,
    observations: rows.length,
    ci95: [mean - 2 * standardError, mean + 2 * standardError],
    significant: Math.abs(mean) > 2 * standardError,
  };
}

export function mispricing(observations) {
  const rows = (observations ?? []).filter(
    (row) => (row?.outcome === 0 || row?.outcome === 1) && Number.isFinite(row?.bid) && Number.isFinite(row?.ask),
  );
  if (rows.length < 2) return null;

  // The market said (mid) and the truth was 100 or 0. The difference is what
  // the market got wrong on that observation.
  const error = (row) => (row.bid + row.ask) / 2 - row.outcome * 100;
  const clustered = clusteredMean(rows, error, (row) => row.ticker ?? 'all');
  if (!clustered) return null;

  const errors = rows.map(error);

  return {
    n: errors.length,
    markets: clustered.clusters,
    meanCents: clustered.mean,
    meanAbsoluteCents: errors.reduce((t, x) => t + Math.abs(x), 0) / errors.length,
    standardErrorCents: clustered.standardError,
    // Two standard errors either side. If this straddles zero, the market is
    // not measurably biased and the honest headline is "no evidence".
    ci95: clustered.ci95,
    significant: clustered.significant,
  };
}

/**
 * Model against market, paired on the same outcome.
 *
 * A paired comparison rather than two separate scores, because most of the
 * noise in a Brier score is the outcome itself — and both forecasters are
 * scored on the SAME outcome, so that noise cancels. This converges far faster
 * than measuring either score on its own, which is why it, rather than the
 * mispricing above, is the number to watch first.
 *
 * Positive means the model is the better forecaster.
 */
export function brierComparison(observations) {
  const rows = (observations ?? []).filter(
    (row) =>
      (row?.outcome === 0 || row?.outcome === 1) &&
      Number.isFinite(row?.model) &&
      Number.isFinite(row?.bid) &&
      Number.isFinite(row?.ask),
  );
  if (rows.length < 2) return null;

  const difference = (row) => {
    const market = (row.bid + row.ask) / 200;
    return (market - row.outcome) ** 2 - (row.model - row.outcome) ** 2;
  };

  return clusteredMean(rows, difference, (row) => row.ticker ?? 'all');
}

/**
 * Everything, from a recorded log. The one function worth calling.
 */
export function measureEdge(observations, { spreadAware = true } = {}) {
  const settled = (observations ?? []).filter((row) => row?.outcome === 0 || row?.outcome === 1);
  if (settled.length === 0) {
    return { ready: false, reason: 'nothing has settled yet', settled: 0 };
  }

  // Both scores on IDENTICAL rows, always.
  //
  // They used to be computed on different sets — the market's over every
  // settled row, the model's over only the rows it had an opinion on — and the
  // two then told opposite stories from the paired comparison beside them:
  // market 0.1558, model 0.2008, and "the model is ahead". Both were correct
  // arithmetic on different data, which is the most misleading kind of number
  // there is. A forecaster can only be compared where the other one also spoke.
  const scored = settled.filter((row) => Number.isFinite(row.model));

  const marketPairs = scored.map((row) => ({
    probability: (row.bid + row.ask) / 200,
    outcome: row.outcome,
  }));
  const modelPairs = scored.map((row) => ({ probability: row.model, outcome: row.outcome }));

  const marketBrier = brier(marketPairs);
  const modelBrier = brier(modelPairs);

  // What the market scored on everything, including where the model was
  // silent. Reported separately and never against the model's, because the
  // rows are not the same.
  const marketBrierAll = brier(
    settled.map((row) => ({ probability: (row.bid + row.ask) / 200, outcome: row.outcome })),
  );

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

  // Paired, clustered, and therefore the number to believe. The raw gap below
  // is kept for display, but it has no error bar and must never be reported
  // on its own.
  const comparison = brierComparison(settled);

  return {
    ready: true,
    settled: settled.length,
    markets: new Set(settled.map((row) => row.ticker)).size,
    scored: modelPairs.length,
    marketBrier,
    modelBrier,
    marketBrierAll,
    // The only comparison that decides whether any of this is a business, and
    // only once its interval stops crossing zero.
    comparison,
    modelBeatsMarket: comparison ? comparison.significant && comparison.mean > 0 : null,
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

/**
 * Which volatility estimator was actually right, decided by settled markets.
 *
 * Simulation cannot answer this. A simulated world's volatility reverts to
 * whatever level its author picked, which silently rewards whichever estimator
 * happens to match that choice — in this repository's own runs the plainest
 * estimator won every simulated world, and that is exactly the result a
 * mean-reverting simulator is built to produce. Real bitcoin volatility holds a
 * regime for hours without reverting to anything.
 *
 * So the recorder stores what every candidate said at the moment it said it,
 * and this scores them against what happened. Clustered by market, because
 * thirty readings of one contract share one outcome.
 */
export function rankEstimators(observations, { probabilityFrom }) {
  const settled = (observations ?? []).filter(
    (row) => (row?.outcome === 0 || row?.outcome === 1) && row?.sigmas,
  );
  if (settled.length < 2) return null;

  const names = [...new Set(settled.flatMap((row) => Object.keys(row.sigmas)))];
  const scored = [];

  for (const name of names) {
    const rows = [];
    for (const row of settled) {
      const sigma = row.sigmas?.[name];
      if (!(sigma > 0)) continue;
      const probability = probabilityFrom(row, sigma);
      if (!Number.isFinite(probability)) continue;
      rows.push({ ...row, probability });
    }
    if (rows.length < 2) continue;

    const score = brier(rows.map((row) => ({ probability: row.probability, outcome: row.outcome })));
    // Paired against the market on the same rows, clustered by market, so the
    // ranking carries an error bar rather than an ordering of noise.
    const versusMarket = clusteredMean(
      rows,
      (row) => {
        const market = (row.bid + row.ask) / 200;
        return (market - row.outcome) ** 2 - (row.probability - row.outcome) ** 2;
      },
      (row) => row.ticker ?? "all",
    );

    scored.push({ name, brier: score, n: rows.length, versusMarket });
  }

  scored.sort((a, b) => a.brier - b.brier);

  return {
    ranked: scored,
    best: scored[0] ?? null,
    // Only worth switching to if it beats the incumbent by more than the noise
    // between them — otherwise it is picking the luckiest of six coin flips.
    decisive:
      scored.length > 1 &&
      scored[0].versusMarket &&
      scored[1].versusMarket &&
      scored[0].versusMarket.mean - scored[1].versusMarket.mean >
        2 * (scored[0].versusMarket.standardError + scored[1].versusMarket.standardError),
  };
}
