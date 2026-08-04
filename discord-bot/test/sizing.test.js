import test from 'node:test';
import assert from 'node:assert/strict';
import { growthCurve, growthRate, kellyFraction, project, recommendSize } from '../src/signals/sizing.js';

// Size is the only part of the growth rate anyone can turn a dial on, and it
// does not behave the way intuition says. These pin the arithmetic that says so.

test('Kelly is the edge over the odds', () => {
  // A 60% chance on a contract costing 50c: odds of 1:1, edge of 20 points.
  assert.ok(Math.abs(kellyFraction(0.6, 0.5) - 0.2) < 1e-9);
  // No edge, no bet.
  assert.equal(kellyFraction(0.5, 0.5), 0);
  // A losing bet is never sized up.
  assert.equal(kellyFraction(0.4, 0.5), 0);
});

test('growth peaks at Kelly and is negative at twice it', () => {
  const q = 0.62;
  const p = 0.55;
  const full = kellyFraction(q, p);

  const atHalf = growthRate(q, p, full * 0.5);
  const atFull = growthRate(q, p, full);
  const atOneAndAHalf = growthRate(q, p, full * 1.5);
  const atDouble = growthRate(q, p, full * 2);

  assert.ok(atFull > atHalf, 'more size is more growth, up to a point');
  assert.ok(atFull > atOneAndAHalf, 'and past the point it falls');
  // The result that ends the argument: the same winning edge, sized at twice
  // Kelly, has a long-run growth rate of zero or worse.
  assert.ok(atDouble <= 0);
});

test('betting bigger than double a real edge loses money with certainty', () => {
  const q = 0.62;
  const p = 0.55;
  const full = kellyFraction(q, p);

  assert.ok(growthRate(q, p, Math.min(0.99, full * 2.5)) < 0);
  assert.ok(growthRate(q, p, Math.min(0.99, full * 3)) < 0);
});

test('the curve rises then falls, every time', () => {
  const rows = growthCurve(0.62, 0.55, { steps: 10 });
  const peak = rows.reduce((best, row) => (row.growth > best.growth ? row : best));

  // The peak sits at Kelly, not at the biggest size on the list.
  assert.ok(Math.abs(peak.ofKelly - 1) < 0.15);
  assert.ok(rows.at(-1).growth < peak.growth);
});

test('the recommendation sizes on the pessimistic probability, not the hoped one', () => {
  const optimistic = recommendSize({ probability: 0.62, priceDollars: 0.55 });
  const honest = recommendSize({ probability: 0.62, worstProbability: 0.57, priceDollars: 0.55 });

  // Kelly punishes overestimating the edge far harder than underestimating it,
  // and the probability comes from a volatility estimate with real error.
  assert.ok(honest.suggested < optimistic.suggested);
  assert.ok(honest.suggested > 0);
});

test('a quarter of Kelly is the default, and there is a hard ceiling', () => {
  const sized = recommendSize({ probability: 0.62, priceDollars: 0.55 });
  assert.ok(Math.abs(sized.suggested / sized.fullKelly - 0.25) < 1e-9);

  // Even an enormous edge cannot talk the bot into betting the account.
  const huge = recommendSize({ probability: 0.95, priceDollars: 0.2, maximumFraction: 0.1 });
  assert.ok(huge.suggested <= 0.1);
});

test('a small per-bet growth rate is an enormous annual one', () => {
  // This is why "2% a day" sounds low to anyone without exponential intuition.
  const projection = project(0.0033, { betsPerDay: 6, days: 30, start: 100 });

  assert.ok(projection.dailyPercent > 1.5 && projection.dailyPercent < 2.5);
  assert.ok(projection.daysToDouble > 30 && projection.daysToDouble < 40);
  assert.ok(projection.annualPercent > 100_000, 'compounding is the whole story');
});

test('no growth means no doubling, rather than a divide by zero', () => {
  assert.equal(project(0).daysToDouble, null);
  assert.equal(project(-0.01).daysToDouble, null);
});

test('the signal card shows both probabilities and never a confidence score', async () => {
  const { signalEmbed } = await import('../src/bots/signalBot.js');

  const card = signalEmbed(
    {
      verdict: 'up',
      probability: 0.64,
      marketProbability: 0.55,
      edgeCents: 9,
      worstEdgeCents: 4.2,
      entryCents: 55,
      expected: { net: 0.062 },
      flipProbability: 0.28,
      distanceSigma: 1.4,
      volatility: { sigma: 0.0008, standardError: 0.00009 },
      book: { spreadCents: 1 },
      notes: [],
    },
    { asset: 'BTC', ticker: 'KXBTC15M-X', secondsLeft: 420 },
  ).toJSON();

  const text = JSON.stringify(card);
  assert.match(text, /64%/);
  assert.match(text, /55%/);
  assert.match(text, /9.0¢ wrong/);
  // The pessimistic case is published beside the central one, always.
  assert.match(text, /4.2¢ wrong/);
  assert.doesNotMatch(text, /confidence/i);
});

test('a refusal explains itself instead of showing an arrow', async () => {
  const { signalEmbed } = await import('../src/bots/signalBot.js');

  const card = signalEmbed(
    { verdict: 'skip', reason: 'fee_eats_it', explain: 'The edge is real but smaller than the fee.' },
    { asset: 'BTC', ticker: 'KXBTC15M-X', secondsLeft: 300 },
  ).toJSON();

  assert.match(card.title, /STAY OUT/);
  assert.match(JSON.stringify(card), /smaller than the fee/);
  assert.match(JSON.stringify(card), /Refusing is the product/);
});
