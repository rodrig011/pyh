/**
 * Turning the raw price ticks (one every ~30s, kept for the volatility
 * estimate) into OHLC candles for a chart. There is no separate candle feed
 * anywhere in this system — the signal engine has never needed one, it reads
 * the tick history directly — so this exists only for the dashboard's chart.
 */

import { rsi } from '../signals/indicators.js';

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

/**
 * RSI at every candle, not just the most recent one — a chart needs the
 * whole line, where the engine itself only ever asks for the current value.
 * `rsi()` is Wilder's smoothing over however much history it is handed, so
 * this recomputes it fresh at each point on the closes seen so far — O(n·p)
 * on a couple hundred candles, which costs nothing worth measuring.
 */
export function rsiSeries(candles, { period = 14 } = {}) {
  const closes = (candles ?? []).map((candle) => candle.close);
  const out = [];
  for (let i = period; i < closes.length; i += 1) {
    const value = rsi(closes.slice(0, i + 1), period);
    if (Number.isFinite(value)) out.push({ time: candles[i].time, value });
  }
  return out;
}
