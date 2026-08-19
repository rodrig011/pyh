import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLEMENT_WINDOW_SECONDS,
  averagingEdgeCents,
  effectiveSecondsLeft,
  settlementReference,
} from '../src/signals/settlement.js';
import { makeRandom, normalDraw } from '../src/signals/simulate.js';
import { probabilityAbove, scaleVolatility } from '../src/signals/math.js';

// Kalshi settles crypto on a 60-second AVERAGE, not on the final price. Those
// are different instruments, and the difference is worth about five cents near
// the bell — the size of the engine's whole edge threshold.

test('an average-settled contract has forty seconds less on the clock', () => {
  // Var(A) = sigma^2 (tau - 2h/3) outside the window.
  assert.ok(Math.abs(effectiveSecondsLeft(900) - 860) < 1e-9);
  assert.ok(Math.abs(effectiveSecondsLeft(300) - 260) < 1e-9);
  assert.ok(Math.abs(effectiveSecondsLeft(120) - 80) < 1e-9);
});

test('the two branches agree exactly at the edge of the window', () => {
  // A formula with a seam in it is a formula with a bug waiting at the seam.
  const h = SETTLEMENT_WINDOW_SECONDS;
  const justOutside = effectiveSecondsLeft(h + 1e-7);
  const atEdge = effectiveSecondsLeft(h);
  assert.ok(Math.abs(justOutside - atEdge) < 1e-4, `${justOutside} vs ${atEdge}`);
  // And that shared value is h/3.
  assert.ok(Math.abs(atEdge - h / 3) < 1e-9);
});

test('uncertainty collapses inside the window but never quite to nothing', () => {
  let previous = Infinity;
  for (const tau of [60, 45, 30, 20, 10, 5, 1]) {
    const value = effectiveSecondsLeft(tau);
    assert.ok(value < previous, `not falling at ${tau}s`);
    assert.ok(value > 0, `no uncertainty left at ${tau}s`);
    previous = value;
  }
  assert.equal(effectiveSecondsLeft(0), 0);
  assert.equal(effectiveSecondsLeft(-5), 0);
});

test('the correction is always in the same direction: less time, never more', () => {
  for (const tau of [1, 30, 59, 60, 61, 200, 900, 5000]) {
    assert.ok(
      effectiveSecondsLeft(tau) < tau,
      `averaging must never add uncertainty (${tau}s)`,
    );
  }
});

test('the variance formula matches a simulation of the actual average', () => {
  // The claim is arithmetic, so it can be checked against the thing it
  // describes rather than believed. Simulate the last stretch of a market,
  // average the final sixty seconds, and compare the spread of that average
  // against what effectiveSecondsLeft predicts.
  const h = SETTLEMENT_WINDOW_SECONDS;
  const sigmaPerSecond = 0.0001;
  const random = makeRandom(99);

  for (const tau of [30, 60, 180]) {
    const averages = [];
    for (let run = 0; run < 4000; run += 1) {
      let x = 0;
      const window = [];
      for (let s = 1; s <= tau; s += 1) {
        x += normalDraw(random) * sigmaPerSecond;
        // The final h seconds are the ones that get averaged.
        if (tau - s < h) window.push(x);
      }
      // Seconds of the window that elapsed before we started watching
      // contribute zero (we measure everything relative to now).
      const banked = h - window.length;
      averages.push(window.reduce((t, v) => t + v, 0) / (window.length + banked));
    }

    const mean = averages.reduce((t, v) => t + v, 0) / averages.length;
    const variance =
      averages.reduce((t, v) => t + (v - mean) ** 2, 0) / (averages.length - 1);

    const predicted = sigmaPerSecond * sigmaPerSecond * effectiveSecondsLeft(tau);
    const ratio = variance / predicted;

    assert.ok(ratio > 0.9 && ratio < 1.1, `tau=${tau}: simulated/predicted = ${ratio.toFixed(3)}`);
  }
});

test('near the bell the correction is worth about five cents', () => {
  // The number that makes this worth doing. One sigma away from the strike
  // with two minutes left, ignoring the averaging costs about five cents of
  // probability — and it was being given away in the direction that makes the
  // engine call fairly priced contracts overpriced.
  const strike = 65_000;
  const sigmaPerSample = 0.0008;
  const secondsLeft = 120;

  const naive = scaleVolatility(sigmaPerSample, 30, secondsLeft);
  const corrected = scaleVolatility(sigmaPerSample, 30, effectiveSecondsLeft(secondsLeft));
  const spot = strike * Math.exp(naive);

  const without = probabilityAbove(spot, strike, naive);
  const with_ = probabilityAbove(spot, strike, corrected);
  const gain = averagingEdgeCents(without, with_);

  assert.ok(corrected < naive, 'the corrected horizon must be shorter');
  assert.ok(gain > 3, `only ${gain?.toFixed(2)}c — expected around five`);
});

test('outside the window the reference is simply the spot', () => {
  const reference = settlementReference(65_000, 300);
  assert.equal(reference.price, 65_000);
  assert.equal(reference.banked, 0);
  assert.equal(reference.exact, true);
});

test('a spike in the last twenty seconds settles lower than it trades', () => {
  // Forty of the sixty seconds were printed before the spike, and they are
  // already in the average. A model reading only the spot thinks the contract
  // is worth far more than it will actually settle at.
  const reference = settlementReference(66_000, 20, { windowAverageSoFar: 65_000 });

  assert.ok(reference.price < 66_000, 'the banked seconds must drag it down');
  assert.ok(reference.price > 65_000);
  // Forty seconds at 65000, twenty at 66000.
  assert.ok(Math.abs(reference.price - (65_000 * 40 + 66_000 * 20) / 60) < 1e-6);
  assert.ok(Math.abs(reference.banked - 2 / 3) < 1e-9);
  assert.equal(reference.exact, true);
});

test('with no window reading it falls back to spot and says so', () => {
  // The old behaviour, kept — but flagged as an estimate rather than passed
  // off as exact, because inside the window it is genuinely wrong.
  const reference = settlementReference(65_000, 20);
  assert.equal(reference.price, 65_000);
  assert.equal(reference.exact, false);
  assert.ok(reference.banked > 0);
});

test('nonsense in gets null out', () => {
  assert.equal(settlementReference(0, 100), null);
  assert.equal(settlementReference(-5, 100), null);
  assert.equal(averagingEdgeCents(null, 0.5), null);
});
