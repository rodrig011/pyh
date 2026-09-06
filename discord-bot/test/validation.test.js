import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calibratedProbability,
  fitProbabilityCalibrator,
  marketSnapshots,
  strategyResult,
  walkForwardValidation,
} from '../src/signals/validation.js';

function row(index, { model, outcome, bid = 49, ask = 51, secondsLeft = 300 } = {}) {
  return {
    at: 1_700_000_000_000 + index * 900_000,
    ticker: `K-${String(index).padStart(4, '0')}`,
    secondsLeft,
    outcomeSource: 'kalshi-market:official-result',
    model,
    outcome,
    bid,
    ask,
  };
}

test('validation takes one independent snapshot per market closest to five minutes', () => {
  const observations = [
    row(1, { model: 0.7, outcome: 1, secondsLeft: 600 }),
    { ...row(1, { model: 0.8, outcome: 1, secondsLeft: 305 }), at: 1_700_000_001_000 },
    row(2, { model: 0.2, outcome: 0, secondsLeft: 290 }),
  ];
  const snapshots = marketSnapshots(observations);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.find((item) => item.ticker === 'K-0001').model, 0.8);
});

test('the calibrator learns from outcomes instead of preserving systematic overconfidence', () => {
  const rows = Array.from({ length: 80 }, (_, index) => row(index, {
    model: 0.9,
    outcome: index % 2,
  }));
  const calibrator = fitProbabilityCalibrator(rows);
  assert.equal(calibrator.ready, true);
  assert.ok(calibratedProbability(0.9, calibrator) < 0.75);
});

test('walk-forward validation never uses the tested market to fit its probability', () => {
  const rows = Array.from({ length: 260 }, (_, index) => {
    const outcome = index % 2;
    return row(index, { model: outcome ? 0.8 : 0.2, outcome, bid: 49, ask: 51 });
  });
  const result = walkForwardValidation(rows);
  assert.equal(result.trainingMarkets, 50);
  assert.equal(result.outOfSampleMarkets, 210);
  assert.equal(result.strategy.trades, 210);
  assert.equal(result.strategy.losses, 0);
  assert.equal(result.promotion.eligible, true);
});

test('a losing model is not promoted even when it emits many trades', () => {
  const rows = Array.from({ length: 260 }, (_, index) => {
    const outcome = index % 2;
    return row(index, { model: outcome ? 0.2 : 0.8, outcome, bid: 49, ask: 51 });
  });
  const result = walkForwardValidation(rows);
  assert.equal(result.promotion.eligible, false);
  assert.ok(result.promotion.reasons.length > 0);
});

test('economic validation charges fees and slippage before calling a trade profitable', () => {
  const result = strategyResult([
    { ticker: 'K-1', calibrated: 0.6, outcome: 1, bid: 54, ask: 56 },
  ], { minimumEdgeCents: 0, slippageCents: 1 });
  assert.equal(result.trades, 1);
  assert.ok(result.netProfitCents < 44, 'costs reduce the headline settlement payoff');
});

test('provisional results cannot validate a strategy', () => {
  const rows = [row(1, { model: 0.8, outcome: 1 })];
  rows[0].outcomeSource = 'local-brti-window:provisional';
  assert.equal(marketSnapshots(rows).length, 0);
});

test('overlapping markets cannot leak their outcomes into earlier predictions', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    ...row(i, { model: 0.8, outcome: 1 }), at: 1_700_000_000_000 + i,
  }));
  assert.equal(walkForwardValidation(rows).outOfSampleMarkets, 0);
});
