import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENCE, confidenceOf, directionalRead, readRecord } from '../src/signals/direction.js';
import { VERDICTS } from '../src/signals/engine.js';

// A read on every market, not only the one in ten worth paying to trade.
// "Which way is this leaning" and "is there money in it after costs" are
// different questions, and the engine was answering only the second one.

// A series with realistic 15-minute bitcoin volatility, deterministic so the
// tests do not wobble. Too smooth a fixture makes the model certain of
// everything and tests nothing.
const history = () => {
  const prices = [];
  let price = 65_000;
  let state = 12345;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const shock = (state / 4294967296 - 0.5) * 0.0028;
    price *= Math.exp(shock);
    prices.push(price);
  }
  return prices;
};

const market = (over = {}) => ({
  prices: history(),
  spot: 65_050,
  strike: 65_000,
  marketPriceCents: 55,
  market: { yes_bid_dollars: '0.54', yes_ask_dollars: '0.56', liquidity_dollars: '1000' },
  secondsLeft: 400,
  ...over,
});

test('the model has an opinion on a market it would refuse to trade', () => {
  // The whole point. The engine skips when the edge is under six cents, which
  // is most of the time — and a skip was throwing away a perfectly good read.
  const read = directionalRead(market({ marketPriceCents: 88 }));

  assert.ok(read.call === VERDICTS.UP || read.call === VERDICTS.DOWN);
  assert.ok(Number.isFinite(read.winProbability));
  // And it says plainly that this is a read, not a trade.
  assert.equal(read.tradeable, false);
  assert.ok(read.whyNotTradeable, 'a refusal has to give its reason');
});

test('a read is never dressed up as a trade', () => {
  const read = directionalRead(market({ marketPriceCents: 88 }));
  assert.equal(read.tradeable, false);

  // The two must be separate fields, so nothing downstream can mistake a lean
  // for a recommendation by reading the wrong one.
  assert.notEqual(read.call, null);
  assert.equal(read.result.verdict, VERDICTS.SKIP);
});

test('genuinely knowing nothing is reported as knowing nothing', () => {
  // No history at all: there is no volatility to measure and therefore no
  // opinion to have. This must come back as null, never as a coin flip
  // wearing a direction.
  const read = directionalRead(market({ prices: [], spot: null }));

  assert.equal(read.call, null);
  assert.equal(read.confidence, CONFIDENCE.NONE);
  assert.equal(read.tradeable, false);
});

test('confidence is named unflatteringly, because 58% is not a sure thing', () => {
  assert.equal(confidenceOf(0.5), CONFIDENCE.COIN_FLIP);
  assert.equal(confidenceOf(0.53), CONFIDENCE.COIN_FLIP);
  assert.equal(confidenceOf(0.58), CONFIDENCE.LEAN);
  assert.equal(confidenceOf(0.7), CONFIDENCE.STRONG);
  // Symmetric: a strong DOWN is as strong as a strong UP.
  assert.equal(confidenceOf(0.3), CONFIDENCE.STRONG);
  assert.equal(confidenceOf(null), CONFIDENCE.NONE);
});

test('a DOWN read reports the odds that DOWN wins', () => {
  // The bug that cost real money once already, in a new place. `probability`
  // is always the chance of finishing ABOVE; a DOWN call wins on one minus it.
  const read = directionalRead(market({ spot: 64_000, marketPriceCents: 20 }));

  assert.equal(read.call, VERDICTS.DOWN);
  assert.ok(read.winProbability > 0.5, 'a DOWN call it believes in must be over 50%');
  assert.ok(read.result.probability < 0.5, 'while the chance of finishing above is under');
});

