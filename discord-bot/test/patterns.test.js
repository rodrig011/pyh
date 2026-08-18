import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBearFlag,
  detectCupAndHandle,
  detectDoubleBottom,
  detectDoubleTop,
  detectHeadAndShoulders,
  detectInverseHeadAndShoulders,
  detectReverseCupAndHandle,
  findPivots,
  scanPatterns,
} from '../src/signals/patterns.js';

/**
 * Real geometry checks over synthetic candles built to the exact shape each
 * pattern requires — verified against a probe script before this file was
 * written, the same discipline every other signal in this codebase gets
 * before it ships. The one property tested everywhere below: a shape that is
 * NOT the pattern must come back null, not a low number pretending to read.
 */

const candle = (time, open, high, low, close) => ({ time, open, high, low, close });

/** Linear ramps between anchor prices, `perLeg` candles per leg. */
function pathCandles(anchors, perLeg) {
  const cs = [];
  let t = 0;
  for (let a = 0; a < anchors.length - 1; a += 1) {
    const from = anchors[a];
    const to = anchors[a + 1];
    for (let i = 0; i < perLeg; i += 1) {
      const p0 = from + (to - from) * (i / perLeg);
      const p1 = from + (to - from) * ((i + 1) / perLeg);
      const hi = Math.max(p0, p1) + 0.05;
      const lo = Math.min(p0, p1) - 0.05;
      cs.push(candle(t, p0, hi, lo, p1));
      t += 60_000;
    }
  }
  return cs;
}

/** Gentle sine noise around a flat price — the "nothing is happening" fixture every detector must refuse. */
function flatNoise(len = 60, price = 100) {
  const cs = [];
  let t = 0;
  for (let i = 0; i < len; i += 1) {
    const n = Math.sin(i) * 0.05;
    cs.push(candle(t, price + n, price + n + 0.1, price + n - 0.1, price + n));
    t += 60_000;
  }
  return cs;
}

test('findPivots collapses a flat top into one pivot, not one per tied candle', () => {
  const cs = pathCandles([80, 100, 80], 6);
  const { highs } = findPivots(cs, { lookback: 2 });
  // A single ramp up then down has exactly one real top, however many
  // candles happen to tie for the exact peak value.
  const peaks = highs.filter((h) => h.price > 99);
  assert.equal(peaks.length, 1);
});

test('double top: two equal peaks with a real valley between them', () => {
  const cs = pathCandles([80, 100, 90, 100.1, 88], 6);
  const result = detectDoubleTop(cs);
  assert.ok(result);
  assert.equal(result.label, 'Double Top');
  assert.equal(result.bias, 'bearish');
  assert.ok(result.quality > 50);
});

test('double top confirms only once price actually breaks the neckline', () => {
  const unconfirmed = pathCandles([80, 100, 90, 100.1], 6).concat(pathCandles([100.1, 100.1], 6));
  const result = detectDoubleTop(unconfirmed);
  assert.ok(result);
  assert.equal(result.confirmed, false);
});

test('a flat, quiet tape is not a double top', () => {
  assert.equal(detectDoubleTop(flatNoise()), null);
});

test('a single clean rally with no second peak is not a double top', () => {
  const cs = pathCandles([80, 120], 40);
  assert.equal(detectDoubleTop(cs), null);
});

test('double bottom: the mirror of a double top', () => {
  const cs = pathCandles([100, 80, 90, 80.1, 100], 6);
  const result = detectDoubleBottom(cs);
  assert.ok(result);
  assert.equal(result.label, 'Double Bottom');
  assert.equal(result.bias, 'bullish');
});

test('head and shoulders: a higher head between two roughly-equal shoulders', () => {
  const cs = pathCandles([80, 92, 83, 101, 83, 92, 80], 6);
  const result = detectHeadAndShoulders(cs);
  assert.ok(result);
  assert.equal(result.label, 'Head & Shoulders');
  assert.equal(result.bias, 'bearish');
  assert.ok(result.head > result.shoulders[0]);
  assert.ok(result.head > result.shoulders[1]);
});

test('unequal shoulders do not read as head and shoulders', () => {
  // Right shoulder far higher than the left -- not a real H&S, just a climb.
  const cs = pathCandles([80, 92, 83, 101, 83, 98, 100], 6);
  assert.equal(detectHeadAndShoulders(cs), null);
});

test('a flat tape is not head and shoulders', () => {
  assert.equal(detectHeadAndShoulders(flatNoise()), null);
});

