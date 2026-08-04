/**
 * How much to put in, which is where the growth rate actually lives.
 *
 * The edge decides whether to bet. The size decides how fast the account
 * grows — and unlike the edge, it is a dial anyone can turn. The catch is that
 * it does not turn the way intuition says: growth rises with size, peaks, and
 * then falls off a cliff. Bet twice the optimal fraction with a genuine edge
 * and the long-run growth rate is exactly zero. Bet more than that and a real
 * edge takes the account to nothing.
 *
 * That is not an opinion about risk appetite. It is arithmetic, and it is the
 * single most expensive thing most traders never learn.
 */

/**
 * Kelly fraction for a binary contract.
 *
 * A contract costing p pays 1. Winning returns (1−p)/p on the stake, losing
 * returns −1. The fraction that maximises long-run growth is the edge divided
 * by the odds.
 *
 * @param {number} probability the honest chance it lands, 0..1
 * @param {number} priceDollars what the contract costs, 0..1
 */
export function kellyFraction(probability, priceDollars) {
  if (!(probability > 0) || !(probability < 1)) return null;
  if (!(priceDollars > 0) || !(priceDollars < 1)) return null;

  const odds = (1 - priceDollars) / priceDollars;
  const fraction = (probability * odds - (1 - probability)) / odds;

  // A negative Kelly is the bet saying "take the other side, or none".
  return Math.max(0, fraction);
}

/**
 * The long-run growth rate per bet at a given size.
 *
 * Logarithmic, because bankrolls compound: what matters is the average of the
 * log, not the average outcome. This is the function that shows why doubling
 * the size does not double the returns.
 */
export function growthRate(probability, priceDollars, fraction) {
  if (!(fraction >= 0) || fraction >= 1) return null;
  if (!(probability > 0) || !(probability < 1)) return null;
  if (!(priceDollars > 0) || !(priceDollars < 1)) return null;

  const odds = (1 - priceDollars) / priceDollars;
  const win = 1 + fraction * odds;
  const lose = 1 - fraction;
  if (win <= 0 || lose <= 0) return -Infinity;

  return probability * Math.log(win) + (1 - probability) * Math.log(lose);
}

/**
 * What to actually risk, and what it costs to ignore the answer.
 *
 * Full Kelly is correct only if the probability is exactly right. It never is —
 * it comes from a volatility estimate with real error — and Kelly punishes
 * overestimation far harder than underestimation. So the recommendation is a
 * fraction of Kelly, and the pessimistic end of the probability band is used
 * rather than the middle.
 *
 * @param {object} input
 * @param {number} input.probability best estimate
 * @param {number} [input.worstProbability] the pessimistic end of the band
 * @param {number} input.priceDollars
 * @param {number} [input.kellyFraction] how much of Kelly to take, 0..1
 */
export function recommendSize({
  probability,
  worstProbability = null,
  priceDollars,
  kellyFraction: portion = 0.25,
  maximumFraction = 0.1,
}) {
  // Size on what might be true, not on what is hoped. Sizing on the middle of
  // the band and being wrong by one standard error is how a real edge still
  // ends in a drawdown nobody recovers from.
  const conservative = worstProbability ?? probability;

  const full = kellyFraction(conservative, priceDollars);
  if (full === null) return null;

  const suggested = Math.min(full * portion, maximumFraction);

  return {
    fullKelly: full,
    suggested,
    // What the account grows at, per bet, at that size and at full Kelly.
    growthAtSuggested: growthRate(probability, priceDollars, suggested),
    growthAtFull: growthRate(probability, priceDollars, full),
    // The number that ends the argument about betting bigger.
    growthAtDouble: growthRate(probability, priceDollars, Math.min(0.999, full * 2)),
    // Where growth turns negative: a genuine edge, bet this size, still loses.
    ruinFraction: Math.min(0.999, full * 2),
  };
}

/**
 * The growth curve, for showing rather than asserting.
 *
 * Every row is the same edge at a different size. It rises, it peaks, and past
 * twice the peak it is negative — the same winning strategy, sized wrong,
 * turned into a losing one.
 */
export function growthCurve(probability, priceDollars, { steps = 10 } = {}) {
  const full = kellyFraction(probability, priceDollars);
  if (!(full > 0)) return [];

  const rows = [];
  for (let i = 1; i <= steps; i += 1) {
    const fraction = Math.min(0.999, (full * 2 * i) / steps);
    rows.push({
      fraction,
      ofKelly: fraction / full,
      growth: growthRate(probability, priceDollars, fraction),
    });
  }
  return rows;
}

/**
 * Compounding, so a per-bet growth rate can be read as something human.
 *
 * The reason "2% a day" sounds small: nobody has intuition for exponentials.
 * Two percent a day is roughly thirteen times the account in a year.
 */
export function project(growthPerBet, { betsPerDay = 6, days = 30, start = 100 } = {}) {
  if (!Number.isFinite(growthPerBet)) return null;
  const perDay = growthPerBet * betsPerDay;

  return {
    dailyPercent: (Math.exp(perDay) - 1) * 100,
    endBalance: start * Math.exp(perDay * days),
    daysToDouble: perDay > 0 ? Math.log(2) / perDay : null,
    annualPercent: (Math.exp(perDay * 365) - 1) * 100,
  };
}
