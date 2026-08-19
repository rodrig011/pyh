import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brier,
  calibrationBuckets,
  dailyGrowth,
  measureEdge,
  mispricing,
} from '../src/signals/measure.js';
import {
  appendObservation,
  makeObservation,
  recordOnce,
  settleObservations,
} from '../src/signals/recorder.js';

const observation = (over) =>
  makeObservation({
    at: 1_000_000,
    ticker: 'KXBTC15M-T1',
    spot: 65_000,
    strike: 64_900,
    yesBidCents: 55,
    yesAskCents: 57,
    secondsLeft: 300,
    ...over,
  });

test('a forecaster worse than a coin is caught by the score alone', () => {
  // 0.25 is what always saying 50% gets you. Anything above it is worse than
  // not having a model, and that has to be visible without interpretation.
  const coin = brier([
    { probability: 0.5, outcome: 1 },
    { probability: 0.5, outcome: 0 },
  ]);
  assert.equal(coin, 0.25);

  const confidentlyWrong = brier([
    { probability: 0.9, outcome: 0 },
    { probability: 0.9, outcome: 0 },
  ]);
  assert.ok(confidentlyWrong > 0.25);

  const good = brier([
    { probability: 0.9, outcome: 1 },
    { probability: 0.1, outcome: 0 },
  ]);
  assert.ok(good < 0.05);
});

test('confident and wrong shows up in calibration, not in the average', () => {
  // Of everything called 90%, about 90% must happen. A model can hold a decent
  // average while being systematically overconfident, and this is the only
  // place that shows.
  const buckets = calibrationBuckets([
    { probability: 0.92, outcome: 1 },
    { probability: 0.93, outcome: 0 },
    { probability: 0.95, outcome: 0 },
    { probability: 0.91, outcome: 0 },
  ]);

  const top = buckets.at(-1);
  assert.ok(top.predicted > 0.9);
  assert.ok(top.actual < 0.3, 'says 90+, delivers 25');
});

test('a mispricing without an error bar is not a measurement', () => {
  // Four observations of a 2c bias is nothing. The same bias measured many
  // times is a business, and the difference has to be in the output.
  // Same underlying market in both, same mix of outcomes — only the number of
  // observations differs, which is the only thing the error bar should react to.
  // Period ten, so twenty rows and nine hundred rows hold the same mix rather
  // than the small sample landing entirely on one outcome.
  // Ten observations per market, and every observation of a market shares
  // that market's single outcome — which is the whole reason the error bar
  // has to be clustered.
  const rows = (n) =>
    Array.from({ length: n }, (_, i) => {
      const market = Math.floor(i / 10);
      return { ticker: `M${market}`, bid: 51, ask: 53, outcome: market % 2 };
    });

  const few = mispricing(rows(20));
  const many = mispricing(rows(900));

  assert.ok(few.standardErrorCents > many.standardErrorCents);
  assert.ok(many.n > few.n);

  // Twenty observations cannot establish a bias; nine hundred of the same
  // thing can. This is the line between "we noticed something" and "we
  // measured something", and it is the whole reason the field exists.
  assert.equal(few.significant, false);
});

test('a market that is never wrong is reported as no business, not as a small one', () => {
  // The market quotes exactly the truth: half the contracts at 60c settle yes.
  // The honest reading is "no evidence of bias", and a straddling interval is
  // how that must be said.
  const rows = Array.from({ length: 1000 }, (_, i) => {
    const market = Math.floor(i / 10);
    return { ticker: `M${market}`, bid: 59, ask: 61, outcome: market % 10 < 6 ? 1 : 0 };
  });

  const result = mispricing(rows);
  assert.ok(!result.significant, `claimed significance at ${result.meanCents.toFixed(2)}c`);
  assert.ok(result.ci95[0] < 0 && result.ci95[1] > 0);
});

test('the model is scored against the market on identical rows, or the comparison is rigged', () => {
  // The market says 50 on everything. The model knows the answer. The model
  // must win, and the gap must be positive.
  const rows = Array.from({ length: 200 }, (_, i) => {
    const market = Math.floor(i / 10);
    const outcome = market % 2;
    return { ticker: `M${market}`, bid: 49, ask: 51, outcome, model: outcome ? 0.95 : 0.05 };
  });

  const result = measureEdge(rows);
  assert.equal(result.ready, true);
  assert.equal(result.modelBeatsMarket, true);
  assert.ok(result.brierGap > 0.2);
  assert.ok(result.centsPerTrade > 30);
});

test('a model with no idea is reported as losing to the market', () => {
  const rows = Array.from({ length: 200 }, (_, i) => {
    const market = Math.floor(i / 10);
    const outcome = market % 2;
    // Confidently backwards.
    return { ticker: `M${market}`, bid: 49, ask: 51, outcome, model: outcome ? 0.1 : 0.9 };
  });

  const result = measureEdge(rows);
  assert.equal(result.modelBeatsMarket, false);
  assert.ok(result.centsPerTrade < 0);
});

