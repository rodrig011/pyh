/**
 * The maths a binary market is actually priced on.
 *
 * Everything else in a signal engine — RSI, momentum, candle patterns — is a
 * description of what price did. This is the only part that answers the
 * question the contract asks: given where BTC is, how far the strike is, how
 * violently it has been moving and how long is left, what is the honest
 * probability it closes above that strike?
 *
 * That number can be compared against what the market charges for the same
 * bet. The difference is the whole edge. If there is no difference there is no
 * trade, however good the chart looks.
 */

/**
 * Standard normal CDF, Abramowitz & Stegun 7.1.26 through erf.
 * Accurate to ~1.5e-7, which is far past what a 15-minute vol estimate
 * deserves — the error that matters lives in the vol, not here.
 */
export function normalCdf(x) {
  if (!Number.isFinite(x)) return null;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

/** Log returns between consecutive prices. The unit volatility is measured in. */
export function logReturns(prices) {
  const out = [];
  for (let i = 1; i < (prices?.length ?? 0); i += 1) {
    const previous = Number(prices[i - 1]);
    const current = Number(prices[i]);
    if (!(previous > 0) || !(current > 0)) continue;
    out.push(Math.log(current / previous));
  }
  return out;
}

/**
 * Volatility per sample, from the returns themselves.
 *
 * Deliberately not de-meaned. Over fifteen minutes the drift is noise, and
 * subtracting a mean estimated from thirty samples mostly subtracts noise —
 * which flatters the estimate exactly when the market is trending, the moment
 * an honest estimate matters most.
 */
export function realizedVolatility(returns) {
  const values = (returns ?? []).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const meanSquare = values.reduce((total, value) => total + value * value, 0) / values.length;
  return Math.sqrt(meanSquare);
}

/**
 * Volatility rescaled from the sampling interval to the time left in the
 * market. Vol grows with the square root of time, which is why a market with
 * two minutes left is a very different bet from the same market with twelve.
 */
export function scaleVolatility(volPerSample, sampleSeconds, horizonSeconds) {
  if (!(volPerSample > 0) || !(sampleSeconds > 0) || !(horizonSeconds > 0)) return null;
  return volPerSample * Math.sqrt(horizonSeconds / sampleSeconds);
}

/**
 * The probability the price finishes above the strike.
 *
 * Log-normal, zero drift: over fifteen minutes any drift worth modelling is
 * smaller than the error in the vol estimate, and pretending otherwise is how
 * a model starts predicting what its author hopes.
 *
 * @param {number} spot price now
 * @param {number} strike level the contract settles against
 * @param {number} sigma volatility over the remaining horizon (not annualised)
 * @returns {number|null} 0..1
 */
export function probabilityAbove(spot, strike, sigma) {
  if (!(spot > 0) || !(strike > 0)) return null;

  // No time left: it is simply where it is.
  if (!(sigma > 0)) return spot > strike ? 1 : spot < strike ? 0 : 0.5;

  const d = (Math.log(spot / strike) - (sigma * sigma) / 2) / sigma;
  return normalCdf(d);
}

/**
 * Kalshi's trading fee, in dollars per contract.
 *
 * Published formula: 0.07 × C × P × (1−P), rounded up to the cent. It peaks at
 * a price of 50¢ — precisely the coin-flip markets that look most tempting —
 * and that is why a 51/49 read is not a trade.
 */
export function feePerContract(priceDollars, rate = 0.07) {
  if (!(priceDollars > 0) || priceDollars >= 1) return 0;
  return Math.ceil(rate * priceDollars * (1 - priceDollars) * 100) / 100;
}

/**
 * What one contract is worth taking, after the exchange is paid.
 *
 * Buying at p pays 1 if it lands. Expected value is q − p, and the fee comes
 * off both ways. Expressed per dollar risked, because that is what compares
 * across prices — 2¢ of edge on a 10¢ contract is not the same trade as 2¢ on
 * an 80¢ one.
 */
export function expectedValue(probability, priceDollars, { feeRate = 0.07 } = {}) {
  if (!Number.isFinite(probability) || !(priceDollars > 0) || priceDollars >= 1) return null;

  const fee = feePerContract(priceDollars, feeRate);
  const edge = probability - priceDollars;
  const net = edge - fee;

  return {
    edge,
    feeDollars: fee,
    net,
    // Return on the money actually at risk, which is the price paid.
    returnOnRisk: net / priceDollars,
    // How far the market would have to be wrong before this is worth taking.
    breakEvenProbability: priceDollars + fee,
  };
}
