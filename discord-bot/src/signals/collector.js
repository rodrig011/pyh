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

export const DEFAULT_CAPACITY = 2880; // 24 hours at one sample every 30 seconds

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
export async function collectOnce(store, { fetchPrice, asset = 'BTC', now = Date.now() } = {}) {
  try {
    const quote = await fetchPrice(asset);
    const price = Number(quote?.price);
    if (!(price > 0)) return { added: false, reason: quote?.error ?? 'no price' };

    const before = store.listSamples(asset);
    const after = appendSample(before, { at: now, price, source: quote.source ?? null });
    if (after === before) return { added: false, reason: 'stale or out-of-order tick' };

    store.putSamples(asset, after);
    return { added: true, price, samples: after.length };
  } catch (error) {
    return { added: false, reason: error.message };
  }
}
