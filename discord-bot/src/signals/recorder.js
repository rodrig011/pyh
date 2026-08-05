/**
 * Writing down what the market actually charged, so the one question that
 * matters can eventually be answered with data instead of opinion.
 *
 * Everything else in this engine is a claim. The claim is that Kalshi's price
 * for a 15-minute BTC contract is sometimes wrong, and that this model can see
 * when. Nobody knows whether that is true — not me, and not anyone who has not
 * measured it. A simulation cannot settle it, because a simulation only
 * contains the mispricing its author put there.
 *
 * What settles it: record the quote and the model's read at each moment, wait
 * for the market to settle, and score both against what happened. Two Brier
 * scores. If the market's is lower, there is no business here, and finding
 * that out from a few thousand free observations is enormously cheaper than
 * finding it out from a drawdown.
 *
 * Cheap on purpose — one small object every sample — because this has to run
 * on the box that is already running, alongside everything else, for weeks.
 */

import { logReturns } from './math.js';
import {
  bipowerVolatility,
  ewmaVolatility,
  harVolatility,
  plainVolatility,
  volatilityEstimate,
} from './volatility.js';

export const DEFAULT_CAPACITY = 20000;

/**
 * What every candidate estimator says, right now.
 *
 * Cheap — a few dozen arithmetic operations on an array already in memory —
 * and it turns "which estimator is better" from an argument into a
 * measurement that a fortnight of real markets will settle.
 */
export function allVolatilityReadings(returns) {
  const clean = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  const readings = {
    blend: clean(volatilityEstimate(returns)?.sigma),
    ewma: clean(ewmaVolatility(returns)),
    realized: clean(plainVolatility(returns)),
    bipower: clean(bipowerVolatility(returns)),
    har: clean(harVolatility(returns, { robust: false })),
    harRobust: clean(harVolatility(returns, { robust: true })),
  };
  return Object.values(readings).some((value) => value !== null) ? readings : null;
}

/**
 * One observation: what was quoted, what the model thought, what the state of
 * the world was. Deliberately flat and small.
 */
export function makeObservation({
  at,
  ticker,
  asset = 'BTC',
  spot,
  strike,
  yesBidCents,
  yesAskCents,
  secondsLeft,
  modelProbability = null,
  sigmas = null,
}) {
  if (!(at > 0) || !ticker || !(spot > 0) || !(strike > 0)) return null;
  if (!(secondsLeft >= 0)) return null;

  const bid = Number(yesBidCents);
  const ask = Number(yesAskCents);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;

  return {
    at,
    ticker,
    asset,
    spot,
    strike,
    bid,
    ask,
    secondsLeft,
    // May be null: the model needs history the bot might not have yet, and an
    // observation is still worth keeping without it — the market's own score
    // can be computed from the quote alone.
    model: Number.isFinite(modelProbability) ? modelProbability : null,
    // Every volatility estimator's reading, side by side.
    //
    // Which estimator is best is a genuinely open question that simulation
    // cannot answer: a simulated world's volatility reverts to whatever level
    // its author chose, which quietly favours whichever estimator matches that
    // choice. Real bitcoin has regimes that persist for hours without
    // reverting to anything. So instead of arguing, record what each one said
    // at the moment it said it, and let a fortnight of settled markets pick
    // the winner. Sigmas rather than probabilities, because any probability
    // can be recomputed from these and a probability cannot be undone.
    sigmas: sigmas ?? null,
    // Filled in later, once the market has settled.
    outcome: null,
  };
}

