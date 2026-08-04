/**
 * The descriptive layer: what price has been doing.
 *
 * None of this predicts anything on its own, and a signal engine built only on
 * these is a chart with opinions. They earn their place by saying which regime
 * the market is in — because the fair-value model assumes a random walk, and
 * knowing when that assumption is least true is worth more than any one
 * oscillator.
 */

/** Relative strength, Wilder's, over `period` samples. */
export function rsi(prices, period = 14) {
  const values = (prices ?? []).filter((price) => Number.isFinite(price));
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * How straight the recent move is, as the R² of a line through it.
 *
 * Near 1 the market is trending and the random-walk assumption behind the fair
 * price is at its weakest. Near 0 it is chopping, which is when the model is
 * most trustworthy. This is a confidence dial on the maths, not a signal.
 */
export function trendFit(prices) {
  const values = (prices ?? []).filter((price) => Number.isFinite(price));
  const n = values.length;
  if (n < 3) return null;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    const dy = values[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { r2: 0, slope: 0 };

  const slope = sxy / sxx;
  return { r2: (sxy * sxy) / (sxx * syy), slope };
}

/** Plain move over the window, as a percentage. */
export function momentum(prices) {
  const values = (prices ?? []).filter((price) => Number.isFinite(price));
  if (values.length < 2) return null;
  const first = values[0];
  const last = values.at(-1);
  return first > 0 ? ((last - first) / first) * 100 : null;
}

/**
 * How far the strike is, measured in standard deviations of the time left.
 *
 * The single most useful number on the screen, and the one no chart shows. A
 * strike two sigma away is not "close" or "far" in dollars — it is out of
 * reach in the time remaining, whatever the momentum says.
 */
export function distanceInSigma(spot, strike, sigma) {
  if (!(spot > 0) || !(strike > 0) || !(sigma > 0)) return null;
  return Math.log(spot / strike) / sigma;
}

/**
 * Large trades on the underlying, from a public trade feed.
 *
 * Called a whale by everyone who sells this, and the threshold is doing all
 * the work: a single bitcoin is a rounding error on a venue trading tens of
 * thousands a day. It is reported as what it is — a large print — with the
 * size attached, so nobody has to take the word "whale" on trust.
 */
export function largePrints(trades, { minimumBtc = 5 } = {}) {
  const found = (trades ?? [])
    .map((trade) => ({
      size: Number(trade?.size ?? trade?.amount),
      price: Number(trade?.price),
      side: trade?.side === 'sell' ? 'sell' : 'buy',
      at: Date.parse(trade?.time ?? trade?.at ?? '') || null,
    }))
    .filter((trade) => Number.isFinite(trade.size) && trade.size >= minimumBtc);

  const bought = found.filter((trade) => trade.side === 'buy').reduce((t, x) => t + x.size, 0);
  const sold = found.filter((trade) => trade.side === 'sell').reduce((t, x) => t + x.size, 0);

  return {
    count: found.length,
    boughtBtc: bought,
    soldBtc: sold,
    // Which way the big prints leaned, −1..1. Zero when they cancel out, which
    // is most of the time and is itself worth knowing.
    lean: bought + sold === 0 ? 0 : (bought - sold) / (bought + sold),
    biggest: found.reduce((best, trade) => (best === null || trade.size > best.size ? trade : best), null),
  };
}

/**
 * Whether the book can actually be traded.
 *
 * A signal on an untradeable market is worse than no signal: the member takes
 * it, pays the spread twice, and the record shows the analyst was right. The
 * spread is quoted in cents of contract, which is directly comparable to the
 * edge the model claims — an edge of 2 with a spread of 4 is not an edge.
 */
export function bookQuality(market) {
  const bid = Number(market?.yes_bid_dollars ?? market?.yes_bid);
  const ask = Number(market?.yes_ask_dollars ?? market?.yes_ask);
  const toCents = (value) => (value > 0 && value <= 1 ? value * 100 : value);

  const bidCents = Number.isFinite(bid) ? toCents(bid) : null;
  const askCents = Number.isFinite(ask) ? toCents(ask) : null;
  const liquidity = Number(market?.liquidity_dollars ?? market?.liquidity);

  return {
    bidCents,
    askCents,
    spreadCents: bidCents !== null && askCents !== null ? Math.max(0, askCents - bidCents) : null,
    liquidityDollars: Number.isFinite(liquidity) ? liquidity : null,
  };
}
