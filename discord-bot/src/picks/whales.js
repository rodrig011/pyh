import { DEFAULT_API_BASE, isPriceCents } from './kalshi.js';

/**
 * Who is actually taking size, and whether the contract is about to flip.
 *
 * There was already a `largePrints` function in the indicators, and it had
 * never been given a single trade to look at — every call site passed an empty
 * array. It computed a lean from nothing and reported zero, forever. So the
 * "whale" reading in this codebase was decoration.
 *
 * This one reads the exchange's own trade tape. That choice matters: a whale in
 * BTC spot is interesting, but a whale in THIS CONTRACT is the thing that
 * actually moves the price being traded, and it is the one that predicts a flip.
 * Somebody lifting four hundred contracts on the NO side is a statement about
 * this fifteen-minute window specifically, in a way that a large spot print an
 * exchange away is not.
 *
 * The honest limit, stated up front: a trade tape shows size and which side
 * crossed the spread. It does not show who, or why, or whether they are right.
 * A whale is evidence about pressure, not about outcome, and every reading here
 * is phrased that way.
 */

/** Contracts in a single print before it counts as size rather than noise. */
export const WHALE_CONTRACTS = 250;

/**
 * Recent trades on one market.
 *
 * Public market data — no signature, no key. Never throws: a tape that is down
 * costs the whale reading, not the signal.
 */
export async function fetchTrades(
  settings,
  ticker,
  { fetchImpl = globalThis.fetch, timeoutMs = 5000, limit = 100 } = {},
) {
  if (!ticker) return { trades: [], error: 'no ticker' };
  const base = settings?.apiBase ?? DEFAULT_API_BASE;
  const url = `${base}/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { trades: [], error: `HTTP ${response.status}`, url };
    const body = await response.json();
    return { trades: body?.trades ?? [], error: null, url };
  } catch (error) {
    return {
      trades: [],
      error: error.name === 'AbortError' ? 'timed out' : error.message,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the tape says, folded into one reading.
 *
 * `taker_side` is the side that crossed the spread — the aggressor. That is the
 * one worth counting: a resting order that got hit was not making a statement,
 * the order that reached across was.
 */
export function whaleActivity(trades, { minimumContracts = WHALE_CONTRACTS, since = null } = {}) {
  const rows = (trades ?? [])
    .map((trade) => {
      const at = Date.parse(trade?.created_time ?? trade?.created_at ?? '') || null;
      const count = Number(trade?.count ?? trade?.size);
      const side = trade?.taker_side === 'no' ? 'no' : trade?.taker_side === 'yes' ? 'yes' : null;
      const priceCents = Number(trade?.yes_price ?? trade?.price);
      return { at, count, side, priceCents: isPriceCents(priceCents) ? priceCents : null };
    })
    .filter((trade) => Number.isFinite(trade.count) && trade.count > 0 && trade.side !== null)
    .filter((trade) => since === null || trade.at === null || trade.at >= since);

  const big = rows.filter((trade) => trade.count >= minimumContracts);

  const yesContracts = big
    .filter((trade) => trade.side === 'yes')
    .reduce((total, trade) => total + trade.count, 0);
  const noContracts = big
    .filter((trade) => trade.side === 'no')
    .reduce((total, trade) => total + trade.count, 0);
  const total = yesContracts + noContracts;

  return {
    trades: rows.length,
    count: big.length,
    yesContracts,
    noContracts,
    // Which way the size leaned, −1 (all NO) to +1 (all YES). Zero when they
    // cancel, which is most of the time and is itself worth knowing: two whales
    // disagreeing is not a signal, it is a market.
    lean: total === 0 ? 0 : (yesContracts - noContracts) / total,
    contracts: total,
    biggest: big.reduce((best, trade) => (best === null || trade.count > best.count ? trade : best), null),
    // Dollars of notional in the big prints, which is what makes "whale" mean
    // something to a person rather than a contract count.
    notionalDollars: big.reduce(
      (total_, trade) => total_ + trade.count * ((trade.priceCents ?? 50) / 100),
      0,
    ),
  };
}

export const FLIP_RISK = { NONE: 'none', WATCH: 'watch', HIGH: 'high' };

/**
 * The odds this position turns around before the bell, and why.
 *
 * Two independent things are combined, and they are kept separate in the output
 * because they fail differently:
 *
 *   - `flipProbability`, which the engine already computes: the chance the
 *     price touches the strike again before settlement. It is pure arithmetic
 *     on the volatility and the distance, and on a fifteen-minute contract it
 *     is roughly TWICE what the finishing probability suggests — which is the
 *     single most counter-intuitive number in this whole system.
 *   - Whale pressure AGAINST the side held. Size crossing the spread the other
 *     way is not proof of anything, but it is the thing that moves a price in
 *     the next two minutes.
 *
 * A flip is only a risk if there is a side to lose. With no position and no
 * call, this is information rather than a warning.
 */
export function flipRisk({ side = null, flipProbability = null, whales = null, secondsLeft = null } = {}) {
  const reasons = [];
  let score = 0;

  if (Number.isFinite(flipProbability)) {
    if (flipProbability >= 0.5) {
      score += 2;
      reasons.push(`${Math.round(flipProbability * 100)}% chance it touches the strike again`);
    } else if (flipProbability >= 0.3) {
      score += 1;
      reasons.push(`${Math.round(flipProbability * 100)}% chance it comes back to the strike`);
    }
  }

  // Pressure is only "against" once there is a side. `lean` is positive for YES.
  if (whales && whales.count > 0 && side) {
    const against = side === 'up' ? -whales.lean : whales.lean;
    if (against >= 0.6) {
      score += 2;
      reasons.push(
        `${whales.count} large print(s) leaning ${side === 'up' ? 'DOWN' : 'UP'} — ` +
          `${whales.contracts.toLocaleString('en-US')} contracts against you`,
      );
    } else if (against >= 0.25) {
      score += 1;
      reasons.push(`large prints leaning against this side`);
    } else if (against <= -0.6) {
      // Size on the same side. Not a reason to relax — a whale is evidence
      // about pressure, not about outcome — but it is worth not calling this a
      // risk when the flow agrees.
      reasons.push(`${whales.count} large print(s) on YOUR side`);
      score -= 1;
    }
  }

  // Close to the bell there is less time for anything to come back, which cuts
  // both ways: the flip is less likely, and there is less room to recover if it
  // happens. The arithmetic already accounts for the first through
  // flipProbability, so this only softens the verdict.
  if (Number.isFinite(secondsLeft) && secondsLeft < 90 && score > 0) {
    score -= 1;
    reasons.push('under 90 seconds left, so there is little room for it to turn');
  }

  const level = score >= 3 ? FLIP_RISK.HIGH : score >= 1 ? FLIP_RISK.WATCH : FLIP_RISK.NONE;
  return { level, score, reasons, flipProbability, whales };
}

/** One line a person can read in the two seconds they will give it. */
export function whaleLine(whales) {
  if (!whales || whales.count === 0) return null;
  const side = whales.lean > 0.1 ? 'UP' : whales.lean < -0.1 ? 'DOWN' : 'split';
  const money = Math.round(whales.notionalDollars);

  if (side === 'split') {
    return `🐋 **${whales.count} large print(s)**, both ways — $${money.toLocaleString('en-US')} traded, no clear side.`;
  }
  return (
    `🐋 **${whales.count} large print(s) leaning ${side}** — ` +
    `$${money.toLocaleString('en-US')} of size crossed the spread.`
  );
}
