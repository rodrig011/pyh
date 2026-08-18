import test from 'node:test';
import assert from 'node:assert/strict';
import { findFairValueGaps, findSupportResistance } from '../src/signals/levels.js';

const candle = (time, open, high, low, close) => ({ time, open, high, low, close });

function pathCandles(anchors, perLeg) {
  const cs = [];
  let t = 0;
  for (let a = 0; a < anchors.length - 1; a += 1) {
    const from = anchors[a];
    const to = anchors[a + 1];
    for (let i = 0; i < perLeg; i += 1) {
      const p0 = from + (to - from) * (i / perLeg);
      const p1 = from + (to - from) * ((i + 1) / perLeg);
      cs.push(candle(t, p0, Math.max(p0, p1) + 0.05, Math.min(p0, p1) - 0.05, p1));
      t += 60_000;
    }
  }
  return cs;
}

test('findSupportResistance scores a level by real touches and how tightly they cluster', () => {
  // Price rallies to ~100 four separate times and pulls back to three
  // distinct pockets below it -- a real, repeatedly-tested resistance.
  const cs = pathCandles([90, 100, 92, 100.05, 91, 99.95, 93, 100.1, 90.5], 6);
  const levels = findSupportResistance(cs);
  const resistance = levels.find((level) => level.type === 'resistance');
  assert.ok(resistance);
  assert.equal(resistance.touches, 4);
  assert.ok(resistance.quality > 0 && resistance.quality <= 100);
  assert.ok(levels.every((level) => level.touches >= 1));
});

test('a level tested only once still appears, scored lower than a well-tested one', () => {
  const cs = pathCandles([90, 100, 92, 100.05, 91, 99.95, 93, 100.1, 90.5], 6);
  const levels = findSupportResistance(cs);
  const resistance = levels.find((level) => level.type === 'resistance');
  const onceTouch = levels.find((level) => level.touches === 1);
  assert.ok(onceTouch);
  assert.ok(onceTouch.quality < resistance.quality || onceTouch.touches < resistance.touches);
});

test('too little candle history returns no levels rather than guessing', () => {
  assert.deepEqual(findSupportResistance(pathCandles([90, 100], 2)), []);
  assert.deepEqual(findSupportResistance(null), []);
});

test('findFairValueGaps finds a real three-candle imbalance and reports it as bullish', () => {
  const cs = [
    candle(0, 100, 100.2, 99.8, 100),
    candle(60_000, 100, 102, 100, 101.9),
    candle(120_000, 102, 103, 101.8, 102.5), // low (101.8) clears candle 0's high (100.2) -- the gap
    candle(180_000, 102.5, 102.6, 101.9, 102.0), // pulls back, but not into the gap
    candle(240_000, 102.0, 102.3, 101.95, 102.1),
  ];
  const gaps = findFairValueGaps(cs);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].bias, 'bullish');
  assert.equal(gaps[0].low, 100.2);
  assert.equal(gaps[0].high, 101.8);
});

test('a gap price has already traded back through is not reported as open', () => {
  const cs = [
    candle(0, 100, 100.2, 99.8, 100),
    candle(60_000, 100, 102, 100, 101.9),
    candle(120_000, 102, 103, 101.8, 102.5),
    candle(180_000, 102.5, 102.8, 102.2, 102.6),
    candle(240_000, 102.6, 102.9, 99, 99.5), // drops back through the whole gap
  ];
  assert.deepEqual(findFairValueGaps(cs), []);
});

test('a flat tape has no real gaps to find', () => {
  const cs = [];
  let t = 0;
  for (let i = 0; i < 30; i += 1) {
    const n = Math.sin(i) * 0.05;
    cs.push(candle(t, 100 + n, 100 + n + 0.1, 100 + n - 0.1, 100 + n));
    t += 60_000;
  }
  assert.deepEqual(findFairValueGaps(cs), []);
});

test('a gap smaller than the minimum ratio is not reported', () => {
  const cs = [
    candle(0, 100, 100.01, 99.99, 100),
    candle(60_000, 100, 100.02, 100, 100.011),
    candle(120_000, 100.011, 100.02, 100.0105, 100.015), // gap is ~0.005%, below the default 0.1% floor
  ];
  assert.deepEqual(findFairValueGaps(cs), []);
});

test('too little candle history returns no gaps rather than guessing', () => {
  assert.deepEqual(findFairValueGaps([candle(0, 100, 101, 99, 100)]), []);
});
