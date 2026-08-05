import { expectedValue, logReturns, probabilityAbove, scaleVolatility } from './math.js';
import { executablePrices, netEdgeCents } from './cost.js';
import { effectiveSecondsLeft } from './settlement.js';
import { volatilityEstimate } from './volatility.js';
import { flipProbability } from './exit.js';
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
  vol_uncertain:
    'The edge only exists if the volatility read is exactly right. Too thin to bet on being lucky.',
};

export const DEFAULTS = {
  // How much the model must beat the market by, in cents of contract, before
  // anything is called. Below this the difference is the vol estimate wobbling.
  //
  // Six, not four, and the reason is arithmetic rather than taste: the standard
  // error of a volatility measured from ~90 samples is around σ/√(2n) ≈ 7.5% of
  // σ, which moves the probability by three to four cents on its own. A four
  // cent threshold therefore fires on the estimate's own noise, and the paper
  // runs show exactly that — against a market that is never wrong it traded 88
  // times per 300 markets and lost 9% to fees, while at six it trades 27 times
  // and finishes flat. The edge it captures when there IS one is unchanged.
  minimumEdgeCents: 6,
  // What the edge must still be if the volatility read is wrong in the
  // direction that hurts. A named number rather than a fraction of the one
  // above: how much of the edge may depend on the estimate being right is a
  // real decision, not an implementation detail.
  minimumWorstCaseEdgeCents: 2,
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
  // Kalshi settles crypto contracts on a 60-second average of the CME CF
  // Real-Time Index. Switchable so the correction can be measured rather than
  // believed, but it is a fact about the contract, not a modelling taste.
  settlementAveraging: true,
  settlementWindowSeconds: 60,
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
  // Refusals that happen after the probability is known carry it anyway.
  // "No edge worth entering" and "get out of what you are holding" are
  // different questions, and answering the first with silence left the exit
  // logic unable to tell a reversal from a shrug — so it sold on both.
  const skip = (reason, extra = {}) => ({
    verdict: VERDICTS.SKIP,
    reason,
    explain: SKIP_REASONS[reason] ?? reason,
    notes,
    ...extra,
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
  // time that is left. Everything downstream rests on this number, so it comes
  // with the error bar it actually has rather than as a single confident value.
  const returns = logReturns(prices);
  const vol = volatilityEstimate(returns);
  if (!vol || !(vol.sigma > 0)) return skip('no_vol');

  // Kalshi settles crypto on the AVERAGE of the final sixty seconds, not on the
  // price at the bell. An average-settled contract has the same variance as a
  // point-settled one with forty seconds less on the clock, so scaling the
  // volatility by the raw clock overstates how far the price can still travel —
  // by 2% at the open and 18% with two minutes left, which is around five cents
  // of probability exactly where this engine trades.
  const horizonSeconds = config.settlementAveraging
    ? effectiveSecondsLeft(secondsLeft, config.settlementWindowSeconds)
    : secondsLeft;

  const sigma = scaleVolatility(vol.sigma, config.sampleSeconds, horizonSeconds);
  const sigmaLow = scaleVolatility(vol.low, config.sampleSeconds, horizonSeconds);
  const sigmaHigh = scaleVolatility(vol.high, config.sampleSeconds, horizonSeconds);
  if (!(sigma > 0)) return skip('no_vol');

  const probability = probabilityAbove(price, strike, sigma);
  if (!Number.isFinite(probability)) return skip('no_vol');

  // The same call under both ends of the volatility estimate. A market that is
  // only worth taking when the vol guess lands exactly right is not worth
  // taking — this is where a model that backtests well starts failing live.
  const probabilityRange = [
    probabilityAbove(price, strike, sigmaHigh),
    probabilityAbove(price, strike, sigmaLow),
  ]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (vol.jumpShare > 0.6) {
    notes.push(`${Math.round(vol.jumpShare * 100)}% of the move was jumps — the estimate is stretched`);
  }

  // The market's own probability is its price. The whole question is whether
  // ours is far enough from it to be worth acting on.
  const marketProbability = marketPriceCents / 100;

  // The prices that can actually be traded, not the mid between them. Buying
  // YES costs the ask; buying NO costs a hundred minus the YES BID. Measuring
  // edge against the mid quietly claimed half the spread as profit on every
  // trade — up to 1.5¢ of a 6¢ threshold, and always in the flattering
  // direction.
  const quotes = executablePrices(market, marketPriceCents);

  // What every refusal from here on still knows. A position already open is
  // judged on this, not on the verdict — and so is a directional read on a
  // market the engine declines to trade, which is why the executable prices
  // travel with it. Handing a refusal the mid instead sends the same
  // half-spread error down a second path.
  const read = { probability, marketProbability, sigma, volatility: vol, quotes };

  const trend = trendFit(prices.slice(-20));
  if (trend && trend.r2 > config.maximumTrendFit) {
    notes.push(`Trending hard (R²=${trend.r2.toFixed(2)}) — random-walk read is weakest here`);
    return skip('trending', read);
  }

  const upEdgeCents = (probability - marketProbability) * 100;

  if (!quotes) return skip('no_price', read);

  // Each side judged on its own executable price. With a spread these are no
  // longer mirror images: a market can be genuinely untradeable from both
  // sides at once, which is what a wide spread means and what the mid hides.
  const upNet = netEdgeCents(probability, VERDICTS.UP, quotes, { feeRate: config.feeRate });
  const downNet = netEdgeCents(1 - probability, VERDICTS.DOWN, quotes, { feeRate: config.feeRate });

  const best =
    (upNet?.netCents ?? -Infinity) >= (downNet?.netCents ?? -Infinity)
      ? { side: VERDICTS.UP, cost: upNet }
      : { side: VERDICTS.DOWN, cost: downNet };

  if (!best.cost) return skip('no_price', read);
  best.entryCents = best.cost.entryCents;

  // The gross edge of the side being taken, against the price it is taken at.
  const bestEdgeCents = best.cost.grossCents;

  if (bestEdgeCents < config.minimumEdgeCents) return skip('no_edge', read);
  if (best.cost.netCents <= 0) return skip('fee_eats_it', read);

  // Kept for the parts of the signal that still talk in expected value.
  best.value = expectedValue(
    best.side === VERDICTS.UP ? probability : 1 - probability,
    best.entryCents / 100,
    { feeRate: config.feeRate },
  );

  // The pessimistic end of the band has to beat the market too. Requiring this
  // is what stops the engine calling markets it only wins on a lucky vol read.
  const worstProbability =
    best.side === VERDICTS.UP ? probabilityRange[0] : 1 - probabilityRange.at(-1);
  const worstEdgeCents = worstProbability * 100 - best.entryCents;
  if (!Number.isFinite(worstEdgeCents) || worstEdgeCents < config.minimumWorstCaseEdgeCents) {
    notes.push(
      `Edge survives the central vol estimate but not the pessimistic one (${worstEdgeCents.toFixed(1)}¢)`,
    );
    return skip('vol_uncertain', read);
  }

  // Only now does the book matter — there is no point rejecting a market for
  // its spread before knowing whether it had an edge to lose.
  if (book.spreadCents !== null && book.spreadCents > config.maximumSpreadCents) {
    notes.push(`Spread ${book.spreadCents.toFixed(1)}¢ against an edge of ${Math.abs(upEdgeCents).toFixed(1)}¢`);
    return skip('wide_spread', read);
  }
  if (
    book.liquidityDollars !== null &&
    book.liquidityDollars < config.minimumLiquidityDollars
  ) {
    return skip('thin_book', read);
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
    // The chance the SIDE BEING CALLED wins. `probability` is always the chance
    // of finishing above the strike, which is the opposite of the answer on a
    // DOWN call — and sizing a DOWN trade with it stakes the losing side. Every
    // consumer wants this one.
    winProbability: best.side === VERDICTS.UP ? probability : 1 - probability,
    worstWinProbability:
      best.side === VERDICTS.UP ? probabilityRange[0] : 1 - probabilityRange.at(-1),
    marketProbability,
    // The edge of the side actually being called, against the price actually
    // paid for it. `upEdgeCents` against the mid is kept below for display.
    edgeCents: bestEdgeCents,
    midEdgeCents: Math.abs(upEdgeCents),
    quotes,
    cost: best.cost,
    entryCents: best.entryCents,
    expected: best.value,
    sigma,
    volatility: vol,
    probabilityRange,
    worstEdgeCents,
    // The odds it touches the strike again before the bell. On a fifteen-minute
    // contract this is the number that decides when to bank, and it is roughly
    // twice what the finishing probability suggests.
    flipProbability: flipProbability(price, strike, sigma),
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
