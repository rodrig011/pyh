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
