/**
 * The boring half, and the half without which none of the rest is real.
 *
 * The engine measures how fast BTC is moving from a history of prices. Nobody
 * has that history until something writes it down, every thirty seconds,
 * forever, starting before anyone wants it. Three weeks of this is the
 * difference between a model that can be checked and one that can only be
 * believed.
 *
 * Kept as a ring buffer with a hard cap, because a file that grows without
 * limit on a small volume eventually takes the payments down with it.
 */

import { BRTI_FEED_VERSION } from '../picks/price.js';

export const DEFAULT_CAPACITY = 2880; // 24 hours at one sample every 30 seconds

/** Use completed, uniformly spaced buckets, never 3600 one-second ticks
 * labelled as thirty-second returns. The provider history also warms a restart. */
export function signalSamples(samples, quote, { now = Date.now(), sampleSeconds = 30 } = {}) {
  const since = now - 3_600_000;
  if (quote?.source !== 'kalshi-brti') {
    return (samples ?? []).filter((s) => s?.at >= since && s.at <= now && s.price > 0);
  }
  const buckets = new Map();
  const step = sampleSeconds * 1000;
  for (const sample of [...(samples ?? []), ...(quote.history ?? [])]) {
    if (sample?.feedVersion !== BRTI_FEED_VERSION || sample.source !== 'kalshi-brti' ||
        !Number.isFinite(sample.sourceAt) || !(sample.price > 0) ||
        sample.sourceAt < since || sample.sourceAt >= Math.floor(now / step) * step) continue;
    const bucket = Math.floor(sample.sourceAt / step);
    if (!buckets.has(bucket) || buckets.get(bucket).sourceAt <= sample.sourceAt) {
      buckets.set(bucket, { ...sample, at: sample.sourceAt });
    }
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

export function priceContext(samples, quote, options = {}) {
  const history = signalSamples(samples, quote, options);
  return {
    prices: history.map((s) => s.price),
    priceSamples: history,
    spot: quote?.price ?? null,
    spotSource: quote?.source ?? null,
    sourceAt: quote?.sourceAt ?? null,
    feedVersion: quote?.feedVersion ?? null,
    settlementSamples: quote?.history ?? [],
    now: options.now ?? Date.now(),
  };
}

/**
 * Adds a sample and drops the oldest once the buffer is full.
 *
 * Pure, so the retention rule can be checked rather than trusted — this runs
 * two thousand times a day beside the code that handles money.
 */
export function appendSample(samples, sample, { capacity = DEFAULT_CAPACITY } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  if (!Number.isFinite(sample?.at) || !(sample?.price > 0)) return list;

  // Out-of-order or duplicate timestamps would corrupt every return computed
  // from them, and a bad tick is worth less than the estimate it poisons.
  const last = list.at(-1);
  if (last && sample.at <= last.at) return list;

  const next = [...list, sample];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/** The prices from a window of samples, oldest first, for the engine to read. */
export function pricesSince(samples, since) {
  return (samples ?? [])
    .filter((sample) => sample.at >= since && sample.price > 0)
    .map((sample) => sample.price);
}

/**
 * Whether the history is good enough to measure volatility from.
 *
 * A gap is not a small problem: returns computed across a two-minute hole are
 * two-minute returns wearing a thirty-second label, and every probability
 * downstream inherits the lie. Better to say so and skip.
 */
export function historyQuality(samples, { sampleSeconds = 30, minimumSamples = 20 } = {}) {
  const list = (samples ?? []).filter((sample) => sample.price > 0);
  if (list.length < minimumSamples) {
    return { ok: false, reason: `only ${list.length} samples, ${minimumSamples} needed`, samples: list.length };
  }

  const expected = sampleSeconds * 1000;
  let worstGap = 0;
  for (let i = 1; i < list.length; i += 1) {
    worstGap = Math.max(worstGap, list[i].at - list[i - 1].at);
  }

  // Two missed samples in a row is a hole worth refusing over.
  const ok = worstGap <= expected * 3;
  return {
    ok,
    samples: list.length,
    worstGapSeconds: Math.round(worstGap / 1000),
    reason: ok ? null : `a ${Math.round(worstGap / 1000)}s gap in the history`,
  };
}

/**
 * One pass: read the price, write it down.
 *
 * Never throws. A collector that can take the bot down with it is worse than
 * no collector, and this runs beside the code that grants paid access.
 */
export async function collectOnce(store, { fetchPrice, asset = 'BTC', now = Date.now(), sampleSeconds = 30 } = {}) {
  try {
    const quote = await fetchPrice(asset);
    const price = Number(quote?.price);
    if (!(price > 0)) return { added: false, reason: quote?.error ?? 'no price' };

    const before = store.listSamples(asset);
    let after;
    if (quote.source === 'kalshi-brti') {
      if (quote.feedVersion !== BRTI_FEED_VERSION || !Number.isFinite(quote.sourceAt)) {
        return { added: false, reason: 'unverified BRTI timestamp' };
      }
      const verified = signalSamples(before, quote, { now, sampleSeconds });
      const seen = new Set(before.map((s) => `${s.feedVersion}:${s.at}`));
      const newRows = verified.filter((s) => !seen.has(`${s.feedVersion}:${s.at}`));
      if (newRows.length === 0) return { added: false, reason: 'no new BRTI interval' };
      // Retain legacy rows for audit; inference selects only verified v2 rows.
      after = [...before, ...newRows].sort((a, b) => a.at - b.at).slice(-DEFAULT_CAPACITY);
    } else {
      after = appendSample(before, { at: now, price, source: quote.source ?? null });
    }
    if (after === before) return { added: false, reason: 'stale or out-of-order tick' };

    store.putSamples(asset, after);
    return { added: true, price, source: quote.source ?? null, sourceAt: quote.sourceAt ?? null,
      feedVersion: quote.feedVersion ?? null, quote, samples: after.length };
  } catch (error) {
    return { added: false, reason: error.message };
  }
}