test('inverse head and shoulders: the mirror, a lower head between two troughs', () => {
  const cs = pathCandles([80, 68, 77, 59, 77, 68, 80], 6);
  const result = detectInverseHeadAndShoulders(cs);
  assert.ok(result);
  assert.equal(result.label, 'Inverse Head & Shoulders');
  assert.equal(result.bias, 'bullish');
  assert.ok(result.head < result.shoulders[0]);
});

test('cup and handle: a rounded recovery back to the rim, then a shallow pullback', () => {
  const cup = pathCandles([70, 100, 96, 90, 86, 90, 96, 100], 5).concat(pathCandles([100, 97, 99], 4));
  const result = detectCupAndHandle(cup);
  assert.ok(result);
  assert.equal(result.label, 'Cup & Handle');
  assert.equal(result.bias, 'bullish');
});

test('a straight V (no rounding) is not a cup and handle', () => {
  // Straight down then straight up -- the low sits right at the edge of the
  // middle third, which is exactly what the "rounded, not a V" guard exists
  // to catch.
  const v = pathCandles([70, 100, 86, 100], 6).concat(pathCandles([100, 97, 99], 4));
  assert.equal(detectCupAndHandle(v), null);
});

test('a handle deeper than the cup is not a handle', () => {
  const cup = pathCandles([70, 100, 96, 90, 86, 90, 96, 100], 5).concat(pathCandles([100, 80, 99], 4));
  assert.equal(detectCupAndHandle(cup), null);
});

test('reverse cup and handle: the mirror, a rounded decline back to the rim', () => {
  const cs = pathCandles([130, 100, 104, 110, 114, 110, 104, 100], 5).concat(pathCandles([100, 103, 101], 4));
  const result = detectReverseCupAndHandle(cs);
  assert.ok(result);
  assert.equal(result.label, 'Reverse Cup & Handle');
  assert.equal(result.bias, 'bearish');
});

test('bear flag: a sharp drop followed by tight, controlled consolidation', () => {
  const cs = [];
  let t = 0;
  let price = 100;
  for (let i = 0; i < 10; i += 1) {
    price -= 1.2;
    cs.push(candle(t, price + 1, price + 1.1, price - 0.1, price));
    t += 60_000;
  }
  for (let i = 0; i < 10; i += 1) {
    const n = (i % 2) * 0.3;
    price += 0.05;
    cs.push(candle(t, price + n - 0.1, price + n + 0.2, price + n - 0.3, price + n));
    t += 60_000;
  }
  const result = detectBearFlag(cs);
  assert.ok(result);
  assert.equal(result.label, 'Bear Flag');
  assert.equal(result.bias, 'bearish');
});

test('a drop with no pole (too shallow) is not a bear flag', () => {
  assert.equal(detectBearFlag(flatNoise()), null);
});

test('a drop that mostly retraces during the "flag" is not a bear flag — that is a reversal', () => {
  const cs = [];
  let t = 0;
  let price = 100;
  for (let i = 0; i < 10; i += 1) {
    price -= 1.2;
    cs.push(candle(t, price + 1, price + 1.1, price - 0.1, price));
    t += 60_000;
  }
  // Retraces almost the whole pole instead of pausing.
  for (let i = 0; i < 10; i += 1) {
    price += 1.0;
    cs.push(candle(t, price - 1, price + 0.1, price - 1.1, price));
    t += 60_000;
  }
  assert.equal(detectBearFlag(cs), null);
});

test('scanPatterns runs every detector and a quiet tape comes back all null', () => {
  const result = scanPatterns(flatNoise());
  assert.deepEqual(Object.values(result), Object.values(result).map(() => null));
  assert.deepEqual(Object.keys(result).sort(), [
    'bearFlag',
    'cupAndHandle',
    'doubleBottom',
    'doubleTop',
    'headAndShoulders',
    'inverseHeadAndShoulders',
    'reverseCupAndHandle',
  ]);
});

test('every detector refuses to run on too little data rather than guessing', () => {
  const short = flatNoise(5);
  assert.equal(detectDoubleTop(short), null);
  assert.equal(detectDoubleBottom(short), null);
  assert.equal(detectHeadAndShoulders(short), null);
  assert.equal(detectInverseHeadAndShoulders(short), null);
  assert.equal(detectCupAndHandle(short), null);
  assert.equal(detectReverseCupAndHandle(short), null);
  assert.equal(detectBearFlag(short), null);
});
