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
 * Exponential moving average — the standard multiplier, seeded with a plain
 * average of the first `period` values rather than the first value alone, so
 * a jumpy opening tick cannot dominate weeks of smoothing on its own.
 * Returns the CURRENT value only; see `emaSeries` for the whole line.
 */
export function ema(prices, period) {
  const series = emaSeries(prices, period);
  return series.length ? series.at(-1).value : null;
}

/** Every EMA value from the point there is enough history, not just the last one. */
export function emaSeries(prices, period) {
  const values = (prices ?? []).filter((price) => Number.isFinite(price));
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  const out = [{ index: period - 1, value: seed }];
  let prev = seed;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push({ index: i, value: prev });
  }
  return out;
}

/**
 * Whether the short, medium and long averages are stacked in the same order
 * price is moving — the plain trend-following read everyone means by
 * "EMA9/21/50", collapsed to one word instead of three numbers nobody reads
 * mid-trade.
 */
export function emaStack(prices, periods = [9, 21, 50]) {
  const values = periods.map((period) => ema(prices, period));
  if (values.some((value) => value === null)) return { alignment: null, values };
  const [fast, mid, slow] = values;
  const alignment = fast > mid && mid > slow ? 'bullish' : fast < mid && mid < slow ? 'bearish' : 'mixed';
  return { alignment, values: { fast, mid, slow } };
}

/**
 * MACD: the gap between a fast and a slow EMA, and that gap's own EMA as the
 * signal line. The histogram is what most people actually mean when they say
 * "MACD crossed" — it changes sign exactly when the two lines cross.
 */
export function macd(prices, { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = {}) {
  const values = (prices ?? []).filter((price) => Number.isFinite(price));
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  if (fast.length === 0 || slow.length === 0) return null;

  const slowByIndex = new Map(slow.map((point) => [point.index, point.value]));
  const macdLine = fast
    .filter((point) => slowByIndex.has(point.index))
    .map((point) => point.value - slowByIndex.get(point.index));
  if (macdLine.length < signalPeriod) return null;

  const signalSeries = emaSeries(macdLine, signalPeriod);
  if (signalSeries.length === 0) return null;

  const macdNow = macdLine.at(-1);
  const signalNow = signalSeries.at(-1).value;
  return { macd: macdNow, signal: signalNow, histogram: macdNow - signalNow };
}

/**
 * Bollinger width, as a percentage of price rather than a dollar figure —
 * the number that actually compares across time as BTC's own price moves.
 * A squeeze (small width) says the market has gone quiet; that quiet
 * usually ends with a move, not a direction.
 */
export function bollingerWidth(prices, { period = 20, stdDevMultiplier = 2 } = {}) {
  const values = (prices ?? []).filter((price) => Number.isFinite(price)).slice(-period);
  if (values.length < period) return null;

  const mean = values.reduce((sum, v) => sum + v, 0) / period;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  if (!(mean > 0)) return null;

  const upper = mean + stdDevMultiplier * stdDev;
  const lower = mean - stdDevMultiplier * stdDev;
  return { upper, lower, mid: mean, widthPercent: ((upper - lower) / mean) * 100 };
}

/**
 * Average True Range, Wilder's smoothing, from OHLC candles rather than the
 * raw tick history — true range needs a high and a low, which a single price
 * per tick does not carry.
 */
export function atr(candles, period = 14) {
  const bars = (candles ?? []).filter(
    (c) => Number.isFinite(c?.high) && Number.isFinite(c?.low) && Number.isFinite(c?.close),
  );
  if (bars.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].close;
    trueRanges.push(
      Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)),
    );
  }
  if (trueRanges.length < period) return null;

  let value = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    value = (value * (period - 1) + trueRanges[i]) / period;
  }
  return value;
}

/**
 * Percentage move over a fixed lookback, from TIMESTAMPED samples — not the
 * plain `prices` array, which has no clock of its own and cannot say what
 * "5 minutes ago" means. Reads whichever sample is closest to that instant,
 * since ticks land every ~30s rather than on the minute exactly.
 */
export function priceChangeOverMinutes(samples, minutes, now = Date.now()) {
  const points = (samples ?? []).filter((s) => Number.isFinite(s?.at) && s?.price > 0).sort((a, b) => a.at - b.at);
  if (points.length < 2) return null;

  const target = now - minutes * 60_000;
  let closest = points[0];
  for (const point of points) {
    if (Math.abs(point.at - target) < Math.abs(closest.at - target)) closest = point;
    if (point.at > target) break;
  }
  const latest = points.at(-1);
  // Nothing this old — do not report a "5 minute change" measured over 40
  // seconds of actual history just because that is all there was.
  if (latest.at - closest.at < minutes * 60_000 * 0.5) return null;

  return closest.price > 0 ? ((latest.price - closest.price) / closest.price) * 100 : null;
}

/**
 * A rough trading-session label from the UTC hour. Genuinely approximate —
 * real sessions overlap and drift with daylight saving — but good enough to
 * say "this is the illiquid stretch" versus "both London and New York are
 * awake", which is the distinction that actually matters for how thin the
 * book is likely to be.
 */
export function sessionOf(now = Date.now()) {
  const hour = new Date(now).getUTCHours();
  if (hour >= 0 && hour < 7) return 'asia';
  if (hour >= 7 && hour < 12) return 'london';
  if (hour >= 12 && hour < 16) return 'london_ny_overlap';
  if (hour >= 16 && hour < 21) return 'new_york';
  return 'late';
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
