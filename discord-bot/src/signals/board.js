import { VERDICTS } from './engine.js';
import { directionalRead } from './direction.js';

/**
 * Reading a whole board of strikes instead of one contract.
 *
 * The complaint that produced this file was "it skips every single market",
 * and the complaint was right. The diagnosis was not the one everybody
 * reaches for, though, so it is worth writing down: the thresholds were not
 * too strict. The engine was being shown one market at a time.
 *
 * Kalshi lists a ladder of strikes for each fifteen-minute window — all the
 * same asset, all the same bell, differing only in where the line is drawn.
 * The bot read whichever closed soonest, which is essentially a random member
 * of that ladder and, most of the time, one so far from the money that no
 * price on it was worth paying. Refusing it was correct. Concluding from it
 * that there was nothing to trade in the window was not.
 *
 * So this evaluates every strike, ranks the ones that clear the bar, and — the
 * part that matters as much as the ranking — keeps a census of why the rest
 * were refused. "Refused 41 markets" is not a diagnosis. "Refused 41: 30 no
 * edge, 8 priced out, 3 thin book" is, and it is the difference between an
 * engine that is working and an engine that is broken in a way nobody can see.
 */

/**
 * Every strike read, best first.
 *
 * `candidates` are `{ price, market }` as the exchange lists them. `context`
 * carries what is shared across the whole ladder: spot, the price history, how
 * long is left. Only the strike differs, which is the whole point.
 *
 * Pure. The board is handed in, so a day can be replayed from the log.
 */
export function readBoard(candidates, context, options = {}) {
  const reads = [];
  const census = new Map();

  for (const candidate of candidates ?? []) {
    const market = candidate?.market;
    // The exchange puts the strike on the market; a caller reading a single
    // known contract already has it. Either is accepted, because requiring the
    // exchange's field silently dropped every candidate that did not come
    // straight off the feed — the board came back empty and the account looked
    // like it had stopped looking at markets at all.
    const strike = Number(candidate?.strike ?? market?.floor_strike ?? market?.cap_strike);
    if (!(strike > 0) || !Number.isFinite(candidate?.price)) continue;

    const read = directionalRead(
      { ...context, strike, marketPriceCents: candidate.price, market },
      options,
    );

    reads.push({
      ticker: market?.ticker ?? null,
      strike,
      read,
    });

    if (!read.tradeable) {
      const reason = read.result?.reason ?? 'no read';
      census.set(reason, (census.get(reason) ?? 0) + 1);
    }
  }

  const tradeable = reads.filter((entry) => entry.read.tradeable);

  // Ranked by net edge, which is the only ordering that survives contact with
  // the fee schedule. Ranking by gross edge picks the cheap far-out strike
  // whose edge the exchange then eats, and ranking by model probability picks
  // whatever is nearest a sure thing regardless of what it costs.
  tradeable.sort(
    (a, b) => (b.read.netEdgeCents ?? -Infinity) - (a.read.netEdgeCents ?? -Infinity),
  );

  return {
    reads,
    tradeable,
    best: tradeable[0] ?? null,
    looked: reads.length,
    refused: reads.length - tradeable.length,
    // Sorted so the biggest reason is first: that is the one worth arguing
    // with, and the tail is noise.
    census: [...census].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * The strike nearest the money, whatever the engine thinks of it.
 *
 * Not for trading — for talking. A directional read published to a room should
 * be about the contract people are actually looking at, which is the one whose
 * price is nearest a coin flip, not whichever strike happened to offer the
 * fattest edge.
 */
export function nearestTheMoney(reads) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of reads ?? []) {
    const price = entry?.read?.result?.marketProbability;
    if (!Number.isFinite(price)) continue;
    const distance = Math.abs(price - 0.5);
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

/** The census as one line a person can read, biggest reason first. */
export function censusLine(census, { limit = 4 } = {}) {
  const shown = (census ?? []).slice(0, limit);
  if (shown.length === 0) return null;
  return shown.map(({ reason, count }) => `${count}× ${reason.replace(/_/g, ' ')}`).join(' · ');
}

/**
 * The refusals that mean the bot is broken rather than being careful.
 *
 * A census is only useful if somebody reads it, and nobody reads a list of
 * reasons they do not recognise. These three mean the engine never got the
 * inputs it needs — a missing clock, an unreadable price, no history — and a
 * run dominated by any of them is not an engine declining a bad market, it is
 * an engine that cannot see. That distinction went unnoticed for two deploys
 * because the report showed the count and left the reading to a human.
 */
export const BROKEN_REASONS = {
  no_clock: 'the feed is not saying when these markets close',
  no_price: 'the feed is not giving a usable price',
  no_vol: 'there is not enough stored price history yet',
};

export function brokenDiagnosis(census, { share = 0.5 } = {}) {
  const rows = census ?? [];
  const total = rows.reduce((sum, { count }) => sum + count, 0);
  if (total === 0) return null;

  for (const [reason, why] of Object.entries(BROKEN_REASONS)) {
    const count = rows.find((row) => row.reason === reason)?.count ?? 0;
    if (count / total >= share) {
      return {
        reason,
        count,
        total,
        message:
          `🔴 **This is not the engine being careful — ${why}.** ` +
          `${count} of ${total} refusals. Run \`/picks kalshi\` — it prints the raw fields.`,
      };
    }
  }
  return null;
}

/**
 * Whether a board is worth trading at all, as opposed to any single strike.
 *
 * The one refusal the person paying for this asked to keep: a market moving too
 * violently to read is a market to sit out, however much edge the arithmetic
 * claims. When most of the ladder is refused for reasons that all mean "the
 * volatility read cannot be trusted right now", that is not twelve independent
 * opinions — it is one condition, showing up twelve times, and the answer is to
 * stand aside rather than to take the one strike that slipped through.
 */
export const UNREADABLE = new Set(['trending', 'vol_uncertain', 'no_vol']);

export function boardIsUnreadable(board, { share = 0.6 } = {}) {
  if (!board || board.looked < 3) return false;
  const unreadable = (board.census ?? [])
    .filter(({ reason }) => UNREADABLE.has(reason))
    .reduce((total, { count }) => total + count, 0);
  return unreadable / board.looked >= share;
}

export { VERDICTS };
