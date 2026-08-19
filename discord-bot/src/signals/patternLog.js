/**
 * Whether Pattern Sonar's shapes are actually worth reading — measured the
 * same way confluenceLog.js measures confluence: record the claim the
 * instant it is made, wait for the horizon to pass, grade it against what
 * spot actually did. A double top that confirms is a claim ("price keeps
 * falling from here") the same way a confluence lean is one, and it gets
 * exactly the same treatment: no claim recorded until there is a real
 * chance to be wrong, and no verdict printed until enough of them have
 * settled to mean anything.
 *
 * Confirmation, not detection, is the moment graded — see patterns.js: a
 * detected-but-unconfirmed shape ("waiting for a clean neckline break")
 * has not actually made a directional claim yet. The claim starts the
 * instant the break happens, so that is where the clock starts.
 */

export const DEFAULT_CAPACITY = 4000;

/** Same horizon confluenceLog.js grades on — one Kalshi window forward. */
export const HORIZON_MS = 15 * 60 * 1000;

/** One confirmed pattern's claim, or null when there is nothing to grade. */
export function makePatternRecord({ at, spot, patternKey, label, bias, quality }) {
  if (!(at > 0) || !(spot > 0)) return null;
  if (!patternKey || !label) return null;
  if (bias !== 'bullish' && bias !== 'bearish') return null;

  return {
    at,
    spot,
    patternKey,
    label,
    bias,
    quality: Number.isFinite(quality) ? quality : null,
    // Filled in once the horizon has passed.
    won: null,
    settledAt: null,
  };
}

/**
 * Adds a record, one per pattern type per horizon-length bucket — the same
 * dedup confluenceLog.js does, applied per pattern key so a Double Top
 * confirming and a Bear Flag confirming in the same window are kept as two
 * separate, independent claims rather than one crowding out the other.
 */
export function appendPatternRecord(log, record, { capacity = DEFAULT_CAPACITY, bucketMs = HORIZON_MS } = {}) {
  if (!record) return log ?? [];
  const list = log ?? [];
  const bucket = Math.floor(record.at / bucketMs);

  const index = list.findIndex(
    (row) => row.bucket === bucket && row.patternKey === record.patternKey && row.won === null,
  );
  if (index >= 0) {
    const existing = list[index];
    const better = (record.quality ?? 0) > (existing.quality ?? 0);
    if (!better) return list;
    const next = [...list];
    next[index] = { ...record, bucket };
    return next;
  }

  const next = [...list, { ...record, bucket }];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/** Grades every record whose horizon has passed. Mirrors confluenceLog.js exactly. */
export function settlePatternRecords(
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
    return { ...record, won: (record.bias === 'bullish') === wentUp ? 1 : 0, settledAt: settle };
  });

  return { log: out, settled };
}

function bucketStats(rows) {
  const settled = rows.length;
  const wins = rows.reduce((total, row) => total + row.won, 0);
  return { settled, wins, winRate: settled > 0 ? wins / settled : null };
}

/**
 * Win rate per pattern type, plus overall — the reason this is split by key
 * rather than one aggregate number: "chart patterns are right 54% of the
 * time" mixes a Double Top that might be worth reading with a Bear Flag that
 * might not be, and hides which is which.
 */
export function patternWinRates(log, { minimumSettled = 15 } = {}) {
  const graded = (log ?? []).filter((row) => row.won !== null);
  const stats = (rows) => ({ ...bucketStats(rows), enough: rows.length >= minimumSettled });

  const keys = [...new Set(graded.map((row) => row.patternKey))].sort();
  return [
    { patternKey: 'overall', label: 'All patterns', ...stats(graded) },
    ...keys.map((key) => ({
      patternKey: key,
      label: graded.find((row) => row.patternKey === key)?.label ?? key,
      ...stats(graded.filter((row) => row.patternKey === key)),
    })),
  ];
}

/** The one line that says whether a pattern's track record is worth reading. */
export function patternVerdict(pattern) {
  if (!pattern?.enough) return 'not enough settled to say';
  if (pattern.winRate > 0.55) return 'ahead of a coin flip';
  if (pattern.winRate < 0.45) return 'behind a coin flip — worth reading the OTHER way, if anything';
  return 'no better than a coin flip';
}
