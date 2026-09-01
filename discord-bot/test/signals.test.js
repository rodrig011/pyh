import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedValue,
  feePerContract,
  logReturns,
  normalCdf,
  probabilityAbove,
  realizedVolatility,
  scaleVolatility,
} from '../src/signals/math.js';
import { bookQuality, distanceInSigma, largePrints, momentum, rsi, trendFit } from '../src/signals/indicators.js';
import { VERDICTS, calibration, evaluate } from '../src/signals/engine.js';

// This decides what a paying room is told to put money on. Every number in it
// is checked against one that can be worked out by hand.

test('the normal CDF is right where it matters', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1) - 0.8413447) < 1e-5);
  assert.ok(Math.abs(normalCdf(-1) - 0.1586553) < 1e-5);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-2.58) - 0.00494) < 1e-3);
});

test('volatility scales with the square root of time', () => {
  const perSample = 0.001;
  // Four times the horizon is twice the volatility. This is the reason a
  // market with two minutes left is a different bet from one with eight.
  assert.ok(Math.abs(scaleVolatility(perSample, 30, 120) - perSample * 2) < 1e-12);
  assert.ok(Math.abs(scaleVolatility(perSample, 30, 30) - perSample) < 1e-12);
  assert.equal(scaleVolatility(0, 30, 120), null);
});

test('a strike at the money is a coin flip, and far ones are not', () => {
  const sigma = 0.002;

  assert.ok(Math.abs(probabilityAbove(65000, 65000, sigma) - 0.5) < 0.01);
  // Two sigma above: very likely to stay above.
  assert.ok(probabilityAbove(65000 * Math.exp(2 * sigma), 65000, sigma) > 0.97);
  assert.ok(probabilityAbove(65000 * Math.exp(-2 * sigma), 65000, sigma) < 0.03);
});

test('with no time left the answer is just where it is', () => {
  assert.equal(probabilityAbove(65001, 65000, 0), 1);
  assert.equal(probabilityAbove(64999, 65000, 0), 0);
});

test('the fee peaks exactly where the coin-flip markets are', () => {
  const atFifty = feePerContract(0.5);
  assert.ok(atFifty > feePerContract(0.1));
  assert.ok(atFifty > feePerContract(0.9));
  // Published formula: 0.07 x P x (1-P), rounded up to the cent.
  assert.equal(atFifty, Math.ceil(0.07 * 0.25 * 100) / 100);
});

test('expected value is what is left after the exchange is paid', () => {
  // Model says 60%, contract costs 55c: five cents of edge, less the fee.
  const value = expectedValue(0.6, 0.55);

  assert.ok(Math.abs(value.edge - 0.05) < 1e-9);
  assert.ok(value.net < value.edge, 'the fee has to come out');
  assert.ok(value.breakEvenProbability > 0.55, 'you need more than the price to break even');
});

test('a fair price has no trade in it', () => {
  const value = expectedValue(0.55, 0.55);
  assert.ok(value.net < 0, 'paying the fair price loses the fee, every time');
});

test('realized volatility rises with the size of the moves, not their direction', () => {
  const calm = realizedVolatility(logReturns([100, 100.01, 100.02, 100.01, 100.02]));
  const wild = realizedVolatility(logReturns([100, 101, 99, 102, 98]));

  assert.ok(wild > calm * 10);
  // A straight climb and a straight fall of the same size are equally volatile.
  const up = realizedVolatility(logReturns([100, 101, 102, 103]));
  const down = realizedVolatility(logReturns([103, 102, 101, 100]));
  assert.ok(Math.abs(up - down) < 1e-4);
});

test('RSI reads the extremes it is meant to', () => {
  const climbing = Array.from({ length: 30 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 30 }, (_, i) => 130 - i);

  assert.ok(rsi(climbing) > 95);
  assert.ok(rsi(falling) < 5);
  assert.equal(rsi([1, 2, 3]), null, 'not enough history is not a reading');
});

test('the trend fit knows a line from a mess', () => {
  const line = Array.from({ length: 20 }, (_, i) => 100 + i);
  const noise = [100, 103, 99, 104, 98, 102, 97, 105, 99, 101];

  assert.ok(trendFit(line).r2 > 0.99);
  assert.ok(trendFit(noise).r2 < 0.5);
});

test('distance to the strike is measured in sigma, not dollars', () => {
  // The same $100 gap is a different bet in a calm market than a wild one.
  const calm = distanceInSigma(65100, 65000, 0.0005);
  const wild = distanceInSigma(65100, 65000, 0.005);

  assert.ok(calm > wild * 5);
});

