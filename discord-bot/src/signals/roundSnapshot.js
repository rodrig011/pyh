/**
 * The raw material for ever answering "have we seen a round like this
 * before" honestly instead of by inventing a number.
 *
 * A round snapshot is the full board at one moment — patterns, levels,
 * gaps, indicators, the model's own read — tagged with what actually
 * happened once the window closed. Nothing in here matches anything yet;
 * this only writes the history down so that, once enough of it exists, a
 * real similarity search has something real to search. There is no way to
 * backfill this after the fact, which is the whole reason it starts now
 * rather than once someone finally asks for the matching feature.
 */

export const DEFAULT_CAPACITY = 8000;

/** One round's picture, or null when there is not enough to make it worth keeping. */
export function makeRoundSnapshot({
  at,
  ticker,
  closesAt,
  spot,
  strike,
  patterns = null,
  levels = [],
  fairValueGaps = [],
  indicators = null,
  confluenceLean = null,
  modelProbability = null,
}) {
  if (!(at > 0) || !ticker || !(spot > 0) || !(strike > 0) || !(closesAt > at)) return null;

  return {
    at,
    ticker,
    closesAt,
    spot,
    strike,
    patterns,
    levels,
    fairValueGaps,
    rsi: Number.isFinite(indicators?.rsi) ? indicators.rsi : null,
    momentum: Number.isFinite(indicators?.momentum) ? indicators.momentum : null,
    trendR2: Number.isFinite(indicators?.trendR2) ? indicators.trendR2 : null,
    macdHistogram: Number.isFinite(indicators?.macdHistogram) ? indicators.macdHistogram : null,
    emaStack: indicators?.emaStack ?? null,
    confluenceLean: confluenceLean === 'up' || confluenceLean === 'down' ? confluenceLean : null,
    modelProbability: Number.isFinite(modelProbability) ? modelProbability : null,
    // Filled in once the round closes.
    outcome: null,
    settledSpot: null,
  };
}

/**
 * Keeps the latest snapshot for a still-open ticker rather than the
 * earliest — the picture right before a round closes is the one worth
 * comparing future rounds against, not whatever the board looked like the
 * first time this ticker was seen.
 */
export function appendRoundSnapshot(log, snapshot, { capacity = DEFAULT_CAPACITY } = {}) {
  if (!snapshot) return log ?? [];
  const list = log ?? [];

  const index = list.findIndex((row) => row.ticker === snapshot.ticker && row.outcome === null);
  if (index >= 0) {
    const next = [...list];
    next[index] = snapshot;
    return next;
  }

  const next = [...list, snapshot];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/**
 * Grades every snapshot whose round has closed — the settlement average of
 * the final sixty seconds, the same window recorder.js and confluenceLog.js
 * each already use so a round is never graded off one noisy tick.
 */
export function settleRoundSnapshots(log, { now = Date.now(), samples = [], settledBefore = 60_000 } = {}) {
  const priced = (samples ?? [])
    .filter((sample) => sample?.at > 0 && sample?.price > 0)
    .sort((a, b) => a.at - b.at);
  if (priced.length === 0) return { log: log ?? [], settled: 0 };

  const settlementSpot = (closes) => {
    const window = priced.filter((s) => s.at > closes - 60_000 && s.at <= closes + 5_000);
    if (window.length > 0) return window.reduce((total, s) => total + s.price, 0) / window.length;
    const nearest = priced.reduce(
      (best, s) => (best === null || Math.abs(s.at - closes) < Math.abs(best.at - closes) ? s : best),
      null,
    );
    return nearest && Math.abs(nearest.at - closes) < 5 * 60_000 ? nearest.price : null;
  };

  let settled = 0;
  const out = (log ?? []).map((row) => {
    if (row.outcome !== null) return row;
    if (now - row.closesAt <= settledBefore) return row;
    const spot = settlementSpot(row.closesAt);
    if (spot === null) return row;
    settled += 1;
    return { ...row, outcome: spot > row.strike ? 1 : 0, settledSpot: spot };
  });

  return { log: out, settled };
}

/**
 * The honest status line for a UI: how much real history exists, and
 * whether it is enough for anything built on top of it to mean something.
 * No matching or similarity search here — that is a different feature, and
 * one that needs weeks of settled rounds before its answer is more than
 * noise.
 */
export function roundHistorySummary(log, { minimumSettled = 200 } = {}) {
  const rows = log ?? [];
  const settled = rows.filter((row) => row.outcome !== null).length;
  return {
    recorded: rows.length,
    settled,
    enough: settled >= minimumSettled,
    minimumSettled,
  };
}
