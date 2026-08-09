/**
 * Turning the raw price ticks (one every ~30s, kept for the volatility
 * estimate) into OHLC candles for a chart. There is no separate candle feed
 * anywhere in this system — the signal engine has never needed one, it reads
 * the tick history directly — so this exists only for the dashboard's chart.
 */

/** Buckets ticks into candles. Pure — the same ticks always produce the same candles. */
export function buildCandles(samples, { bucketMs = 60_000, limit = 60 } = {}) {
  const buckets = new Map();

  for (const sample of samples ?? []) {
    if (!(sample?.price > 0) || !Number.isFinite(sample?.at)) continue;
    const time = Math.floor(sample.at / bucketMs) * bucketMs;
    const existing = buckets.get(time);
    if (!existing) {
      buckets.set(time, { time, open: sample.price, high: sample.price, low: sample.price, close: sample.price });
    } else {
      existing.high = Math.max(existing.high, sample.price);
      existing.low = Math.min(existing.low, sample.price);
      existing.close = sample.price;
    }
  }

  const candles = [...buckets.values()].sort((a, b) => a.time - b.time);
  return limit > 0 ? candles.slice(-limit) : candles;
}