test('a large print is reported with its size, never just called a whale', () => {
  const flow = largePrints(
    [
      { size: 12, price: 65000, side: 'buy' },
      { size: 6, price: 65010, side: 'sell' },
      { size: 1, price: 65005, side: 'buy' },
    ],
    { minimumBtc: 5 },
  );

  // One bitcoin is not a whale and does not count.
  assert.equal(flow.count, 2);
  assert.equal(flow.biggest.size, 12);
  assert.ok(flow.lean > 0, 'more was bought than sold');
});

test('the book is read in cents, whichever way the exchange quotes it', () => {
  assert.equal(bookQuality({ yes_bid_dollars: '0.60', yes_ask_dollars: '0.61' }).spreadCents, 1);
  assert.equal(bookQuality({ yes_bid: 60, yes_ask: 64 }).spreadCents, 4);
  assert.equal(bookQuality({}).spreadCents, null);
});

// A market that is genuinely mispriced, with a clean book and time to run.
const walk = (start, n, step) =>
  Array.from({ length: n }, (_, i) => start * Math.exp(((i % 3) - 1) * step));

test('a fair market is refused, not dressed up as a signal', () => {
  const prices = walk(65000, 40, 0.0004);
  const result = evaluate({
    prices,
    spot: 65000,
    strike: 65000,
    marketPriceCents: 50,
    secondsLeft: 600,
    market: { yes_bid_dollars: '0.49', yes_ask_dollars: '0.50', liquidity_dollars: '500' },
  });

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'no_edge');
});

test('a market priced far from the maths is called, with both numbers shown', () => {
  const prices = walk(65000, 40, 0.0004);
  // Spot sits well above the strike, so up is likely — but it is priced at 40.
  const result = evaluate({
    prices,
    spot: 65120,
    strike: 65000,
    marketPriceCents: 40,
    secondsLeft: 300,
    market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.40', liquidity_dollars: '800' },
  });

  assert.equal(result.verdict, VERDICTS.UP);
  assert.ok(result.probability > 0.5);
  assert.equal(result.marketProbability, 0.4);
  assert.ok(result.edgeCents >= 4);
  assert.ok(result.expected.net > 0);
});

test('a wide spread kills a real edge', () => {
  const prices = walk(65000, 40, 0.0004);
  const result = evaluate({
    prices,
    spot: 65120,
    strike: 65000,
    marketPriceCents: 40,
    secondsLeft: 300,
    market: { yes_bid_dollars: '0.36', yes_ask_dollars: '0.44', liquidity_dollars: '800' },
  });

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'wide_spread');
});

test('an empty book kills a real edge', () => {
  const prices = walk(65000, 40, 0.0004);
  const result = evaluate({
    prices,
    spot: 65120,
    strike: 65000,
    marketPriceCents: 40,
    secondsLeft: 300,
    market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.40', liquidity_dollars: '0' },
  });

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'thin_book');
});

test('a very strong edge can clear a thin but non-empty book with a warning', () => {
  const prices = walk(65000, 40, 0.0004);
  const result = evaluate({
    prices,
    spot: 65120,
    strike: 65000,
    marketPriceCents: 40,
    secondsLeft: 300,
    market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.40', liquidity_dollars: '2' },
  });

  assert.equal(result.verdict, VERDICTS.UP);
  assert.equal(result.liquidityWarning.reason, 'thin_book');
  assert.match(result.notes.join(' '), /Thin book/);
});

test('a weak edge is still blocked on a thin book', () => {
  const prices = walk(65000, 40, 0.0004);
  const result = evaluate(
    {
      prices,
      spot: 65120,
      strike: 65000,
      marketPriceCents: 40,
      secondsLeft: 300,
      market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.40', liquidity_dollars: '2' },
    },
    { thinBookMinimumNetEdgeCents: 100 },
  );

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'thin_book');
});

test('a market that pays almost nothing is refused however right it is', () => {
  const result = evaluate({
    prices: walk(65000, 40, 0.0004),
    spot: 66000,
    strike: 65000,
    marketPriceCents: 97,
    secondsLeft: 300,
  });

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'priced_out');
});

test('a market with seconds left is refused', () => {
  const result = evaluate({
    prices: walk(65000, 40, 0.0004),
    spot: 65120,
    strike: 65000,
    marketPriceCents: 40,
    secondsLeft: 20,
  });

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'too_late');
});

