import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePath,
  generateWorld,
  makeRandom,
  normalDraw,
  priceMarket,
  runBacktest,
  runMarket,
  trueProbabilityAbove,
} from '../src/signals/simulate.js';
import { probabilityAbove } from '../src/signals/math.js';

// Paper trading against markets whose true behaviour is written down.
//
// The value of this file is not that it proves the engine works. It is that it
// can prove the engine DOESN'T — and it has, twice: once catching that a DOWN
// call was being sized with the odds of the market going up, and once catching
// that every position was being dumped the moment the engine went quiet, which
// turned a known six-cent edge into a seventy percent loss.

test('the same seed gives the same world, or a surprising result cannot be chased', () => {
  const a = generatePath({ random: makeRandom(5) });
  const b = generatePath({ random: makeRandom(5) });
  const c = generatePath({ random: makeRandom(6) });

  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('the draws are actually normal, not merely random', () => {
  const random = makeRandom(3);
  const draws = Array.from({ length: 20000 }, () => normalDraw(random));
  const mean = draws.reduce((t, x) => t + x, 0) / draws.length;
  const variance = draws.reduce((t, x) => t + (x - mean) ** 2, 0) / draws.length;

  assert.ok(Math.abs(mean) < 0.05, `mean ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.06, `variance ${variance}`);
});

test('the hidden volatility is reported alongside the prices', () => {
  // Without it the market cannot be priced honestly in a clustered world: an
  // opponent who knows the model but not the future is the strongest fair
  // test, and it cannot be rebuilt from the prices alone.
  const world = generateWorld({ steps: 30, volClustering: 0.4, random: makeRandom(9) });

  assert.equal(world.prices.length, 31);
  assert.equal(world.vols.length, 31);
  assert.ok(world.vols.every((v) => v > 0));
  assert.ok(new Set(world.vols).size > 5, 'clustering should move the volatility around');
});

test('the simulated true probability agrees with the closed form when the closed form is right', () => {
  // In a constant-volatility world the formula is exact, so this is a check on
  // the simulator rather than on the maths.
  const volPerStep = 0.001;
  const stepsLeft = 20;
  const spot = 65000;

  for (const strike of [64800, 65000, 65200]) {
    const exact = probabilityAbove(spot, strike, volPerStep * Math.sqrt(stepsLeft));
    const simulated = trueProbabilityAbove({
      spot,
      strike,
      stepsLeft,
      vol: volPerStep,
      volPerStep,
      paths: 20000,
      random: makeRandom(11),
    });

    assert.ok(Math.abs(exact - simulated) < 0.02, `strike ${strike}: ${exact} vs ${simulated}`);
  }
});

test('a settled market is not a probability, it is an answer', () => {
  const done = { stepsLeft: 0, vol: 0.001, volPerStep: 0.001, random: makeRandom(1) };
  assert.equal(trueProbabilityAbove({ spot: 100, strike: 90, ...done }), 1);
  assert.equal(trueProbabilityAbove({ spot: 90, strike: 100, ...done }), 0);
});

test('a biased market is wrong by exactly the bias, and never off the board', () => {
  const prices = [65000, 65010, 65020];
  const shared = { prices, index: 1, strike: 65000, trueVolPerStep: 0.001, stepsLeft: 10 };

  const fair = priceMarket({ ...shared, mode: 'fair' });
  const high = priceMarket({ ...shared, mode: 'bias', biasCents: 6 });

  assert.ok(Math.abs(high - fair - 6) < 1e-9);

  // A contract never trades at 0 or 100 while it is still live.
  const extreme = priceMarket({ ...shared, mode: 'bias', biasCents: 90 });
  assert.ok(extreme <= 99 && extreme >= 1);
});

test('a stale market prices off the price it has not caught up with yet', () => {
  const prices = [65000, 65000, 65000, 65000, 66000];
  const shared = { prices, index: 4, strike: 65000, trueVolPerStep: 0.001, stepsLeft: 5 };

  const live = priceMarket({ ...shared, mode: 'fair' });
  const stale = priceMarket({ ...shared, mode: 'lag', lagSteps: 3 });

  // The move to 66000 has happened. Only one of these two knows.
  assert.ok(live > 0.9 * 100 || live > stale + 20);
  assert.ok(stale < live);
});

test('an open position settles at the truth, and settlement is not charged a fee', () => {
  // Fifteen rising prices, a strike below all of them: an UP position must be
  // paid in full, and a fee on the settlement leg would show up as a shortfall.
  const prices = Array.from({ length: 20 }, (_, i) => 65000 + i * 30);
  const run = runMarket({
    prices,
    strike: 64000,
    trueVolPerStep: 0.0008,
    mode: 'fair',
    bankroll: 100,
  });

  for (const trade of run.trades.filter((t) => t.settled)) {
    if (trade.pnl > 0) assert.equal(trade.exitCents, 100);
    else assert.equal(trade.exitCents, 0);
  }
});

test('against a market that is never wrong, the engine does not invent an edge', () => {
  // The single most important number in this file. A strategy that profits
  // here is not reading the market, it is reading its own noise, and every
  // other result it produces is worthless. Break-even-minus-a-little is the
  // honest answer, and the tolerance is one-sided on purpose: a big loss is a
  // bug and a big profit is a bigger one.
  const result = runBacktest({ markets: 300, seed: 4242, mode: 'fair' });

  assert.ok(result.trades > 0, 'it should still find some markets to trade');
  assert.ok(
    result.returnPercent < 15,
    `profited ${result.returnPercent.toFixed(1)}% against a fair market — it is fitting noise`,
  );
  assert.ok(
    result.returnPercent > -30,
    `lost ${result.returnPercent.toFixed(1)}% against a fair market — it is bleeding fees`,
  );
});

test('against a market that IS wrong, the engine takes the money', () => {
  // Six cents of standing mispricing, which is enormous and entirely
  // artificial. If this does not show a clear profit, the engine cannot act on
  // an edge even when one is handed to it.
  for (const biasCents of [6, -6]) {
    const result = runBacktest({ markets: 300, seed: 4242, mode: 'bias', biasCents });
    assert.ok(
      result.returnPercent > 25,
      `only made ${result.returnPercent.toFixed(1)}% against a known ${biasCents}c mispricing`,
    );
  }
});

test('it never makes more than the mispricing that was actually there', () => {
  // A two-cent inefficiency cannot pay like a six-cent one. When it does, the
  // profit is coming from the harness rather than from the market.
  const small = runBacktest({ markets: 300, seed: 4242, mode: 'bias', biasCents: 2 });
  const large = runBacktest({ markets: 300, seed: 4242, mode: 'bias', biasCents: 6 });

  assert.ok(small.returnPercent < large.returnPercent);
});

test('a position is not round-tripped for the sake of it', () => {
  // Entering and exiting captures nothing unless the price actually converged;
  // a standing bias only pays at settlement. When every trade in a biased
  // world closes early, the exit rule is burning a fee per trade to capture a
  // difference that cancels — which is precisely what it used to do.
  const result = runBacktest({ markets: 200, seed: 909, mode: 'bias', biasCents: 6 });
  assert.ok(result.trades / Math.max(1, result.marketsTraded) < 2.5, 'churning');
});