test('nothing settled means nothing is claimed', () => {
  const result = measureEdge([{ bid: 50, ask: 52, outcome: null, model: 0.6 }]);
  assert.equal(result.ready, false);
  assert.equal(result.settled, 0);
});

test('the spread is charged when the edge is measured', () => {
  // Taking the ask rather than the mid is worth about a cent a trade, and a
  // measurement that quietly uses the mid overstates the business by exactly
  // that amount on every row.
  const rows = Array.from({ length: 300 }, (_, i) => {
    const market = Math.floor(i / 10);
    return { ticker: `M${market}`, bid: 48, ask: 52, outcome: market % 10 < 6 ? 1 : 0, model: 0.6 };
  });

  const honest = measureEdge(rows, { spreadAware: true });
  const flattering = measureEdge(rows, { spreadAware: false });
  assert.ok(flattering.centsPerTrade > honest.centsPerTrade);
});

test('an observation missing anything it needs is refused, not stored half-formed', () => {
  assert.equal(observation({ spot: 0 }), null);
  assert.equal(observation({ strike: null }), null);
  assert.equal(observation({ ticker: '' }), null);
  assert.equal(observation({ yesBidCents: 'x' }), null);
  assert.ok(observation({}) !== null);
});

test('the recorder does not fill the log with the same second twice', () => {
  const first = appendObservation([], observation({ at: 1_000_000 }));
  const tooSoon = appendObservation(first, observation({ at: 1_000_400 }));
  const later = appendObservation(first, observation({ at: 1_002_000 }));

  assert.equal(first.length, 1);
  assert.equal(tooSoon.length, 1);
  assert.equal(later.length, 2);
});

test('a market is graded when its clock ran out, not when a zero was observed', () => {
  // The bug that left 996 recorded quotes with nothing graded. Settlement used
  // to require observing secondsLeft hit zero — and the recorder reads
  // whichever market is OPEN, so the moment one closes the exchange hands back
  // the next one and the final seconds of the old ticker are never seen.
  const now = Date.now();
  const closes = now - 10 * 60_000;

  // The last thing ever seen of this market: still 45 seconds to run.
  const log = [
    { at: closes - 300_000, ticker: 'M1', strike: 64_900, bid: 55, ask: 57, secondsLeft: 345, outcome: null },
    { at: closes - 45_000, ticker: 'M1', strike: 64_900, bid: 60, ask: 62, secondsLeft: 45, outcome: null },
  ];

  // Spot samples carry on past the close, because the collector never stops.
  const samples = [];
  for (let t = closes - 120_000; t <= closes + 60_000; t += 30_000) {
    samples.push({ at: t, price: 65_000 });
  }

  const done = settleObservations(log, { now, samples });
  assert.equal(done.settled, 2, 'the market finished ten minutes ago');
  assert.ok(done.log.every((row) => row.outcome === 1), 'it closed above the strike');
});

test('a market still running is left alone', () => {
  const now = Date.now();
  const log = [
    { at: now - 60_000, ticker: 'M1', strike: 64_900, bid: 55, ask: 57, secondsLeft: 600, outcome: null },
  ];
  const done = settleObservations(log, { now, samples: [{ at: now, price: 65_000 }] });
  assert.equal(done.settled, 0);
});

test('the settlement price is the final minute averaged, as the exchange does it', () => {
  // A late spike must not decide a market that spent the whole minute below
  // the strike — Kalshi settles on the average of the last sixty seconds, and
  // grading on the single nearest print would score the spike.
  const now = Date.now();
  const closes = now - 10 * 60_000;

  const log = [
    { at: closes - 200_000, ticker: 'M1', strike: 65_000, bid: 50, ask: 52, secondsLeft: 200, outcome: null },
  ];

  const samples = [
    { at: closes - 55_000, price: 64_800 },
    { at: closes - 40_000, price: 64_800 },
    { at: closes - 20_000, price: 64_800 },
    // One print above the strike, right at the bell.
    { at: closes - 1_000, price: 65_400 },
  ];

  const done = settleObservations(log, { now, samples });
  assert.equal(done.settled, 1);
  // Average is about 64,950 — below the strike, so the spike does not win it.
  assert.equal(done.log[0].outcome, 0);
});

test('a market with no spot anywhere near its close is left ungraded', () => {
  // Grading on a price from ten minutes off would be worse than not grading.
  const now = Date.now();
  const closes = now - 60 * 60_000;
  const log = [
    { at: closes - 100_000, ticker: 'M1', strike: 65_000, bid: 50, ask: 52, secondsLeft: 100, outcome: null },
  ];

  const done = settleObservations(log, { now, samples: [{ at: now, price: 65_000 }] });
  assert.equal(done.settled, 0);
});