test('a hard trend is refused, because the model assumes a random walk', () => {
  const straight = Array.from({ length: 40 }, (_, i) => 65000 * Math.exp(i * 0.0002));
  const result = evaluate({
    prices: straight,
    spot: straight.at(-1),
    strike: 65000,
    marketPriceCents: 40,
    secondsLeft: 300,
    market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.40', liquidity_dollars: '800' },
  });

  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'trending');
});

test('no price history means no opinion', () => {
  const result = evaluate({ prices: [65000], spot: 65000, strike: 65000, marketPriceCents: 50, secondsLeft: 300 });
  assert.equal(result.verdict, VERDICTS.SKIP);
  assert.equal(result.reason, 'no_vol');
});

test('calibration shows where the engine promised more than it delivered', () => {
  const records = [
    ...Array.from({ length: 10 }, () => ({ probability: 0.85, won: true })),
    ...Array.from({ length: 10 }, () => ({ probability: 0.85, won: false })),
    ...Array.from({ length: 8 }, () => ({ probability: 0.65, won: true })),
    ...Array.from({ length: 2 }, () => ({ probability: 0.65, won: false })),
  ];

  const report = calibration(records);
  const high = report.rows.find((row) => row.from === 80);
  const mid = report.rows.find((row) => row.from === 60);

  // It claimed 85 and delivered 50. That is the number that must be published.
  assert.equal(high.actual, 50);
  assert.ok(high.overconfidencePoints > 30);
  // And it was better than it claimed in the middle bucket.
  assert.equal(mid.actual, 80);
  assert.ok(mid.overconfidencePoints < 0);
});

test('the Brier score catches an engine that is worse than a coin', () => {
  const useless = Array.from({ length: 100 }, (_, i) => ({ probability: 0.9, won: i % 2 === 0 }));
  const honest = Array.from({ length: 100 }, (_, i) => ({ probability: 0.5, won: i % 2 === 0 }));

  assert.ok(calibration(useless).brier > 0.25, 'confident and wrong is worse than saying nothing');
  assert.ok(Math.abs(calibration(honest).brier - 0.25) < 1e-9);
});

// --- Flips and exits ---------------------------------------------------------
// A binary that is winning is not a won bet. These decide when a room is told
// to take the money, and getting them wrong gives back the trades that were
// about to pay most.

test('being touched is exactly twice as likely as finishing beyond', async () => {
  const { flipProbability } = await import('../src/signals/exit.js');
  const { probabilityAbove } = await import('../src/signals/math.js');
  const sigma = 0.002;
  const spot = 65000 * Math.exp(sigma); // one sigma clear

  const finishesWrong = 1 - probabilityAbove(spot, 65000, sigma);
  const touched = flipProbability(spot, 65000, sigma);

  // The reflection principle: touching is about twice as likely as finishing
  // beyond, and that factor of two is the entire point — a position that
  // finishes safe 84% of the time is touched 32% of the time. The exact
  // barrier formula carries the drift term as well, so the two agree closely
  // rather than exactly.
  assert.ok(Math.abs(touched - 2 * finishesWrong) < 0.01);
  assert.ok(touched > 0.3 && touched < 0.35);
});

test('further from the strike is dramatically safer, not linearly safer', async () => {
  const { flipProbability } = await import('../src/signals/exit.js');
  const sigma = 0.002;

  const one = flipProbability(65000 * Math.exp(sigma), 65000, sigma);
  const two = flipProbability(65000 * Math.exp(2 * sigma), 65000, sigma);
  const three = flipProbability(65000 * Math.exp(3 * sigma), 65000, sigma);

  assert.ok(one > 0.3);
  assert.ok(two < 0.06);
  assert.ok(three < 0.005);
});

test('sitting on the strike is a certain touch', async () => {
  const { flipProbability } = await import('../src/signals/exit.js');
  assert.equal(flipProbability(65000, 65000, 0.002), 1);
});

test('a winning position with high flip odds is cashed, not held', async () => {
  const { exitDecision, EXIT_ACTIONS } = await import('../src/signals/exit.js');

  const call = exitDecision({
    entryCents: 39,
    nowCents: 72,
    spot: 65030,
    strike: 65000,
    sigma: 0.0009,
    secondsLeft: 400,
    direction: 'up',
  });

  assert.equal(call.action, EXIT_ACTIONS.CASH_OUT);
  assert.equal(call.reason, 'flip_risk');
  assert.ok(call.movePercent > 80, 'it is well in profit — that is why it is worth protecting');
  assert.match(call.reasons.join(' '), /touches the strike/);
});

