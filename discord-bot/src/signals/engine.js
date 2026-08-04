import {
  expectedValue,
  logReturns,
  probabilityAbove,
  realizedVolatility,
  scaleVolatility,
} from './math.js';
import { bookQuality, distanceInSigma, largePrints, momentum, rsi, trendFit } from './indicators.js';

export const VERDICTS = { UP: 'up', DOWN: 'down', SKIP: 'skip' };

/**
 * Every reason the engine refuses, in the words a member should hear.
 *
 * Refusals are the product. Anyone can print an arrow; the number that moves a
 * win rate is how many bad markets never got an arrow at all.
 */
export const SKIP_REASONS = {
  no_price: 'The market has no usable price right now.',
  no_vol: 'Not enough price history yet to measure how fast this is moving.',
  wide_spread: 'The spread is wider than the whole edge — you pay it twice getting in and out.',
  thin_book: 'There is almost nothing resting on this book. A fill here moves the price against you.',
  no_edge: 'The market price is already fair. There is nothing to win here that is not a coin flip.',
  fee_eats_it: 'The edge is real but smaller than the fee. The exchange takes the profit.',
  too_late: 'Not enough time left for the move this needs.',
  priced_out: 'Being right pays almost nothing at this price.',
  trending: 'The move is too clean for a random-walk read — the model is least reliable here.',
};

export const DEFAULTS = {
  // How much the model must beat the market by, in cents of contract, before
  // anything is called. Below this the difference is the vol estimate wobbling.
  minimumEdgeCents: 4,
  maximumSpreadCents: 3,
  minimumLiquidityDollars: 25,
  minimumSecondsLeft: 45,
  // Above this price, a win pays too little to be worth the risk of a loss.
  maximumEntryCents: 92,
  minimumEntryCents: 4,
  // R² above this and the market is trending hard enough that a random-walk
  // probability is the wrong model.
  maximumTrendFit: 0.85,
  feeRate: 0.07,
  sampleSeconds: 30,
};

/**
 * Reads one market and says what to do about it.
 *
 * The shape of the answer is deliberate: a verdict, the model's probability,
 * the market's price, and the gap between them. Not a "confidence score" —
 * those are invented, and this one is checkable. When the model says 64 and
 * the contract costs 55, the claim is that the market is nine cents wrong, and
 * every one of those claims gets written down and scored later.
 *
 * Pure. It reads no clocks and no network, so the same inputs always produce
 * the same call and the record can be rebuilt from the snapshots.
 */
