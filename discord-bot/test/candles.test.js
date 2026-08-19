import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandles, buildVolume, rsiSeries } from '../src/dashboard/candles.js';

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

test('rsiSeries is empty until there is enough history for one period', () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({ time: i * 60_000, close: 100 + i }));
  assert.deepEqual(rsiSeries(candles, { period: 14 }), []);
});

test('rsiSeries has one point per candle past the warm-up, each in range', () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({ time: i * 60_000, close: 100 + Math.sin(i / 3) * 5 }));
  const series = rsiSeries(candles, { period: 14 });

  assert.equal(series.length, 40 - 14);
  assert.equal(series[0].time, candles[14].time);
  for (const point of series) assert.ok(point.value >= 0 && point.value <= 100);
});

test('rsiSeries reads 100 on a straight climb with no down ticks', () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({ time: i * 60_000, close: 100 + i }));
  const series = rsiSeries(candles, { period: 14 });
  assert.ok(series.every((point) => point.value === 100));
});

test('buildVolume sums trade size into the same buckets a candle would use', () => {
  const volume = buildVolume(
    [
      { at: 0, count: 50 },
      { at: 20_000, count: 30 },
      { at: 65_000, count: 10 },
    ],
    { bucketMs: 60_000 },
  );
  assert.deepEqual(volume, [
    { time: 0, value: 80 },
    { time: 60_000, value: 10 },
  ]);
});

test('buildVolume drops trades with no usable size or time', () => {
  assert.deepEqual(buildVolume([{ at: 0, count: 0 }, { at: NaN, count: 5 }, { count: 5 }]), []);
});

test('buildVolume is empty with nothing on the tape', () => {
  assert.deepEqual(buildVolume([]), []);
  assert.deepEqual(buildVolume(undefined), []);
});