test('a position far clear of the strike is held', async () => {
  const { exitDecision, EXIT_ACTIONS } = await import('../src/signals/exit.js');

  const call = exitDecision({
    entryCents: 39,
    nowCents: 55,
    spot: 65000 * Math.exp(0.004),
    strike: 65000,
    sigma: 0.001,
    secondsLeft: 400,
    direction: 'up',
  });

  assert.equal(call.action, EXIT_ACTIONS.HOLD);
  assert.ok(call.flipProbability < 0.05);
});

test('a broken thesis is cut, whatever it cost', async () => {
  const { exitDecision, EXIT_ACTIONS } = await import('../src/signals/exit.js');

  // Bought UP, price is now well below the strike.
  const call = exitDecision({
    entryCents: 55,
    nowCents: 12,
    spot: 65000 * Math.exp(-0.003),
    strike: 65000,
    sigma: 0.001,
    secondsLeft: 300,
    direction: 'up',
  });

  assert.equal(call.action, EXIT_ACTIONS.CUT_LOSS);
  assert.equal(call.reason, 'thesis_broken');
});

test('near the bell, a clear winner holds and everything else leaves', async () => {
  const { exitDecision, EXIT_ACTIONS } = await import('../src/signals/exit.js');
  const base = { entryCents: 40, nowCents: 80, strike: 65000, sigma: 0.001, secondsLeft: 30, direction: 'up' };

  const clear = exitDecision({ ...base, spot: 65000 * Math.exp(0.004) });
  const marginal = exitDecision({ ...base, spot: 65000 * Math.exp(0.0002) });

  assert.equal(clear.action, EXIT_ACTIONS.HOLD);
  assert.equal(clear.reason, 'hold_to_settle');
  assert.equal(marginal.action, EXIT_ACTIONS.CASH_OUT);
  assert.equal(marginal.reason, 'no_time');
});

test('a market that has caught up is left, even in profit', async () => {
  const { exitDecision, EXIT_ACTIONS } = await import('../src/signals/exit.js');

  // Model says 70%, the contract now costs 72c: nothing left to hold for.
  const call = exitDecision({
    entryCents: 45,
    nowCents: 72,
    spot: 65000 * Math.exp(0.0011),
    strike: 65000,
    sigma: 0.002,
    secondsLeft: 400,
    direction: 'up',
  });

  assert.equal(call.action, EXIT_ACTIONS.CASH_OUT);
  assert.ok(['target_hit', 'flip_risk', 'edge_gone'].includes(call.reason));
  assert.ok(call.movePercent > 0);
});

test('a DOWN position is judged on its own side', async () => {
  const { exitDecision, EXIT_ACTIONS } = await import('../src/signals/exit.js');

  // Bought DOWN with price well below the strike: this is winning.
  const call = exitDecision({
    entryCents: 40,
    nowCents: 55,
    spot: 65000 * Math.exp(-0.004),
    strike: 65000,
    sigma: 0.001,
    secondsLeft: 400,
    direction: 'down',
  });

  assert.equal(call.winning, true);
  assert.equal(call.action, EXIT_ACTIONS.HOLD);
});

test('the exact barrier formula stays sane at the extremes', async () => {
  const { flipProbability } = await import('../src/signals/exit.js');

  // Never above 1, never below 0, monotone in distance.
  assert.equal(flipProbability(65000, 65000, 0.01), 1);
  assert.ok(flipProbability(65000 * Math.exp(6 * 0.001), 65000, 0.001) < 1e-6);

  let previous = 1;
  for (let sigmas = 0.5; sigmas <= 4; sigmas += 0.5) {
    const value = flipProbability(65000 * Math.exp(sigmas * 0.002), 65000, 0.002);
    assert.ok(value >= 0 && value <= 1);
    assert.ok(value < previous, 'further from the strike is always safer');
    previous = value;
  }
});

// --- Volatility: the number everything else rests on --------------------------

test('EWMA follows a change in regime that a flat average drags behind', async () => {
  const { ewmaVolatility, plainVolatility } = await import('../src/signals/volatility.js');

  // Quiet for a long time, then it wakes up.
  const returns = [...Array.from({ length: 30 }, () => 0.0001), ...Array.from({ length: 6 }, () => 0.002)];

  const ewma = ewmaVolatility(returns, 0.9);
  const flat = plainVolatility(returns);

  assert.ok(ewma > flat, 'the recent burst has to dominate — that is the point');
});

