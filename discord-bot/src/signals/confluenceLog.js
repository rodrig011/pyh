/**
 * Whether the confluence lean is worth listening to — measured, not asserted.
 *
 * confluence.js reads trend, oscillator, and flow agreement into a lean. That
 * is an opinion about where BTC is headed over the next fifteen minutes,
 * independent of any specific Kalshi contract or strike — so it is graded
 * against the only thing it actually claims: whether spot, fifteen minutes
 * later, finished above or below where it was AT THE READ. Not the nearest
 * strike, which is a different question — was THIS contract's line crossed —
 * that already has its own answer in misses.js.
 *
 * Settled the same way the exchange itself settles: the average of the final
 * sixty seconds, not one point sample. Anything else grades confluence
 * against noise the model it is meant to be checked against was never
 * exposed to.
 *
 * The comparison against the primary model's own directional lean travels
 * with every row, because the question that matters is not "is confluence
 * ever right" — a coin is right half the time — it is "does confluence say
 * anything the primary model was not already saying." Agreement that is no
 * more accurate than disagreement means confluence is decoration.
 */

export const DEFAULT_CAPACITY = 4000;

/** How far forward the lean is graded. Matches the Kalshi window everything
 * else here already thinks in, and doubles as the bucket width below — one
 * call per window, so consecutive rows grade non-overlapping stretches of
 * tape instead of the same fifteen minutes counted a dozen times over. */
export const HORIZON_MS = 15 * 60 * 1000;

/**
 * One confluence read, or null when there is nothing worth grading.
 *
 * A squeeze (no lean at all) is not a prediction and is not recorded — there
 * is nothing to check it against later.
 */
export function makeConfluenceRecord({
  at,
  spot,
  lean,
  score,
  primaryLeaning = null,
  primaryWinProbability = null,
}) {
  if (!(at > 0) || !(spot > 0)) return null;
  if (lean !== 'up' && lean !== 'down') return null;

  return {
    at,
    spot,
    lean,
    score: Number.isFinite(score) ? score : null,
    // The primary model's OWN directional lean, not its `call` — `call` is
    // which side is worth buying at its price, a different question that
    // depends on the quote as much as the direction. Comparing confluence to
    // the wrong one of those would blame it for a disagreement that was
    // never really about direction at all.
    primaryLeaning: primaryLeaning === 'up' || primaryLeaning === 'down' ? primaryLeaning : null,
    primaryWinProbability: Number.isFinite(primaryWinProbability) ? primaryWinProbability : null,
    agreesWithPrimary:
      primaryLeaning === 'up' || primaryLeaning === 'down' ? lean === primaryLeaning : null,
    // Filled in once the horizon has passed: 1 if the lean was right.
    won: null,
    settledAt: null,
  };
}

/**
 * Adds a record, keeping one per HORIZON-length bucket.
 *
 * A sweep firing every ten or thirty seconds would otherwise write dozens of
 * near-identical rows per fifteen-minute stretch — the same call, restated,
 * counted as if it were independent evidence. One bucket per horizon keeps
 * the log to one row per window, and keeps the most decisive read in it
 * (largest |score|) rather than whichever tick happened to land last.
 */
export function appendConfluenceRecord(log, record, { capacity = DEFAULT_CAPACITY, bucketMs = HORIZON_MS } = {}) {
  if (!record) return log ?? [];
  const list = log ?? [];
  const bucket = Math.floor(record.at / bucketMs);

  const index = list.findIndex((row) => row.bucket === bucket && row.won === null);
  if (index >= 0) {
    const existing = list[index];
    const better = Math.abs(record.score ?? 0) > Math.abs(existing.score ?? 0);
    if (!better) return list;
    const next = [...list];
    next[index] = { ...record, bucket };
    return next;
  }

  const next = [...list, { ...record, bucket }];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/**
 * Grades every record whose horizon has passed.
 *
 * Mirrors misses.js's settlement rule exactly: a grace period so a window is
 * not graded off the one sample that happened to land early, and the outcome
 * is the average spot over the trailing window rather than a single point.
 *
 * Returns `{ log, settled }` rather than the log alone — matching
 * recorder.js's settleObservations, not misses.js — because this runs on
 * every dashboard poll and a caller needs to tell "nothing changed" from
 * "something did" without diffing the whole array, or every poll turns into
 * a store write even when there was nothing new to grade.
 */
export function settleConfluenceRecords(
  log,
  { now = Date.now(), samples = [], windowSeconds = 60, horizonMs = HORIZON_MS } = {},
) {
  const priced = (samples ?? []).filter((sample) => sample?.at > 0 && sample?.price > 0);
  if (priced.length === 0) return { log: log ?? [], settled: 0 };

  let settled = 0;
  const out = (log ?? []).map((record) => {
    if (record.won !== null) return record;

    const targetAt = record.at + horizonMs;
    if (now < targetAt + 30_000) return record;

    const window = priced.filter(
      (sample) => sample.at >= targetAt - windowSeconds * 1000 && sample.at <= targetAt,
    );
    if (window.length === 0) return record;

    const settle = window.reduce((total, sample) => total + sample.price, 0) / window.length;
    const wentUp = settle > record.spot;
    settled += 1;
    return { ...record, won: (record.lean === 'up') === wentUp ? 1 : 0, settledAt: settle };
  });

  return { log: out, settled };
}

function bucketStats(rows) {
  const settled = rows.length;
  const wins = rows.reduce((total, row) => total + row.won, 0);
  return {
    settled,
    wins,
    winRate: settled > 0 ? wins / settled : null,
  };
}

/**
 * The question this whole file exists to answer, split the only way that is
 * not misleading: confluence's accuracy overall, AND split by whether it
 * agreed with the primary model. A coin is right half the time on its own —
 * "confluence is right 52% of the time" is not evidence of anything. Whether
 * it is right MORE OFTEN when it disagrees with the model than when it
 * agrees is the number that says whether it is worth reading at all.
 */
export function confluencePatterns(log, { minimumSettled = 20 } = {}) {
  const graded = (log ?? []).filter((row) => row.won !== null);
  const stats = (rows) => ({ ...bucketStats(rows), enough: rows.length >= minimumSettled });

  return [
    { bucket: 'overall', ...stats(graded) },
    { bucket: 'agrees_with_model', ...stats(graded.filter((row) => row.agreesWithPrimary === true)) },
    { bucket: 'disagrees_with_model', ...stats(graded.filter((row) => row.agreesWithPrimary === false)) },
    { bucket: 'no_model_opinion', ...stats(graded.filter((row) => row.agreesWithPrimary === null)) },
  ];
}

/** The one line that says whether this bucket is worth reading. */
export function confluenceVerdict(pattern) {
  if (!pattern?.enough) return 'not enough settled to say';
  if (pattern.winRate > 0.55) return 'ahead of a coin flip';
  if (pattern.winRate < 0.45) return 'behind a coin flip — worth reading the OTHER way, if anything';
  return 'no better than a coin flip';
}
