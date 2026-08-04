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
 * The model's odds for the side currently held, in the held side's own terms.
 *
 * `probability` from the engine is always the chance of finishing ABOVE the
 * strike. A DOWN position wins on the complement, and comparing the wrong one
 * of the two against the price is how a winning position gets sold.
 *
 * Returns null when the engine had no read at all (no price, no history) —
 * which is a genuine "I do not know", and different from "no edge".
 */
export function heldProbability(side, signal) {
  const p = signal?.probability;
  if (!Number.isFinite(p)) return null;
  return side === 'down' ? 1 - p : p;
}

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
    // When a held position has to be decided: sell, or let it settle.
    bellSeconds: 45,
    ...options,
  };

  const say = (action, reason, extra = {}) => ({ action, reason, nowCents, ...extra });

  if (!Number.isFinite(nowCents) || nowCents <= 0 || nowCents >= 100) {
    return say(SCALP_ACTIONS.WAIT, 'no price');
  }

  if (position) {
    const trip = roundTripReturn(position.entryCents, nowCents, { feeRate: config.feeRate });

    // What the model now thinks of the side actually held, whether or not it
    // has an opinion strong enough to open a NEW position with. These are two
    // different questions and conflating them is expensive: the engine goes
    // quiet the moment the edge falls under its entry threshold, which is most
    // of the time, and reading that silence as "get out" turns every position
    // into a guaranteed round trip that pays two fees to capture nothing.
    const held = heldProbability(position.side, signal);
    const favoured = held === null ? null : held * 100 - nowCents;

    // A real reversal: the engine is calling the OTHER side outright. That is
    // worth paying a fee to escape. Silence is not.
    if (signal?.verdict && signal.verdict !== 'skip' && signal.verdict !== position.side) {
      return say(SCALP_ACTIONS.EXIT, 'model flipped', { trip, favoured });
    }

    // Out of runway — sell, or let it settle?
    //
    // Settlement is the one exit the exchange does not charge for. And with no
    // model read left (the engine stops reading a market this close to the
    // bell) the contract's own price IS the best estimate of what it settles
    // at, so the two outcomes have the same expected value and the fee is the
    // only difference. Holding wins by exactly that fee. Sell only when the
    // model actively says the side is now worth less than it costs.
    //
    // This is the opposite of the usual "always flatten before expiry" advice,
    // and on a fee-per-leg exchange the usual advice is simply wrong.
    if (secondsLeft <= config.bellSeconds) {
      if (favoured === null || favoured >= 0) {
        return say(SCALP_ACTIONS.WAIT, 'settling', { trip, favoured });
      }
      return say(SCALP_ACTIONS.EXIT, 'bell', { trip, favoured });
    }

    // Both of the remaining exits need the model to have an opinion and for
    // that opinion to be against the price. Treating "no read" as a reason to
    // sell is what made every position a guaranteed round trip.
    const defended = favoured === null || favoured >= config.marginCents;

    // The swing has paid for itself and the model no longer defends the price.
    // A position still trading below what the model says it is worth is not a
    // profit to bank, it is a position.
    if (trip && trip.netCents >= config.marginCents && !defended) {
      return say(SCALP_ACTIONS.EXIT, 'move banked', { trip, favoured });
    }

    // Bleeding, and the model has stopped defending it.
    if (trip && trip.netCents < -config.marginCents * 4 && !defended) {
      return say(SCALP_ACTIONS.EXIT, 'cut', { trip, favoured });
    }

    return say(SCALP_ACTIONS.WAIT, 'holding', { trip, favoured });
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