test('the recorder never throws into the loop that also handles payments', () => {
  const store = { listQuotes: () => [], putQuotes: () => {} };

  assert.equal(recordOnce(store, { contract: null }).recorded, false);
  assert.equal(recordOnce(store, { contract: { error: 'boom' } }).recorded, false);
  assert.equal(
    recordOnce(store, { contract: { market: { ticker: 'X' } }, spot: 1 }).recorded,
    false,
  );

  const exploding = {
    listQuotes: () => {
      throw new Error('disk on fire');
    },
    putQuotes: () => {},
  };
  const result = recordOnce(exploding, {
    contract: {
      market: {
        ticker: 'KXBTC15M-T1',
        floor_strike: 64_900,
        yes_bid: 55,
        yes_ask: 57,
        close_time: new Date(Date.now() + 300_000).toISOString(),
      },
    },
    spot: 65_000,
  });
  assert.equal(result.recorded, false);
  assert.match(result.reason, /disk on fire/);
});

test('daily growth is per trade compounded, not per trade added up', () => {
  const slow = dailyGrowth({ centsPerTrade: 3, entryCents: 50, tradesPerDay: 10 });
  const fast = dailyGrowth({ centsPerTrade: 3, entryCents: 50, tradesPerDay: 40 });

  // Same edge, four times the markets. That is the only lever the maths does
  // not cap, which is the entire argument for scanning more assets.
  assert.ok(fast.dailyPercent > slow.dailyPercent);

  // And an edge under the fee is a loss however many times it is repeated.
  const losing = dailyGrowth({ centsPerTrade: 1, entryCents: 50, tradesPerDay: 40 });
  assert.ok(losing.dailyPercent < 0);
});

test('the model read is written down beside the quote, not left for later', async () => {
  // The half that cannot be rebuilt afterwards. The model's probability
  // depends on the price history as it stood at that instant; an hour later
  // that moment is gone, and with it any chance of asking whether our number
  // beat the market's.
  const { observeOnce } = await import('../src/signals/recorder.js');

  const saved = [];
  const store = {
    listQuotes: () => saved,
    putQuotes: (_asset, rows) => saved.splice(0, saved.length, ...rows),
    listSamples: () => [{ at: Date.now() - 1000, price: 65_000 }],
  };

  const contract = {
    price: 55,
    market: {
      ticker: 'KXBTC15M-T9',
      floor_strike: 64_900,
      yes_bid: 54,
      yes_ask: 56,
      close_time: new Date(Date.now() + 600_000).toISOString(),
    },
  };

  observeOnce(store, {
    contract,
    spot: 65_000,
    evaluateModel: () => ({ probability: 0.64 }),
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, 0.64);
  assert.equal(saved[0].bid, 54);
  assert.equal(saved[0].ask, 56);
});

test('a model that has no opinion records null, never a coin flip', async () => {
  const { observeOnce } = await import('../src/signals/recorder.js');
  const saved = [];
  const store = {
    listQuotes: () => saved,
    putQuotes: (_asset, rows) => saved.splice(0, saved.length, ...rows),
    listSamples: () => [],
  };
  const contract = {
    price: 55,
    market: {
      ticker: 'KXBTC15M-T9',
      floor_strike: 64_900,
      yes_bid: 54,
      yes_ask: 56,
      close_time: new Date(Date.now() + 600_000).toISOString(),
    },
  };

  // Not enough history to say anything — which is different from 50%, and
  // recording it as 50% would quietly score a shrug as a forecast.
  observeOnce(store, { contract, spot: 65_000, evaluateModel: () => ({ verdict: 'skip' }) });
  assert.equal(saved[0].model, null);

  // And a model that throws must not cost us the quote, which is the part
  // that cannot be recovered later.
  saved.length = 0;
  observeOnce(store, {
    contract,
    spot: 65_000,
    evaluateModel: () => {
      throw new Error('model exploded');
    },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, null);
});

test('thirty samples of one market are one fact, not thirty', () => {
  // The correction that stops this file from lying. A 15-minute market is
  // sampled every 30 seconds, and all thirty rows share ONE outcome. Counting
  // them as thirty independent observations understates the error bar by
  // about five and a half times — which is the difference between "we
  // measured a 2¢ edge" and "we have no idea".
  const markets = 20;
  const perMarket = 30;

  const spread = [];
  for (let m = 0; m < markets; m += 1) {
    for (let i = 0; i < perMarket; i += 1) {
      spread.push({ ticker: `M${m}`, bid: 51, ask: 53, outcome: m % 2 });
    }
  }

  // The same number of rows, but each one its own market.
  const independent = spread.map((row, i) => ({ ...row, ticker: `SOLO${i}` }));

  const clustered = mispricing(spread);
  const pretendIndependent = mispricing(independent);

  assert.equal(clustered.markets, markets);
  assert.equal(pretendIndependent.markets, spread.length);

  // Same data, same mean — only the honesty of the error bar differs.
  assert.ok(Math.abs(clustered.meanCents - pretendIndependent.meanCents) < 1e-9);
  assert.ok(
    clustered.standardErrorCents > pretendIndependent.standardErrorCents * 4,
    `clustered ${clustered.standardErrorCents.toFixed(2)}c vs naive ${pretendIndependent.standardErrorCents.toFixed(2)}c`,
  );
});

test('the model must beat the market by more than the noise before it is believed', () => {
  // A model that is better on average but wildly inconsistent has not proven
  // anything. "Beats the market" means the interval stops crossing zero, not
  // that the average came out ahead.
  const noisy = [];
  for (let m = 0; m < 30; m += 1) {
    const outcome = m % 2;
    // Right on half the markets, badly wrong on the other half.
    const model = m % 4 < 2 ? outcome : 1 - outcome;
    for (let i = 0; i < 30; i += 1) {
      noisy.push({ ticker: `M${m}`, bid: 49, ask: 51, outcome, model: model ? 0.95 : 0.05 });
    }
  }

  const result = measureEdge(noisy);
  assert.equal(result.modelBeatsMarket, false, 'a coin flip dressed as an edge');
  assert.ok(result.comparison.ci95[0] < 0, 'the interval must still cross zero');
});

test('the estimators are ranked by settled markets, not by argument', async () => {
  const { rankEstimators } = await import('../src/signals/measure.js');

  // Two estimators recorded side by side. One is right, one is backwards.
  // Which is which must fall out of the outcomes, with no help.
  const rows = [];
  for (let m = 0; m < 40; m += 1) {
    const outcome = m % 2;
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        ticker: `M${m}`,
        bid: 49,
        ask: 51,
        outcome,
        sigmas: { good: outcome ? 0.9 : 0.1, bad: outcome ? 0.1 : 0.9 },
      });
    }
  }

  // The "sigma" here stands in for whatever the estimator implies; the ranker
  // only needs a way to turn one into a probability.
  const ranked = rankEstimators(rows, { probabilityFrom: (row, sigma) => sigma });

  assert.equal(ranked.best.name, 'good');
  assert.ok(ranked.ranked.find((x) => x.name === 'bad').brier > ranked.best.brier);
  assert.ok(ranked.best.versusMarket.mean > 0, 'the good one must beat the market');
});