test('an 85% hit rate that loses money is reported as losing money', () => {
  // The number every product in this space advertises, and the reason it is
  // worthless alone. Calling contracts that trade at 88c is right seven times
  // in eight — and each loss costs seven times what each win pays.
  const reads = [];
  for (let i = 0; i < 80; i += 1) {
    reads.push({
      call: VERDICTS.UP,
      confidence: CONFIDENCE.STRONG,
      winProbability: 0.88,
      entryCents: 88,
      outcome: i % 8 === 0 ? 0 : 1,
    });
  }

  const record = readRecord(reads);

  assert.ok(record.hitRate > 0.85, 'the flattering number');
  assert.ok(record.centsPerCall < 0, 'and the one that matters');
});

test('a modest hit rate that makes money is reported as making money', () => {
  // The mirror image, and the reason hit rate is not just useless but
  // backwards: 55% at a fair price beats 88% at a bad one.
  const reads = [];
  for (let i = 0; i < 100; i += 1) {
    reads.push({
      call: VERDICTS.UP,
      confidence: CONFIDENCE.LEAN,
      winProbability: 0.58,
      entryCents: 50,
      outcome: i % 100 < 58 ? 1 : 0,
    });
  }

  const record = readRecord(reads);
  assert.ok(record.hitRate < 0.6);
  assert.ok(record.centsPerCall > 5, 'clears the fee comfortably');
});

test('the record says how often it said it, against how often it happened', () => {
  // Calibration by confidence tier. A tier that says 70% and delivers 52% is
  // broken, and the average hit rate would hide it.
  const reads = [];
  for (let i = 0; i < 60; i += 1) {
    reads.push({
      call: VERDICTS.UP,
      confidence: CONFIDENCE.STRONG,
      winProbability: 0.75,
      entryCents: 50,
      outcome: i % 2,
    });
  }

  const record = readRecord(reads);
  const strong = record.byConfidence.find((row) => row.confidence === CONFIDENCE.STRONG);

  assert.ok(Math.abs(strong.stated - 0.75) < 0.01);
  assert.ok(Math.abs(strong.actual - 0.5) < 0.01, 'says 75, delivers 50');
});

test('DOWN calls are graded on the down outcome, not the up one', () => {
  const reads = [
    { call: VERDICTS.DOWN, confidence: CONFIDENCE.LEAN, winProbability: 0.6, entryCents: 40, outcome: 0 },
    { call: VERDICTS.DOWN, confidence: CONFIDENCE.LEAN, winProbability: 0.6, entryCents: 40, outcome: 1 },
  ];

  const record = readRecord(reads);
  // One right, one wrong.
  assert.equal(record.hitRate, 0.5);
});

test('nothing graded means nothing claimed', () => {
  const record = readRecord([{ call: VERDICTS.UP, outcome: null }]);
  assert.equal(record.graded, 0);
  assert.equal(record.hitRate, null);
});

test('the likely side and the side worth buying are reported separately', () => {
  // The most expensive confusion in this whole space, and the reason a single
  // arrow cannot be honest. The model says the market probably goes UP — and
  // UP costs 88¢, which is far too much to pay for a 60% chance. The side
  // worth owning is DOWN, and both facts have to be visible at once.
  const read = directionalRead(
    market({
      marketPriceCents: 88,
      market: { yes_bid_dollars: '0.87', yes_ask_dollars: '0.89', liquidity_dollars: '1000' },
    }),
  );

  assert.equal(read.leaning, VERDICTS.UP, 'up is genuinely more likely');
  assert.equal(read.call, VERDICTS.DOWN, 'and down is the side worth owning');
  assert.equal(read.disagrees, true);
  assert.ok(read.valueCents > 0, 'the cheap side is genuinely cheap');
});

test('when they agree, they agree quietly', () => {
  const read = directionalRead(
    market({
      marketPriceCents: 40,
      market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.41', liquidity_dollars: '1000' },
    }),
  );

  assert.equal(read.leaning, read.call);
  assert.equal(read.disagrees, false);
});

