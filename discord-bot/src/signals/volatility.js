/**
 * Estimating how fast the market is moving, which is the number everything
 * else rests on.
 *
 * The probability, the edge, the flip odds — all of them are one volatility
 * estimate wearing different clothes. A simple root-mean-square of recent
 * returns, which is what most of this is built on, has three problems that
 * each cost real money on a fifteen-minute contract:
 *
 *   1. It weights a move from twenty minutes ago the same as one from twenty
 *      seconds ago, so it is slow exactly when the market turns.
 *   2. A single jump — a large print, a headline — inflates it for the whole
 *      window, and every probability that follows is dragged toward 50%.
 *   3. It reports one number, as if it were known. It is an estimate from a
 *      few dozen samples and it has real error, and pretending otherwise is
 *      how a model ends up confidently wrong.
 *
 * This module fixes all three.
 */

/**
 * Exponentially weighted volatility, RiskMetrics style.
 *
 * λ=0.94 is the industry default for daily data; on 30-second samples the
 * memory that matters is much shorter, so the caller picks. What it buys: when
 * the market goes quiet or wakes up, the estimate follows within a few samples
 * instead of dragging the whole window behind it.
 */
export function ewmaVolatility(returns, lambda = 0.94) {
  const values = (returns ?? []).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  if (!(lambda > 0 && lambda < 1)) return null;

  // Seeded with the plain variance of the first few, so the first estimate is
  // not simply the first return squared.
  const seed = values.slice(0, Math.min(5, values.length));
  let variance = seed.reduce((total, value) => total + value * value, 0) / seed.length;

  for (const value of values.slice(seed.length)) {
    variance = lambda * variance + (1 - lambda) * value * value;
  }

  return Math.sqrt(variance);
}

/**
 * Jump-robust volatility: bipower variation.
 *
 * Sums |r_i|·|r_{i−1}| rather than r². A single large jump appears in only two
 * of those products and is multiplied by its small neighbours, so it barely
 * moves the estimate — while a genuine rise in activity, where every return
 * grows, moves it fully.
 *
 * This is the difference between "BTC printed one big trade" and "BTC is
 * moving", and the two demand opposite bets.
 */
export function bipowerVolatility(returns) {
  const values = (returns ?? []).filter((value) => Number.isFinite(value));
  if (values.length < 3) return null;

  // μ₁ = E|Z| for a standard normal. The scaling that makes this comparable to
  // an ordinary standard deviation.
  const mu1 = Math.sqrt(2 / Math.PI);

  let total = 0;
  for (let i = 1; i < values.length; i += 1) {
    total += Math.abs(values[i]) * Math.abs(values[i - 1]);
  }
  const variance = total / ((values.length - 1) * mu1 * mu1);
  return variance > 0 ? Math.sqrt(variance) : null;
}

/**
 * How much of the movement was jumps rather than ordinary noise.
 *
 * Near 0 the market is diffusing normally and the model is at its best. Well
 * above 0 something discrete happened, the random-walk assumption is strained,
 * and the honest response is to widen the uncertainty rather than pretend.
 */
export function jumpShare(returns) {
  const plain = plainVolatility(returns);
  const robust = bipowerVolatility(returns);
  if (!(plain > 0) || !(robust > 0)) return null;
  return Math.max(0, 1 - (robust * robust) / (plain * plain));
}

/** Plain root-mean-square. Kept for comparison, not for deciding. */
export function plainVolatility(returns) {
  const values = (returns ?? []).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  return Math.sqrt(values.reduce((total, value) => total + value * value, 0) / values.length);
}

/**
 * The estimate the engine actually uses, with the error bar it deserves.
 *
 * A blend: the exponentially weighted number for responsiveness, the
 * jump-robust one for stability, leaning further toward robust the more the
 * window looks like it contained a jump.
 *
 * The interval is the real upgrade. The standard error of a volatility
 * estimate from n samples is about σ/√(2n) — with forty 30-second samples that
 * is roughly 11% of the estimate, which moves a probability by several points.
 * Publishing one number hides that. Publishing the band means the engine can
 * be made to require that even its pessimistic case beats the market, and that
 * is what turns a good-looking model into one that survives contact.
 */
export function volatilityEstimate(returns, { lambda = 0.94, confidence = 1 } = {}) {
  const values = (returns ?? []).filter((value) => Number.isFinite(value));
  if (values.length < 3) return null;

  const ewma = ewmaVolatility(values, lambda);
  const robust = bipowerVolatility(values);
  const plain = plainVolatility(values);
  const jumps = jumpShare(values) ?? 0;

  if (!(ewma > 0) && !(robust > 0)) return null;

  // With no jumps, trust the responsive estimate. With jumps, lean on the one
  // that ignores them.
  const weight = Math.min(1, Math.max(0, jumps * 2));
  const sigma =
    ewma > 0 && robust > 0 ? ewma * (1 - weight) + robust * weight : (ewma ?? robust);

  // Standard error of a standard deviation from n samples.
  const standardError = sigma / Math.sqrt(2 * values.length);

  return {
    sigma,
    low: Math.max(1e-9, sigma - confidence * standardError),
    high: sigma + confidence * standardError,
    standardError,
    samples: values.length,
    jumpShare: jumps,
    // Kept so a diagnostic can show what each method thought.
    ewma,
    robust,
    plain,
  };
}

/**
 * The correction for only being able to watch every so often.
 *
 * The barrier formula assumes the price is observed continuously. It is not —
 * the bot sees a print every thirty seconds, and a touch that happens between
 * two observations is a touch that happened. Broadie, Glasserman and Kou
 * showed the fix is to shift the barrier by exp(±β·σ·√Δt), β ≈ 0.5826.
 *
 * Without it the flip odds are systematically too low, which is the direction
 * that costs money: it tells a room to hold positions it should have banked.
 */
export const BGK_BETA = 0.5826;

export function discreteBarrier(barrier, sigmaPerSample, { above = true }) {
  if (!(barrier > 0) || !(sigmaPerSample > 0)) return barrier;
  const shift = Math.exp((above ? 1 : -1) * BGK_BETA * sigmaPerSample);
  return barrier * shift;
}
