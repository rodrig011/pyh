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

/**
 * Realized volatility over the last `samples` returns. The building block the
 * multi-scale forecast below is made of.
 */
export function realizedOver(returns, samples) {
  const values = (returns ?? []).filter(Number.isFinite).slice(-samples);
  if (values.length < 2) return null;
  return Math.sqrt(values.reduce((total, value) => total + value * value, 0) / values.length);
}

/**
 * The same window, measured in a way a single jump cannot inflate.
 *
 * Bipower variation multiplies neighbouring absolute returns instead of
 * squaring each one, so one enormous move is multiplied by its ordinary
 * neighbour rather than by itself. It is the difference between "the market is
 * violent" and "something happened once".
 */
export function robustOver(returns, samples) {
  const values = (returns ?? []).filter(Number.isFinite).slice(-samples);
  if (values.length < 3) return null;
  return bipowerVolatility(values);
}

/**
 * HAR: volatility measured at three time scales at once.
 *
 * The single strongest known result about forecasting realized volatility, and
 * the reason is a fact about markets rather than about statistics. Volatility
 * is made by traders operating on different horizons — someone scalping the
 * next two minutes, someone hedging over the hour, someone positioned for the
 * day — and each leaves its own persistence in the price. One exponential
 * decay, however well tuned, cannot represent three of them at once. It has a
 * single memory, so it is always either too slow for the fast component or too
 * fast for the slow one.
 *
 * HAR simply measures all three and adds them up. Corsi (2009); it has beaten
 * GARCH and EWMA on essentially every liquid asset it has been tried on.
 *
 * The weights are the one thing that has to come from somewhere. These are the
 * broad values the literature keeps landing on, and they are parameters rather
 * than constants precisely so they can be refitted on the recorded data once
 * there is enough of it — fitting them on a simulation would only recover the
 * simulation's own assumptions.
 */
export function harVolatility(
  returns,
  { short = 10, medium = 60, long = 240, weights = [0.4, 0.35, 0.25], robust = true } = {},
) {
  const values = (returns ?? []).filter(Number.isFinite);
  if (values.length < 4) return null;

  // Each scale measured jump-robustly by default. Measured across five seeds,
  // a plain-realized HAR beats the old estimator in a smooth world and loses
  // in every jumpy one — because the estimator it replaces was already
  // jump-robust and this threw that away. Three time scales AND resistance to
  // a single violent print is the combination that wins in both.
  const measure = robust ? robustOver : realizedOver;
  const scales = [short, medium, long].map((samples) => measure(values, samples));

  // A scale with no data yet falls back to the shortest one that has any,
  // rather than dropping out — early in a session the long window is empty and
  // the forecast should still be the best available answer, not null.
  const available = scales.filter((value) => value !== null && value > 0);
  if (available.length === 0) return null;

  let total = 0;
  let used = 0;
  scales.forEach((value, index) => {
    const usable = value !== null && value > 0 ? value : available[0];
    total += weights[index] * usable;
    used += weights[index];
  });

  return used > 0 ? total / used : null;
}