export function evaluate(input, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const {
    prices = [],
    spot = null,
    strike = null,
    marketPriceCents = null,
    market = null,
    secondsLeft = null,
    trades = [],
  } = input ?? {};

  const notes = [];
  const skip = (reason) => ({
    verdict: VERDICTS.SKIP,
    reason,
    explain: SKIP_REASONS[reason] ?? reason,
    notes,
  });

  const price = Number(spot ?? prices.at(-1));
  const book = bookQuality(market);

  if (!(price > 0) || !(strike > 0) || !Number.isFinite(marketPriceCents)) return skip('no_price');
  if (!(secondsLeft > 0)) return skip('too_late');
  if (secondsLeft < config.minimumSecondsLeft) return skip('too_late');

  if (marketPriceCents > config.maximumEntryCents || marketPriceCents < config.minimumEntryCents) {
    return skip('priced_out');
  }

  // How fast it is moving, and therefore how far it can plausibly travel in the
  // time that is left. Everything downstream rests on this number.
  const returns = logReturns(prices);
  const perSample = realizedVolatility(returns);
  if (!(perSample > 0)) return skip('no_vol');

  const sigma = scaleVolatility(perSample, config.sampleSeconds, secondsLeft);
  if (!(sigma > 0)) return skip('no_vol');

  const probability = probabilityAbove(price, strike, sigma);
  if (!Number.isFinite(probability)) return skip('no_vol');

  const trend = trendFit(prices.slice(-20));
  if (trend && trend.r2 > config.maximumTrendFit) {
    notes.push(`Trending hard (R²=${trend.r2.toFixed(2)}) — random-walk read is weakest here`);
    return skip('trending');
  }

  // The market's own probability is its price. The whole question is whether
  // ours is far enough from it to be worth acting on.
  const marketProbability = marketPriceCents / 100;
  const upEdgeCents = (probability - marketProbability) * 100;

  // Both sides of the same contract. Buying NO is buying the complement, and
  // it is priced at what is left of a dollar.
  const noPriceDollars = 1 - marketProbability;
  const upValue = expectedValue(probability, marketProbability, { feeRate: config.feeRate });
  const downValue = expectedValue(1 - probability, noPriceDollars, { feeRate: config.feeRate });

  const best =
    (upValue?.net ?? -Infinity) >= (downValue?.net ?? -Infinity)
      ? { side: VERDICTS.UP, value: upValue, entryCents: marketPriceCents }
      : { side: VERDICTS.DOWN, value: downValue, entryCents: 100 - marketPriceCents };

  if (Math.abs(upEdgeCents) < config.minimumEdgeCents) return skip('no_edge');
  if (!best.value || best.value.net <= 0) return skip('fee_eats_it');

  // Only now does the book matter — there is no point rejecting a market for
  // its spread before knowing whether it had an edge to lose.
  if (book.spreadCents !== null && book.spreadCents > config.maximumSpreadCents) {
    notes.push(`Spread ${book.spreadCents.toFixed(1)}¢ against an edge of ${Math.abs(upEdgeCents).toFixed(1)}¢`);
    return skip('wide_spread');
  }
  if (
    book.liquidityDollars !== null &&
    book.liquidityDollars < config.minimumLiquidityDollars
  ) {
    return skip('thin_book');
  }

  const flow = largePrints(trades);
  if (flow.count > 0) {
    notes.push(
      `${flow.count} large print(s) — ${flow.boughtBtc.toFixed(1)} BTC bought vs ${flow.soldBtc.toFixed(1)} sold`,
    );
  }

  return {
    verdict: best.side,
    // What the maths says, against what the market charges. Both published,
    // because a signal that only shows one of them cannot be argued with.
    probability,
    marketProbability,
    edgeCents: Math.abs(upEdgeCents),
    entryCents: best.entryCents,
    expected: best.value,
    sigma,
    distanceSigma: distanceInSigma(price, strike, sigma),
    secondsLeft,
    book,
    flow,
    context: {
      rsi: rsi(prices),
      momentumPercent: momentum(prices.slice(-20)),
      trendFit: trend?.r2 ?? null,
    },
    notes,
  };
}

/**
 * How the engine has actually done, at each level of claimed probability.
 *
 * This is the part nobody publishes. A signal that says 80% should land four
 * times in five; if it lands three times in five, the number is decoration and
 * the room deserves to know. Buckets rather than a single win rate, because an
 * engine can be right overall and badly wrong at the confident end — which is
 * exactly where people size up.
 */
export function calibration(records, { buckets = [50, 60, 70, 80, 90, 100] } = {}) {
  const rows = [];

  for (let i = 0; i < buckets.length - 1; i += 1) {
    const from = buckets[i];
    const to = buckets[i + 1];
    const inBucket = (records ?? []).filter((record) => {
      const claimed = record?.probability * 100;
      return Number.isFinite(claimed) && claimed >= from && claimed < to && record.won !== undefined;
    });

    if (inBucket.length === 0) continue;
    const won = inBucket.filter((record) => record.won).length;

    rows.push({
      from,
      to,
      samples: inBucket.length,
      claimed: inBucket.reduce((total, r) => total + r.probability * 100, 0) / inBucket.length,
      actual: (won / inBucket.length) * 100,
      // Positive means the engine promised more than it delivered.
      overconfidencePoints:
        inBucket.reduce((total, r) => total + r.probability * 100, 0) / inBucket.length -
        (won / inBucket.length) * 100,
    });
  }

  const scored = (records ?? []).filter((record) => record?.won !== undefined);
  return {
    rows,
    samples: scored.length,
    // Brier score: the standard measure for probabilistic forecasts. 0 is
    // perfect, 0.25 is what you get by saying 50% to everything. A signal
    // engine that cannot beat 0.25 is worse than a coin and should say so.
    brier:
      scored.length === 0
        ? null
        : scored.reduce(
            (total, record) => total + (record.probability - (record.won ? 1 : 0)) ** 2,
            0,
          ) / scored.length,
  };
}
