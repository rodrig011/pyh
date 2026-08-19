import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atr,
  bollingerWidth,
  ema,
  emaSeries,
  emaStack,
  macd,
  priceChangeOverMinutes,
  sessionOf,
} from '../src/signals/indicators.js';

test('ema seeds with a plain average, then smooths forward — hand-checked', () => {
  // period 3, k = 0.5: seed = avg(1,2,3) = 2; then 4*0.5+2*0.5=3; then 5*0.5+3*0.5=4.
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
});

test('ema is null without enough history to seed', () => {
  assert.equal(ema([1, 2], 3), null);
});

test('emaSeries carries one point per tick past the seed, in order', () => {
  const series = emaSeries([1, 2, 3, 4, 5], 3);
  assert.equal(series.length, 3); // indices 2, 3, 4
  assert.equal(series.at(-1).value, ema([1, 2, 3, 4, 5], 3));
});

test('emaStack reads bullish on a clean uptrend and bearish on a clean downtrend', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  const down = Array.from({ length: 60 }, (_, i) => 200 - i);
  assert.equal(emaStack(up, [9, 21, 50]).alignment, 'bullish');
  assert.equal(emaStack(down, [9, 21, 50]).alignment, 'bearish');
});

test('emaStack says null rather than guessing without enough history for the slowest average', () => {
  assert.equal(emaStack([1, 2, 3], [9, 21, 50]).alignment, null);
});

test('macd is null without enough history, not a wrong number', () => {
  assert.equal(macd([1, 2, 3]), null);
});

test('macd on a clean uptrend has a positive line — fast EMA pulls ahead of slow', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i * 2);
  const result = macd(up);
  assert.ok(result.macd > 0);
});

test('bollingerWidth is zero on a flat price and positive once it moves', () => {
  const flat = Array.from({ length: 20 }, () => 100);
  assert.equal(bollingerWidth(flat, { period: 20 }).widthPercent, 0);

  const choppy = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 2 : -2));
  assert.ok(bollingerWidth(choppy, { period: 20 }).widthPercent > 0);
});

test('bollingerWidth is null without a full period', () => {
  assert.equal(bollingerWidth([1, 2, 3], { period: 20 }), null);
});

test('atr — hand-checked on three bars with a period of 2', () => {
  const candles = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 }, // TR = max(2, 2, 0) = 2
    { high: 12, low: 10, close: 11 }, // TR = max(2, 2, 0) = 2
  ];
  assert.equal(atr(candles, 2), 2);
});

test('atr is null without period+1 candles', () => {
  assert.equal(atr([{ high: 1, low: 0, close: 0.5 }], 14), null);
});

test('priceChangeOverMinutes reads the change to the sample nearest the lookback', () => {
  const now = 10 * 60_000;
  const samples = [
    { at: 0, price: 100 },
    { at: 5 * 60_000, price: 110 },
    { at: now, price: 121 },
  ];
  assert.equal(priceChangeOverMinutes(samples, 5, now), 10); // 110 -> 121 is +10%
});

test('priceChangeOverMinutes refuses to answer for a lookback deeper than the history', () => {
  const now = 60_000;
  const samples = [{ at: 0, price: 100 }, { at: now, price: 101 }];
  assert.equal(priceChangeOverMinutes(samples, 15, now), null);
});

test('sessionOf buckets the UTC hour into a labeled session', () => {
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 2)), 'asia');
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 9)), 'london');
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 14)), 'london_ny_overlap');
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 18)), 'new_york');
  assert.equal(sessionOf(Date.UTC(2026, 0, 1, 23)), 'late');
});
