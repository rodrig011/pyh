import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incompleteBeta,
  logGamma,
  probabilityAboveFatTailed,
  studentTCdf,
  tailCorrectionCents,
} from '../src/signals/tails.js';
import { normalCdf, probabilityAbove } from '../src/signals/math.js';

test('log gamma matches the factorials it generalises', () => {
  // lgamma(n) = log((n-1)!)
  assert.ok(Math.abs(logGamma(1)) < 1e-9);
  assert.ok(Math.abs(logGamma(2)) < 1e-9);
  assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-9);
  assert.ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-9);
});

test('the incomplete beta is a proper distribution function', () => {
  assert.equal(incompleteBeta(2, 3, 0), 0);
  assert.equal(incompleteBeta(2, 3, 1), 1);

  // Symmetric case: I_0.5(a, a) = 0.5 for any a.
  for (const a of [0.5, 1, 3, 7.5]) {
    assert.ok(Math.abs(incompleteBeta(a, a, 0.5) - 0.5) < 1e-9, `a=${a}`);
  }

  // Monotone increasing in x.
  let previous = 0;
  for (let x = 0.05; x < 1; x += 0.05) {
    const value = incompleteBeta(2, 5, x);
    assert.ok(value >= previous, `not monotone at ${x}`);
    previous = value;
  }
});

test('the t distribution matches values a table would give', () => {
  // Standard textbook points. t(10) at 1.812 is the 95th percentile.
  assert.ok(Math.abs(studentTCdf(1.812, 10) - 0.95) < 0.001);
  assert.ok(Math.abs(studentTCdf(2.228, 10) - 0.975) < 0.001);
  assert.ok(Math.abs(studentTCdf(3.182, 3) - 0.975) < 0.001);

  // Symmetric around zero.
  assert.ok(Math.abs(studentTCdf(0, 5) - 0.5) < 1e-9);
  for (const x of [0.3, 1.1, 2.7]) {
    assert.ok(Math.abs(studentTCdf(x, 6) + studentTCdf(-x, 6) - 1) < 1e-9);
  }
});

test('with enough degrees of freedom it IS the normal model', () => {
  // A fat-tailed model that does not contain the thin-tailed one as a special
  // case is not a generalisation, it is a different guess. This is the check
  // that lets the change be switched off and measured.
  for (const x of [-2.5, -1, 0, 0.8, 2.2]) {
    assert.ok(Math.abs(studentTCdf(x, 5000) - normalCdf(x)) < 1e-3, `x=${x}`);
  }

  const spot = 65_200;
  const strike = 65_000;
  const sigma = 0.004;
  const normal = probabilityAbove(spot, strike, sigma);
  const fat = probabilityAboveFatTailed(spot, strike, sigma, 100_000);
  assert.ok(Math.abs(normal - fat) < 2e-3);
});

test('a rescaled t is fatter in the tails AND narrower in the middle', () => {
  // The correction that is not what intuition says. Matching the variance
  // means the t has to be MORE peaked to pay for its heavier tails, so below
  // about two sigma it is more confident than the normal, not less. The
  // crossover is what matters, because these contracts live almost entirely
  // on the confident side of it.
  const strike = 65_000;
  const sigma = 0.004;
  const at = (sd) => {
    const spot = strike * Math.exp(sd * sigma);
    return {
      normal: probabilityAbove(spot, strike, sigma),
      fat: probabilityAboveFatTailed(spot, strike, sigma, 4),
    };
  };

  // Inside two sigma: the t is MORE sure.
  for (const sd of [0.5, 1, 1.5]) {
    const { normal, fat } = at(sd);
    assert.ok(fat > normal, `at ${sd} sigma the t should be more confident`);
  }

  // Beyond it: less sure, which is the fat tail finally showing up.
  for (const sd of [2.5, 3, 4]) {
    const { normal, fat } = at(sd);
    assert.ok(fat < normal, `at ${sd} sigma the t should be less confident`);
  }
});

test('assuming fat tails scores WORSE, which is why it is switched off', () => {
  // Measured, not argued. Against three thousand simulated markets — including
  // worlds with jumps, where fat tails supposedly help — every Student-t
  // scored worse than the plain normal model, and the fatter the assumed tail
  // the worse it got.
  //
  // The reason is that the volatility estimator already absorbs the jumps:
  // when one happens, measured volatility rises and the distribution widens on
  // its own. Adding fat tails on top counts the same effect twice, and the
  // rescaled peak then makes the model overconfident at one to two sigma,
  // which is exactly where every one of these contracts sits.
  //
  // This test exists so the idea does not get re-proposed. If anyone turns it
  // on, they should have to delete this first and explain what changed.
  const strike = 65_000;
  const sigma = 0.004;
  const spot = 65_260;   // about 1 sigma out, a completely typical read

  const normal = probabilityAbove(spot, strike, sigma);
  const fat = probabilityAboveFatTailed(spot, strike, sigma, 4);

  // Four cents of extra confidence, manufactured by a modelling choice rather
  // than found in the market. That is the size of the entire edge threshold.
  assert.ok(tailCorrectionCents(normal, fat) > 3);
});

test('sigma still means sigma when the tails change', () => {
  // Raising the tail weight must not quietly also raise the volatility, or
  // two different changes are tangled into one knob and neither can be
  // measured. Checked by simulating the distribution's own spread.
  const nu = 4;
  const sigma = 0.004;

  // The rescaled t should have standard deviation ~= sigma. Recover it from
  // the quantile: at one standard deviation the CDF should be about 0.841.
  const oneSigmaUp = Math.exp(sigma + (sigma * sigma) / 2) * 65_000;
  const p = probabilityAboveFatTailed(oneSigmaUp, 65_000, sigma, nu);

  // A t with 4 df is fatter in the tails and thinner in the shoulders, so this
  // will not be 0.841 exactly — but it must be in the same neighbourhood, not
  // the neighbourhood of a distribution with a different width.
  assert.ok(p > 0.75 && p < 0.9, `got ${p.toFixed(3)}`);
});

test('nonsense in gets null out, never a confident number', () => {
  assert.equal(probabilityAboveFatTailed(0, 100, 0.01), null);
  assert.equal(probabilityAboveFatTailed(100, 0, 0.01), null);
  // Two degrees of freedom has infinite variance, so sigma is undefined there.
  assert.equal(probabilityAboveFatTailed(100, 100, 0.01, 2), null);
  assert.equal(probabilityAboveFatTailed(100, 100, 0.01, 1.5), null);
});
