import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HORIZON_MS,
  appendPatternRecord,
  makePatternRecord,
  patternVerdict,
  patternWinRates,
  settlePatternRecords,
} from '../src/signals/patternLog.js';

/**
 * The same discipline confluenceLog.test.js applies to confluence, applied
 * to Pattern Sonar: a pattern confirming is a claim about what price does
 * next, and that claim only means something once real settled history says
 * whether it was right.
 */

const record = (over = {}) =>
  makePatternRecord({
    at: 1_000_000,
    spot: 65_000,
    patternKey: 'doubleTop',
    label: 'Double Top',
    bias: 'bearish',
    quality: 70,
    ...over,
  });

test('a record with no real bias is not kept', () => {
  assert.equal(record({ bias: null }), null);
  assert.equal(record({ bias: 'sideways' }), null);
});

test('a record with no real read behind it is not kept', () => {
  assert.equal(record({ at: 0 }), null);
  assert.equal(record({ spot: 0 }), null);
  assert.equal(record({ patternKey: null }), null);
});

test('one horizon window per pattern type gets one row, the higher-quality read', () => {
  let log = appendPatternRecord([], record({ at: 1_000_000, quality: 50 }));
  log = appendPatternRecord(log, record({ at: 1_010_000, quality: 80 }));
  assert.equal(log.length, 1);
  assert.equal(log[0].quality, 80);
});

test('two different patterns confirming in the same window are kept as separate claims', () => {
  let log = appendPatternRecord([], record({ at: 1_000_000, patternKey: 'doubleTop' }));
  log = appendPatternRecord(log, record({ at: 1_005_000, patternKey: 'bearFlag', label: 'Bear Flag' }));
  assert.equal(log.length, 2);
});

test('the next horizon window is a new row', () => {
  let log = appendPatternRecord([], record({ at: 1_000_000 }));
  log = appendPatternRecord(log, record({ at: 1_000_000 + HORIZON_MS }));
  assert.equal(log.length, 2);
});

test('a settled row is never overwritten by a later confirmation', () => {
  const settled = { ...record({ at: 1_000_000 }), bucket: 1, won: 1 };
  const log = appendPatternRecord([settled], record({ at: 1_000_000, quality: 99 }));
  assert.equal(log.length, 2);
  assert.equal(log[0].won, 1);
});

test('a bearish confirmation is graded a win when price actually falls', () => {
  const at = 1_000_000;
  const targetAt = at + HORIZON_MS;
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: targetAt - t, price: 64_500 });

  const { log, settled } = settlePatternRecords([record({ at, spot: 65_000, bias: 'bearish' })], {
    now: targetAt + 60_000,
    samples,
  });
  assert.equal(log[0].won, 1);
  assert.equal(settled, 1);
});

test('a bearish confirmation is graded a loss when price rises instead', () => {
  const at = 1_000_000;
  const targetAt = at + HORIZON_MS;
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: targetAt - t, price: 65_500 });

  const { log } = settlePatternRecords([record({ at, spot: 65_000, bias: 'bearish' })], {
    now: targetAt + 60_000,
    samples,
  });
  assert.equal(log[0].won, 0);
});

test('a window that has not reached its horizon yet is left ungraded', () => {
  const { log, settled } = settlePatternRecords([record({ at: 1_000_000 })], {
    now: 1_000_000 + HORIZON_MS - 1000,
    samples: [{ at: 1_000_000, price: 65_000 }],
  });
  assert.equal(log[0].won, null);
  assert.equal(settled, 0);
});

test('win rates are split per pattern type, not just an aggregate number', () => {
  const log = [
    { patternKey: 'doubleTop', label: 'Double Top', won: 1 },
    { patternKey: 'doubleTop', label: 'Double Top', won: 1 },
    { patternKey: 'doubleTop', label: 'Double Top', won: 0 },
    { patternKey: 'bearFlag', label: 'Bear Flag', won: 0 },
    { patternKey: 'bearFlag', label: 'Bear Flag', won: 0 },
  ];
  const rates = patternWinRates(log, { minimumSettled: 2 });

  const overall = rates.find((r) => r.patternKey === 'overall');
  const doubleTop = rates.find((r) => r.patternKey === 'doubleTop');
  const bearFlag = rates.find((r) => r.patternKey === 'bearFlag');

  assert.equal(overall.settled, 5);
  assert.ok(Math.abs(doubleTop.winRate - 2 / 3) < 1e-9);
  assert.equal(bearFlag.winRate, 0);
  assert.equal(bearFlag.enough, true);
});

test('a pattern type with too few settled rows is marked not enough rather than guessing', () => {
  const rates = patternWinRates([{ patternKey: 'cupAndHandle', label: 'Cup & Handle', won: 1 }], {
    minimumSettled: 15,
  });
  const cup = rates.find((r) => r.patternKey === 'cupAndHandle');
  assert.equal(cup.enough, false);
  assert.match(patternVerdict(cup), /not enough/);
});

test('the verdict names whether the pattern beats a coin flip', () => {
  assert.match(patternVerdict({ enough: true, winRate: 0.6 }), /ahead of a coin flip/);
  assert.match(patternVerdict({ enough: true, winRate: 0.4 }), /behind a coin flip/);
  assert.match(patternVerdict({ enough: true, winRate: 0.5 }), /no better than a coin flip/);
});

test('ungraded rows never reach the win rates', () => {
  const rates = patternWinRates([{ patternKey: 'doubleTop', label: 'Double Top', won: null }]);
  assert.equal(rates.find((r) => r.patternKey === 'overall').settled, 0);
});