test('one jump does not become the whole volatility estimate', async () => {
  const { bipowerVolatility, plainVolatility } = await import('../src/signals/volatility.js');

  const calm = Array.from({ length: 40 }, () => 0.0002);
  const withJump = [...calm];
  withJump[20] = 0.02; // one enormous print

  const plainBefore = plainVolatility(calm);
  const plainAfter = plainVolatility(withJump);
  const robustAfter = bipowerVolatility(withJump);

  // The naive estimate is wrecked by a single print.
  assert.ok(plainAfter > plainBefore * 5);
  // The jump-robust one barely notices.
  assert.ok(robustAfter < plainAfter / 2);
});

test('the jump share separates "one big trade" from "the market is moving"', async () => {
  const { jumpShare } = await import('../src/signals/volatility.js');

  const steady = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.0004 : -0.0004));
  const jumpy = [...Array.from({ length: 39 }, () => 0.0001), 0.03];

  assert.ok(jumpShare(steady) < 0.3);
  assert.ok(jumpShare(jumpy) > 0.8);
});

test('the estimate carries the error it actually has', async () => {
  const { volatilityEstimate } = await import('../src/signals/volatility.js');

  const few = volatilityEstimate(Array.from({ length: 10 }, () => 0.0005));
  const many = volatilityEstimate(Array.from({ length: 200 }, () => 0.0005));

  assert.ok(few.high - few.low > many.high - many.low, 'fewer samples, wider band');
  assert.ok(few.low > 0 && few.low < few.sigma && few.sigma < few.high);
  // Standard error of a standard deviation is about sigma / sqrt(2n).
  assert.ok(Math.abs(many.standardError - many.sigma / Math.sqrt(2 * 200)) < 1e-9);
});

test('the pessimistic vol case is always the smaller edge, and it is published', async () => {
  const { evaluate, VERDICTS } = await import('../src/signals/engine.js');

  const prices = Array.from({ length: 12 }, (_, i) => 65000 * Math.exp(((i % 3) - 1) * 0.0006));
  const market = { yes_bid_dollars: '0.49', yes_ask_dollars: '0.50', liquidity_dollars: '900' };
  const input = { prices, spot: 65030, strike: 65000, marketPriceCents: 50, secondsLeft: 300, market };

  const called = evaluate(input);
  assert.equal(called.verdict, VERDICTS.UP);
  // Two numbers, not one: what the edge is, and what it is if the volatility
  // read is wrong in the direction that hurts.
  assert.ok(called.worstEdgeCents < called.edgeCents);
  assert.equal(called.probabilityRange.length, 2);
  assert.ok(called.probabilityRange[0] < called.probability);
  assert.ok(called.probabilityRange[1] > called.probability);
});

test('an edge that only survives the lucky vol read is refused', async () => {
  const { evaluate, VERDICTS } = await import('../src/signals/engine.js');

  const prices = Array.from({ length: 12 }, (_, i) => 65000 * Math.exp(((i % 3) - 1) * 0.0006));
  const input = {
    prices,
    spot: 65030,
    strike: 65000,
    marketPriceCents: 50,
    secondsLeft: 300,
    market: { yes_bid_dollars: '0.49', yes_ask_dollars: '0.50', liquidity_dollars: '900' },
  };

  // Demand more of it: the central estimate still clears the bar, the
  // pessimistic one does not, and that is exactly when it must refuse.
  const strict = evaluate(input, { minimumWorstCaseEdgeCents: 7 });

  assert.equal(strict.verdict, VERDICTS.SKIP);
  assert.equal(strict.reason, 'vol_uncertain');
  assert.match(strict.notes.join(' '), /pessimistic/);
});

test('watching every 30 seconds raises the flip odds, and pretending otherwise costs money', async () => {
  const { flipProbability } = await import('../src/signals/exit.js');
  const sigma = 0.002;
  const spot = 65000 * Math.exp(sigma);

  const continuous = flipProbability(spot, 65000, sigma);
  const discrete = flipProbability(spot, 65000, sigma, { sigmaPerSample: 0.0005 });

  // The correction moves it the safe way: more likely to be touched, so more
  // likely to be told to bank a winner.
  assert.ok(discrete > continuous);
  assert.ok(discrete - continuous > 0.05);
});