test('a fairly priced market has no cheap side, and does not pretend to', () => {
  // Both sides priced at what the model thinks they are worth. Picking the
  // marginally-less-bad one and flagging it as a disagreement would be
  // inventing a decision out of rounding error.
  const read = directionalRead(
    market({
      marketPriceCents: 60,
      market: { yes_bid_dollars: '0.59', yes_ask_dollars: '0.61', liquidity_dollars: '1000' },
    }),
  );

  assert.equal(read.disagrees, false, 'no side is cheap, so nothing disagrees');
  assert.equal(read.call, read.leaning);
  assert.equal(read.tradeable, false);
});

test('a 25% call is never described as strong without saying it usually loses', async () => {
  // The message that confused the room: "UP · strong" with the model at 25%.
  // Both true, together nonsense. The call WAS the right side to buy — up cost
  // 24¢ and was worth 25 — and it also loses three times in four.
  const { likelihoodOf } = await import('../src/signals/direction.js');

  assert.equal(confidenceOf(0.25), CONFIDENCE.STRONG, 'far from a coin flip');
  assert.equal(likelihoodOf(0.25), 'usually loses', 'and usually loses');

  // The two must never be the same axis, or one keeps being read as the other.
  assert.equal(likelihoodOf(0.75), 'usually wins');
  assert.equal(confidenceOf(0.75), CONFIDENCE.STRONG);
  assert.equal(likelihoodOf(0.5), 'a coin flip');
});

test('every call carries somewhere to get out, and a floor below which it loses', async () => {
  const { exitPlan } = await import('../src/signals/direction.js');

  // Bought at 40¢, model says it is worth 55¢.
  const plan = exitPlan(40, 0.55);

  assert.ok(Math.abs(plan.targetCents - 55) < 1e-9);
  // The floor is above the entry, always: the exchange is paid both ways.
  assert.ok(plan.minimumExitCents > 40);
  assert.equal(plan.targetClearsCosts, true);
});

test('a target that cannot cover the round trip is called out, not printed as a plan', async () => {
  const { exitPlan } = await import('../src/signals/direction.js');

  // Bought at 50¢, model says 51¢. One cent does not pay for two fees, so
  // there is no exit here that works — a different problem from "no edge", and
  // one a member would otherwise discover by taking the trade.
  const plan = exitPlan(50, 0.51);

  assert.equal(plan.targetClearsCosts, false);
  assert.ok(plan.minimumExitCents > plan.targetCents);
});

test('a refusal says the exact price that would change its mind', async () => {
  // "No trade" on its own sends somebody back to ask again in thirty seconds.
  // The engine wants a fixed edge before acting, so the price that turns the
  // refusal into a call is arithmetic, not opinion.
  const { triggerPrices } = await import('../src/signals/direction.js');

  // Model says the up side is worth 60. With a six point threshold, up becomes
  // a buy at 54 and down (worth 40) becomes a buy at 34.
  const t = triggerPrices(0.6, { minimumEdgeCents: 6 });

  assert.ok(Math.abs(t.upAt - 54) < 1e-9);
  assert.ok(Math.abs(t.downAt - 34) < 1e-9);
  // And stated in the units the screen actually shows.
  assert.ok(Math.abs(t.downAtYesPrice - 66) < 1e-9);
});

test('a side that can never become cheap enough is not offered as a target', async () => {
  const { triggerPrices } = await import('../src/signals/direction.js');

  // The model gives the down side almost nothing, so no price for it clears a
  // six point edge. Printing a negative target would be worse than silence.
  const t = triggerPrices(0.97, { minimumEdgeCents: 6 });
  assert.equal(t.downAt, null);
  assert.ok(t.upAt > 0);
});

test('every read carries its triggers, so a no is always actionable', () => {
  const read = directionalRead(
    market({
      marketPriceCents: 60,
      market: { yes_bid_dollars: '0.59', yes_ask_dollars: '0.61', liquidity_dollars: '1000' },
    }),
  );

  assert.equal(read.tradeable, false);
  assert.ok(read.triggers, 'a refusal must still say what it is waiting for');
  assert.ok(read.triggers.upAt !== null || read.triggers.downAt !== null);
});
