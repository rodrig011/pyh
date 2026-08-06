/**
 * Every market the bot passed on, and what it would have made.
 *
 * The complaint this answers, and it is a fair one: "I'll be furious if I find
 * out it missed trades." Until now that could not be checked. A refusal left no
 * trace beyond a counter, so "it is being appropriately careful" and "it is
 * throwing away money" produced the identical report, and the only way to argue
 * about a threshold was to argue.
 *
 * So every near miss is written down with the side it would have taken, and
 * graded when the contract settles. That turns the question from an argument
 * into a table: refused 40 for `no_edge`, and taking them would have returned
 * −6%; refused 12 for `wide_spread`, and taking THOSE would have returned +14%.
 * The first says the gate is doing its job. The second says the gate is the
 * most expensive line in the codebase, and nothing but this log can tell them
 * apart.
 *
 * Only NEAR misses are kept, on purpose. A market refused for having no price
 * is not a missed opportunity, it is an absence of information, and filling the
 * log with those would bury the handful of rows that mean something.
 */

export const DEFAULT_CAPACITY = 4000;

/** Refusals that could plausibly have been trades, and are worth grading. */
export const TUNEABLE_REASONS = new Set([
  'no_edge',
  'fee_eats_it',
  'vol_uncertain',
  'wide_spread',
  'thin_book',
  'trending',
  'priced_out',
  'too_late',
]);

/**
 * One near miss, or null when there is nothing worth recording.
 *
 * The side stored is the one the engine LEANED towards, because that is the
 * trade that would have been taken had the gate not fired. Storing the winning
 * side after the fact would make every gate look catastrophic.
 */
export function makeMiss({
  at,
  ticker,
  strike,
  reason,
  side,
  entryCents,
  spot,
  secondsLeft,
  edgeCents = null,
  modelProbability = null,
}) {
  if (!(at > 0) || !ticker || !(strike > 0)) return null;
  if (!TUNEABLE_REASONS.has(reason)) return null;
  if (side !== 'up' && side !== 'down') return null;
  if (!(entryCents > 0) || entryCents >= 100) return null;
  if (!(spot > 0)) return null;

  return {
    at,
    ticker,
    strike,
    reason,
    side,
    entryCents,
    spot,
    secondsLeft: Number.isFinite(secondsLeft) ? secondsLeft : null,
    edgeCents: Number.isFinite(edgeCents) ? edgeCents : null,
    modelProbability: Number.isFinite(modelProbability) ? modelProbability : null,
    // Filled in once the contract settles: 1 if the side would have won.
    won: null,
  };
}

/**
 * Adds a miss, keeping only the BEST look at each contract.
 *
 * A fifteen-minute market is refused about ninety times, and ninety rows for
 * one decision would drown the log and count one opinion ninety times over.
 * The row kept is the one with the most edge, which is the version of the
 * refusal most worth arguing with.
 */
export function appendMiss(log, miss, { capacity = DEFAULT_CAPACITY } = {}) {
  if (!miss) return log ?? [];
  const list = log ?? [];

  const index = list.findIndex((row) => row.ticker === miss.ticker && row.won === null);
  if (index >= 0) {
    const existing = list[index];
    const better = (miss.edgeCents ?? -Infinity) > (existing.edgeCents ?? -Infinity);
    if (!better) return list;
    const next = [...list];
    next[index] = miss;
    return next;
  }

  const next = [...list, miss];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/**
 * Grades every miss whose market has closed.
 *
 * The outcome comes from the spot this bot recorded around the bell, averaged
 * over the settlement window — the same rule the contract itself settles on.
 * It is not the exchange's own index, and that limitation is real: a market
 * that settled just over the strike can be graded just under. It adds noise,
 * symmetric noise, and it is the only source available without a paid feed.
 */
export function settleMisses(log, { now = Date.now(), samples = [], windowSeconds = 60 } = {}) {
  const priced = (samples ?? []).filter((sample) => sample?.at > 0 && sample?.price > 0);
  if (priced.length === 0) return log ?? [];

  return (log ?? []).map((miss) => {
    if (miss.won !== null) return miss;
    if (!Number.isFinite(miss.secondsLeft)) return miss;

    const closesAt = miss.at + miss.secondsLeft * 1000;
    // A grace period, so a market is not graded from the one sample that
    // happened to land early.
    if (now < closesAt + 30_000) return miss;

    const window = priced.filter(
      (sample) => sample.at >= closesAt - windowSeconds * 1000 && sample.at <= closesAt,
    );
    if (window.length === 0) return miss;

    const settle = window.reduce((total, sample) => total + sample.price, 0) / window.length;
    const above = settle > miss.strike;
    return { ...miss, won: (miss.side === 'up') === above ? 1 : 0, settledAt: settle };
  });
}

/**
 * What each gate actually cost, or saved.
 *
 * The return is per contract taken at the entry price the miss recorded: win
 * and it pays a hundred, lose and it pays nothing. Fees are left out on
 * purpose — this measures the GATE, and adding a cost that applies equally to
 * every row would only shift them all by the same amount while making the
 * number harder to reason about.
 */
export function missPatterns(log, { minimumSettled = 5 } = {}) {
  const byReason = new Map();

  for (const miss of log ?? []) {
    if (miss.won === null) continue;
    const row = byReason.get(miss.reason) ?? { reason: miss.reason, settled: 0, wins: 0, cents: 0 };
    row.settled += 1;
    row.wins += miss.won;
    // What one contract would have returned, in cents.
    row.cents += (miss.won ? 100 : 0) - miss.entryCents;
    byReason.set(miss.reason, row);
  }

  return [...byReason.values()]
    .map((row) => ({
      ...row,
      winRate: row.settled > 0 ? row.wins / row.settled : null,
      centsPerContract: row.settled > 0 ? row.cents / row.settled : null,
      // Below this, the number is a story rather than a measurement.
      enough: row.settled >= minimumSettled,
    }))
    .sort((a, b) => (b.centsPerContract ?? -Infinity) - (a.centsPerContract ?? -Infinity));
}

/** The one line that says whether a gate is earning its place. */
export function verdictFor(pattern) {
  if (!pattern?.enough) return 'not enough settled to say';
  if (pattern.centsPerContract > 2) return 'this gate is costing money';
  if (pattern.centsPerContract < -2) return 'this gate is saving money';
  return 'this gate is roughly neutral';
}
