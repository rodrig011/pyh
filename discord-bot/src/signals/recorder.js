import { priceContext } from './collector.js';
import { quoteCents } from './cost.js';
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
import { closeTimeOf, officialSettlementOf, strikeOf } from '../picks/kalshi.js';
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
  evidence = null,
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
    evidence,
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
 * A local BRTI-window estimate is provisional so the ledger can update quickly.
 * The official Kalshi market result always wins once it is available; the audit
 * below replaces even an already-filled provisional outcome.
 */
export function settleObservations(
  log,
  { now = Date.now(), settledBefore = 60_000, samples = [], officialResults = {} } = {},
) {
  // When each market actually closed, from any observation of it: the moment
  // it was seen plus the time it had left.
  //
  // This replaces waiting to observe secondsLeft hitting zero, which never
  // happened and meant nothing ever settled. The recorder reads whichever
  // market is OPEN, so the instant one closes the exchange hands back the next
  // one — the final seconds of the old ticker are never seen at all. Nine
  // hundred quotes had accumulated with not a single graded market.
  const closesAt = new Map();
  for (const row of log) {
    if (!Number.isFinite(row?.secondsLeft)) continue;
    const closes = row.at + row.secondsLeft * 1000;
    const known = closesAt.get(row.ticker);
    // The latest observation has the least guesswork in it.
    if (!known || row.at > known.at) closesAt.set(row.ticker, { closes, at: row.at });
  }

  // Spot prices, in order, so a market can be graded on where the index
  // actually was when it closed rather than on the last quote before it.
  const priced = (samples ?? [])
    .filter((sample) => sample?.at > 0 && sample?.price > 0)
    .sort((a, b) => a.at - b.at);

  /**
   * The settlement value: the average of the final sixty seconds, which is how
   * Kalshi settles these. Falls back to the nearest single sample when the
   * window is empty, and to nothing at all when there is no sample near the
   * close — grading a market on a price from ten minutes earlier would be
   * worse than leaving it ungraded.
   */
  const settlementSpot = (closes) => {
    const window = priced.filter((s) => s.at > closes - 60_000 && s.at <= closes + 5_000);
    if (window.length > 0) {
      return window.reduce((total, s) => total + s.price, 0) / window.length;
    }
    const nearest = priced.reduce(
      (best, s) =>
        best === null || Math.abs(s.at - closes) < Math.abs(best.at - closes) ? s : best,
      null,
    );
    return nearest && Math.abs(nearest.at - closes) < 5 * 60_000 ? nearest.price : null;
  };

  const finalSpot = new Map();
  for (const [ticker, { closes }] of closesAt) {
    if (now - closes <= settledBefore) continue;
    const spot = settlementSpot(closes);
    if (spot !== null) finalSpot.set(ticker, spot);
  }

  let settled = 0;
  const out = log.map((row) => {
    const official = officialResults?.[row.ticker];
    if (official === 0 || official === 1) {
      const changed = row.outcome !== official || row.outcomeSource !== 'kalshi-market:official-result';
      if (changed) settled += 1;
      return { ...row, outcome: official, outcomeSource: 'kalshi-market:official-result' };
    }
    if (row.outcome !== null) return row;
    const spot = finalSpot.get(row.ticker);
    if (spot === undefined) return row;

    settled += 1;
    return { ...row, outcome: spot > row.strike ? 1 : 0, outcomeSource: 'local-brti-window:provisional' };
  });

  return { log: out, settled };
}

/** Gradually replaces provisional outcomes with each contract's official result. */
export async function auditOfficialObservationOutcomes(
  log,
  { fetchMarket, settings, now = Date.now(), settledBefore = 60_000, limit = 3 } = {},
) {
  if (typeof fetchMarket !== 'function') return { log, corrected: 0, checked: 0 };
  const due = new Map();
  for (const row of log ?? []) {
    if (!row?.ticker || row.outcomeSource === 'kalshi-market:official-result') continue;
    const closesAt = row.at + row.secondsLeft * 1000;
    if (!(now - closesAt > settledBefore)) continue;
    const known = due.get(row.ticker);
    if (!known || closesAt > known) due.set(row.ticker, closesAt);
  }
  const tickers = [...due.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([ticker]) => ticker);
  const officialResults = {};
  await Promise.all(tickers.map(async (ticker) => {
    const response = await fetchMarket(settings, ticker).catch(() => null);
    const settlement = officialSettlementOf(response?.market);
    if (settlement?.ticker === ticker) officialResults[ticker] = settlement.result === 'yes' ? 1 : 0;
  }));
  const before = new Map((log ?? []).map((row) => [`${row.ticker}:${row.at}`, row.outcome]));
  const result = settleObservations(log ?? [], { now, officialResults, samples: [] });
  const corrected = result.log.filter((row) =>
    row.outcomeSource === 'kalshi-market:official-result' &&
    before.get(`${row.ticker}:${row.at}`) !== row.outcome,
  ).length;
  return { log: result.log, corrected, checked: tickers.length };
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
  { asset = 'BTC', contract, spot, quote = null, trades = [], evaluateModel, historyMs = 60 * 60 * 1000, now = Date.now() } = {},
) {
  let modelProbability = null;
  let sigmas = null;
  let evidence = { source: quote?.source ?? null, sourceAt: quote?.sourceAt ?? null,
    feedVersion: quote?.feedVersion ?? null, tradeCount: trades.length };
  const context = priceContext(store.listSamples(asset), quote ?? { price: spot }, { now });

  try {
    const market = contract?.market;
    if (market) {
      sigmas = allVolatilityReadings(logReturns(context.prices));
    }
    if (market && typeof evaluateModel === 'function') {
      const closesAt = closeTimeOf(market);
      const read = evaluateModel({
        ...context,
        spot,
        strike: contract.strike ?? strikeOf(market),
        marketPriceCents: contract.price,
        market,
        trades,
        secondsLeft: Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null,
      });
      if (Number.isFinite(read?.probability)) modelProbability = read.probability;
      evidence = { ...evidence, features: read?.quant?.features ?? null,
        confidence: read?.quant?.confidence ?? null, missing: read?.quant?.missing ?? [],
        verdict: read?.verdict ?? null, reason: read?.reason ?? null,
        bookAt: market.book_at ?? null };
    }
  } catch {
    // A model that throws must not stop the quote being written down. The
    // quote is the part that cannot be recovered later.
    modelProbability = null;
  }

  return recordOnce(store, { asset, contract, spot, modelProbability, sigmas, evidence, now });
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
  { asset = 'BTC', contract, spot, modelProbability = null, sigmas = null, evidence = null, now = Date.now() } = {},
) {
  try {
    const market = contract?.market;
    if (!market) return { recorded: false, reason: contract?.error ?? 'no market' };

    const closesAt = closeTimeOf(market);
    const observation = makeObservation({
      at: now,
      ticker: market.ticker,
      asset,
      spot,
      strike: contract.strike ?? strikeOf(market),
      yesBidCents: quoteCents(market, 'yes_bid'),
      yesAskCents: quoteCents(market, 'yes_ask'),
      secondsLeft: Number.isFinite(closesAt) ? Math.max(0, (closesAt - now) / 1000) : null,
      modelProbability,
      sigmas,
      evidence,
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
