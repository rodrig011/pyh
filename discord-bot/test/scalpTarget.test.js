import test from 'node:test';
import assert from 'node:assert/strict';

import {
  breakEvenWinRate,
  cheapestToScalp,
  feeShareOfStake,
  inverseNormalCdf,
  scalpPlan,
  spotForPrice,
  touchProbability,
} from '../src/signals/scalpTarget.js';
import { normalCdf, probabilityAbove } from '../src/signals/math.js';

/**
 * "Recommend buy UP or buy DOWN on every market, and scalp ten percent."
 *
 * A genuinely different bet from the rest of this engine, and these tests pin
 * the arithmetic that decides whether it works — because it is the arithmetic,
 * not an opinion, that answers it.
 */

test('the inverse normal really inverts the normal', () => {
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    assert.ok(Math.abs(normalCdf(inverseNormalCdf(p)) - p) < 1e-4, `failed at ${p}`);
  }
  assert.equal(inverseNormalCdf(0), null);
  assert.equal(inverseNormalCdf(1), null);
});

test('the spot implied by a target price prices back to that target', () => {
  const strike = 65_000;
  const sigma = 0.004;
  for (const target of [20, 40, 60, 80]) {
    const spot = spotForPrice(target, strike, sigma);
    const back = probabilityAbove(spot, strike, sigma) * 100;
    assert.ok(Math.abs(back - target) < 0.5, `${target}¢ round-tripped to ${back.toFixed(1)}`);
  }
});

test('touching a level is about twice as likely as finishing beyond it', () => {
  // The reflection principle, and the single most useful fact here: it is why
  // a scalp target gets hit far more often than people expect.
  const sigma = 0.004;
  const spot = 65_000;
  const level = 65_000 * Math.exp(sigma); // one sigma up
  const touch = touchProbability(spot, level, sigma);
  const finish = 1 - normalCdf(1);
  assert.ok(Math.abs(touch - 2 * finish) < 0.02);
});

test('a probability can never exceed one, however close the level', () => {
  assert.equal(touchProbability(65_000, 65_000, 0.004), 1);
  assert.ok(touchProbability(65_000, 65_001, 0.004) <= 1);
});

test('a +10% scalp needs a startling win rate, because the loss is total', () => {
  // Win +10% of the stake, lose 100% of it. Ten wins per loss just to break
  // even — and that is before the exchange is paid.
  for (const entry of [25, 40, 50, 65, 80]) {
    const rate = breakEvenWinRate(entry, 10);
    assert.ok(rate > 0.9, `${entry}¢ only needed ${(rate * 100).toFixed(0)}%`);
  }
});

test('the real touch odds fall short of what break-even demands', () => {
  // This is the whole answer to "can we just scalp 10% every market".
  const plan = scalpPlan({
    side: 'up',
    entryCents: 40,
    spot: 65_000,
    strike: 65_000,
    sigma: 0.0035,
    targetPercent: 10,
  });
  assert.ok(plan.touchProbability < plan.breakEvenWinRate);
  assert.ok(plan.expectedCents < 0);
  assert.equal(plan.verdict, 'against you');
});

test('the fee eats a bigger share of a CHEAP contract, not a dear one', () => {
  // The instinct to scalp cheap lottery tickets is backwards once the exchange
  // is paid: 0.07·(1−P) of the stake per leg falls as the price rises.
  const cheap = feeShareOfStake(15);
  const dear = feeShareOfStake(80);
  assert.ok(cheap > dear * 2, `cheap ${cheap} vs dear ${dear}`);
});

test('the side that costs least to scalp is the expensive one', () => {
  const quotes = { yesAskCents: 20, noAskCents: 80 };
  assert.equal(cheapestToScalp(quotes), 'down', 'NO at 80¢ costs less in fees than YES at 20¢');
});

test('a plan with model edge behind it is labelled differently from a coin flip', () => {
  const base = {
    side: 'up',
    entryCents: 70,
    spot: 65_000,
    strike: 64_800,
    sigma: 0.02,
    targetPercent: 10,
  };
  const flip = scalpPlan({ ...base, edgeCents: 0 });
  const edged = scalpPlan({ ...base, edgeCents: 7 });

  assert.notEqual(flip.verdict, 'worth taking');
  if (edged.touchProbability >= edged.breakEvenWinRate) {
    assert.equal(edged.verdict, 'worth taking');
  }
});

test('a DOWN scalp targets the YES price falling, not rising', () => {
  // The NO side gains as YES loses. Getting this backwards would point every
  // down recommendation at the wrong barrier.
  const up = scalpPlan({ side: 'up', entryCents: 50, spot: 65_000, strike: 65_000, sigma: 0.004 });
  const down = scalpPlan({ side: 'down', entryCents: 50, spot: 65_000, strike: 65_000, sigma: 0.004 });
  assert.ok(up.targetSpot > 65_000);
  assert.ok(down.targetSpot < 65_000);
});

test('a nonsense market produces no plan rather than a made-up one', () => {
  assert.equal(scalpPlan({ side: 'up', entryCents: 0 }), null);
  assert.equal(scalpPlan({ side: 'up', entryCents: 100 }), null);
  assert.equal(spotForPrice(50, 65_000, 0), null);
});