test('a tie between estimators is reported as a tie, not as a winner', async () => {
  const { rankEstimators } = await import('../src/signals/measure.js');

  // Six estimators that are all the same. Picking one would be picking the
  // luckiest of six coin flips, and the whole point of the error bar is to
  // refuse to do that.
  const rows = [];
  for (let m = 0; m < 40; m += 1) {
    const outcome = m % 2;
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        ticker: `M${m}`,
        bid: 49,
        ask: 51,
        outcome,
        sigmas: { a: 0.55, b: 0.55, c: 0.55 },
      });
    }
  }

  const ranked = rankEstimators(rows, { probabilityFrom: (row, sigma) => sigma });
  assert.equal(ranked.decisive, false);
});

test('the two scores are computed on identical rows, or they are not a comparison', () => {
  // Straight from a live report: market 0.1558, model 0.2008, and beside them
  // "the model is ahead". All three were correct arithmetic — on two different
  // sets of rows. The market was being scored on every settled observation
  // while the model was scored only on the ones it had an opinion about, and
  // the model happens to go quiet exactly on the markets that are hardest to
  // call. That is the most misleading kind of number there is.
  const rows = [];
  for (let m = 0; m < 40; m += 1) {
    const outcome = m % 2;
    for (let i = 0; i < 10; i += 1) {
      rows.push({
        ticker: `M${m}`,
        bid: outcome ? 89 : 9,
        ask: outcome ? 91 : 11,
        outcome,
        // The model only speaks on the easy half.
        model: m < 20 ? (outcome ? 0.9 : 0.1) : null,
      });
    }
  }

  const result = measureEdge(rows);

  // The headline pair must agree in direction with the paired comparison,
  // because they are now the same rows.
  const modelAhead = result.modelBrier < result.marketBrier;
  assert.equal(modelAhead, result.comparison.mean > 0);

  // And the all-rows market score is still available, just never opposite it.
  assert.ok(Number.isFinite(result.marketBrierAll));
  assert.notEqual(result.marketBrierAll, result.marketBrier);
});
