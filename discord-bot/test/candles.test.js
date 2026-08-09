import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandles } from '../src/dashboard/candles.js';

test('ticks in the same bucket fold into one OHLC candle', () => {
  const candles = buildCandles(
    [
      { at: 0, price: 100 },
      { at: 10_000, price: 105 },
      { at: 20_000, price: 95 },
      { at: 30_000, price: 102 },
    ],
    { bucketMs: 60_000 },
  );

  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0], { time: 0, open: 100, high: 105, low: 95, close: 102 });
});

test('ticks in different buckets become separate candles, in order', () => {
  const candles = buildCandles(
    [
      { at: 0, price: 100 },
      { at: 65_000, price: 110 },
    ],
    { bucketMs: 60_000 },
  );

  assert.equal(candles.length, 2);
  assert.equal(candles[0].time, 0);
  assert.equal(candles[1].time, 60_000);
});

test('bad samples are dropped rather than corrupting a candle', () => {
  const candles = buildCandles([{ at: 0, price: -5 }, { at: 0, price: null }, { at: NaN, price: 100 }]);
  assert.equal(candles.length, 0);
});

test('limit keeps only the most recent candles', () => {
  const samples = Array.from({ length: 5 }, (_, i) => ({ at: i * 60_000, price: 100 + i }));
  const candles = buildCandles(samples, { bucketMs: 60_000, limit: 2 });
  assert.equal(candles.length, 2);
  assert.equal(candles[0].time, 3 * 60_000);
  assert.equal(candles[1].time, 4 * 60_000);
});

test('limit 0 keeps everything', () => {
  const samples = Array.from({ length: 5 }, (_, i) => ({ at: i * 60_000, price: 100 + i }));
  assert.equal(buildCandles(samples, { bucketMs: 60_000, limit: 0 }).length, 5);
});