/** Appends, refusing duplicates and keeping the log bounded. */
export function appendObservation(log, observation, { capacity = DEFAULT_CAPACITY } = {}) {
  if (!observation) return log;

  const previous = log.at(-1);
  // The loop runs every few seconds and the market does not always move. One
  // observation per ticker per second is plenty and stops a stall from filling
  // the log with the same row.
  if (previous && previous.ticker === observation.ticker && observation.at - previous.at < 1000) {
    return log;
  }

  const next = [...log, observation];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/**
 * Marks every observation of a finished market with what actually happened.
 *
 * The outcome is decided by the spot the bot itself recorded, not by asking the
 * exchange. That is a real limitation and it is written down rather than hidden:
 * Kalshi settles against its own index, and if that index differs from the spot
 * feed here, a market that settled just over the strike can be scored as just
 * under. It biases nothing on average — the disagreement is symmetric — but it
 * adds noise, and near-the-money observations are where it lands hardest.
 */
export function settleObservations(log, { now = Date.now(), settledBefore = 60_000 } = {}) {
  // The last spot seen for each market is the best available reading of where
  // it finished.
  const finalSpot = new Map();
  for (const row of log) {
    const seen = finalSpot.get(row.ticker);
    if (!seen || row.at > seen.at) finalSpot.set(row.ticker, row);
  }

  let settled = 0;
  const out = log.map((row) => {
    if (row.outcome !== null) return row;

    const last = finalSpot.get(row.ticker);
    // Only score a market that is comfortably finished, so a contract still
    // trading is never graded on a price from the middle of its life.
    const closed = last && last.secondsLeft <= 0 && now - last.at > settledBefore;
    if (!closed) return row;

    settled += 1;
    return { ...row, outcome: last.spot > row.strike ? 1 : 0 };
  });

  return { log: out, settled };
}

/**
 * One observation, with the model's own read attached.
 *
 * The reason this exists rather than the caller doing it inline: recording the
 * quote alone answers only half the question. "Is Kalshi biased" is worth
 * knowing, but the question the whole engine rests on is "does OUR number beat
 * theirs", and that cannot be reconstructed later — the model's probability
 * depends on the price history as it stood at that instant, and an hour later
 * that moment is gone.
 *
 * The model may legitimately have no opinion: too early in the market, not
 * enough history yet, a price off the board. Those rows are still worth
 * keeping, because the market's own score can be computed from the quote
 * alone. A null here means "no read", never "fifty-fifty".
 */
export function observeOnce(
  store,
  { asset = 'BTC', contract, spot, evaluateModel, historyMs = 60 * 60 * 1000, now = Date.now() } = {},
) {
  let modelProbability = null;
  let sigmas = null;

  try {
    const market = contract?.market;
    if (market) {
      sigmas = allVolatilityReadings(logReturns(pricesFrom(store.listSamples(asset), now - historyMs)));
    }
    if (market && typeof evaluateModel === 'function') {
      const closesAt = Date.parse(market.close_time ?? '');
      const read = evaluateModel({
        prices: pricesFrom(store.listSamples(asset), now - historyMs),
        spot,
        strike: Number(market.floor_strike ?? market.cap_strike),
        marketPriceCents: contract.price,
        market,
        secondsLeft: Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null,
      });
      if (Number.isFinite(read?.probability)) modelProbability = read.probability;
    }
  } catch {
    // A model that throws must not stop the quote being written down. The
    // quote is the part that cannot be recovered later.
    modelProbability = null;
  }

  return recordOnce(store, { asset, contract, spot, modelProbability, sigmas, now });
}

/** Prices from stored samples, newest last, from `since` onward. */
function pricesFrom(samples, since) {
  return (samples ?? [])
    .filter((sample) => sample?.at >= since && sample?.price > 0)
    .map((sample) => sample.price);
}

/**
 * One pass of the recorder, to be called from a loop that already exists.
 *
 * Returns rather than throws: this runs beside the part of the system that
 * handles people's money, and a bad quote must never be able to stop it.
 */
export function recordOnce(
  store,
  { asset = 'BTC', contract, spot, modelProbability = null, sigmas = null, now = Date.now() } = {},
) {
  try {
    const market = contract?.market;
    if (!market) return { recorded: false, reason: contract?.error ?? 'no market' };

    const toCents = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return n > 0 && n <= 1 ? n * 100 : n;
    };

    const closesAt = Date.parse(market.close_time ?? '');
    const observation = makeObservation({
      at: now,
      ticker: market.ticker,
      asset,
      spot,
      strike: Number(market.floor_strike ?? market.cap_strike),
      yesBidCents: toCents(market.yes_bid_dollars ?? market.yes_bid),
      yesAskCents: toCents(market.yes_ask_dollars ?? market.yes_ask),
      secondsLeft: Number.isFinite(closesAt) ? Math.max(0, (closesAt - now) / 1000) : null,
      modelProbability,
      sigmas,
    });

    if (!observation) return { recorded: false, reason: 'incomplete quote' };

    const before = store.listQuotes(asset);
    const after = appendObservation(before, observation);
    if (after === before) return { recorded: false, reason: 'too soon' };

    store.putQuotes(asset, after);
    return { recorded: true, ticker: observation.ticker, count: after.length };
  } catch (error) {
    return { recorded: false, reason: error.message };
  }
}
