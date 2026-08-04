import { feePerContract } from './math.js';

/**
 * Trading the same market more than once.
 *
 * Everything up to here counted one trade per market: enter, hold, settle. A
 * scalper does not do that. The contract price moves continuously for fifteen
 * minutes — 65, 78, 71, 88 — and each of those swings is a round trip
 * somebody can take. Four turns in one market is four times the compounding of
 * one, at the same size and the same edge, without touching the Kelly cap.
 *
 * That is the honest answer to "make it grow faster", and it comes with a hard
 * limit that nobody selling scalping signals ever mentions: the exchange is
 * paid on the way in AND on the way out. At mid prices that round trip costs
 * about 3¢, so a 4¢ swing is a losing trade that looks like a winning one, and
 * a room told to scalp every wiggle loses money while being right.
 *
 * These functions decide which swings are worth taking.
 */

/**
 * What one round trip costs, in cents of contract.
 *
 * Both legs, at their own prices — the fee is a function of price and peaks at
 * 50¢, so getting in cheap and out expensive is cheaper than the reverse.
 */
export function roundTripCostCents(entryCents, exitCents, { feeRate = 0.07 } = {}) {
  if (!(entryCents > 0) || !(exitCents > 0)) return null;
  const entryFee = feePerContract(entryCents / 100, feeRate) * 100;
  const exitFee = feePerContract(exitCents / 100, feeRate) * 100;
  return entryFee + exitFee;
}

/**
 * The smallest move that actually pays, from a given entry.
 *
 * This is the number that separates scalping from donating. Below it the
 * exchange keeps the profit, and the trade still shows green on a screen that
 * ignores fees — which is most of them.
 */
export function minimumProfitableMoveCents(entryCents, { feeRate = 0.07, marginCents = 0.5 } = {}) {
  if (!(entryCents > 0) || entryCents >= 100) return null;

  // The exit price is not known in advance, so solve it: step upward until the
  // gross move covers both legs plus a margin worth getting out of bed for.
  for (let exit = Math.ceil(entryCents) + 1; exit < 100; exit += 1) {
    const cost = roundTripCostCents(entryCents, exit, { feeRate });
    if (exit - entryCents - cost >= marginCents) return exit - entryCents;
  }
  return null;
}

/**
 * What a completed round trip actually returned.
 *
 * Net of both fees, expressed against the money that was at risk — which is
 * the entry price, not the contract's face value.
 */
export function roundTripReturn(entryCents, exitCents, { feeRate = 0.07 } = {}) {
  const cost = roundTripCostCents(entryCents, exitCents, { feeRate });
  if (cost === null || !(entryCents > 0)) return null;

  const gross = exitCents - entryCents;
  const net = gross - cost;

  return {
    grossCents: gross,
    feeCents: cost,
    netCents: net,
    percent: (net / entryCents) * 100,
    // The honest headline: a 5¢ move at mid prices is barely a trade.
    worthTaking: net > 0,
  };
}

export const SCALP_ACTIONS = { ENTER: 'enter', EXIT: 'exit', WAIT: 'wait' };

/**
 * The live call, checked every few seconds while a market runs.
 *
 * This is the "buy now / out now" the room actually wants, and it is a
 * different question from "is this market worth trading". That one is asked
 * once. This one is asked two hundred times per market, and it has to be
 * cheap, decisive, and honest about the fee it is spending each time.
 *
 * @param {object} state
 * @param {object|null} state.position what is currently held, or null
 * @param {number} state.nowCents the contract price this instant
 * @param {object} state.signal the engine's current read on this market
 * @param {number} state.secondsLeft
 */
export function scalpDecision({ position = null, nowCents, signal, secondsLeft }, options = {}) {
  const config = {
    feeRate: 0.07,
    // A swing must clear the round trip by this much before it is a trade.
    marginCents: 0.5,
    // No new entries this close to the bell: there is not enough room left for
    // a move to cover two fees.
    noEntryWithinSeconds: 120,
    ...options,
  };

  const say = (action, reason, extra = {}) => ({ action, reason, nowCents, ...extra });

  if (!Number.isFinite(nowCents) || nowCents <= 0 || nowCents >= 100) {
    return say(SCALP_ACTIONS.WAIT, 'no price');
  }

  if (position) {
    const trip = roundTripReturn(position.entryCents, nowCents, { feeRate: config.feeRate });

    // The engine no longer likes this side at all. Leave regardless of profit:
    // holding a position the model has stopped believing in is how a scalp
    // becomes a bag.
    if (signal?.verdict && signal.verdict !== position.side) {
      return say(SCALP_ACTIONS.EXIT, 'model flipped', { trip });
    }

    // Out of runway. A position held into the bell is no longer a scalp, it is
    // a settlement bet, and it was not sized as one.
    if (secondsLeft <= 45) return say(SCALP_ACTIONS.EXIT, 'bell', { trip });

    // The swing has paid for itself and then some.
    if (trip && trip.netCents >= config.marginCents && (signal?.edgeCents ?? 0) < 2) {
      return say(SCALP_ACTIONS.EXIT, 'move banked', { trip });
    }

    // Bleeding, and the model has stopped defending it.
    if (trip && trip.netCents < -config.marginCents * 4 && (signal?.edgeCents ?? 0) < 2) {
      return say(SCALP_ACTIONS.EXIT, 'cut', { trip });
    }

    return say(SCALP_ACTIONS.WAIT, 'holding', { trip });
  }

  if (secondsLeft < config.noEntryWithinSeconds) {
    return say(SCALP_ACTIONS.WAIT, 'too close to the bell for a round trip');
  }

  if (!signal || signal.verdict === 'skip') return say(SCALP_ACTIONS.WAIT, 'no edge');

  // An edge is necessary but not sufficient: it has to be bigger than what the
  // exchange takes for the trip. This single check is the difference between a
  // scalping engine and an expensive random number generator.
  const needed = minimumProfitableMoveCents(nowCents, {
    feeRate: config.feeRate,
    marginCents: config.marginCents,
  });
  if (needed === null || signal.edgeCents < needed) {
    return say(SCALP_ACTIONS.WAIT, 'edge smaller than the round trip', { needed });
  }

  return say(SCALP_ACTIONS.ENTER, 'edge clears the round trip', {
    side: signal.verdict,
    needed,
    edgeCents: signal.edgeCents,
  });
}

/**
 * How many round trips a market can actually support.
 *
 * The reason "scalp constantly" is bad advice: each trip costs two fees, and
 * fifteen minutes of a market that moves 8¢ in total cannot pay for four of
 * them. This says how many the movement on offer would actually fund.
 */
export function tripsSupported(expectedRangeCents, entryCents, options = {}) {
  const needed = minimumProfitableMoveCents(entryCents, options);
  if (!needed || !(expectedRangeCents > 0)) return 0;
  return Math.floor(expectedRangeCents / needed);
}
