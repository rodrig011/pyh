import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TUNEABLE_REASONS,
  appendMiss,
  makeMiss,
  missPatterns,
  settleMisses,
  verdictFor,
} from '../src/signals/misses.js';

/**
 * "I'll be furious if I find out it missed trades."
 *
 * Fair, and until now uncheckable: a refusal left no trace beyond a counter, so
 * "being appropriately careful" and "throwing away money" produced the
 * identical report. These tests are about turning that argument into a table.
 */

const miss = (over = {}) =>
  makeMiss({
    at: 1_000_000,
    ticker: 'KXBTC-65000',
    strike: 65_000,
    reason: 'no_edge',
    side: 'up',
    entryCents: 45,
    spot: 65_010,
    secondsLeft: 300,
    edgeCents: 4,
    ...over,
  });

test('only refusals that could plausibly have been trades are kept', () => {
  // A market refused for having no price is not a missed opportunity, it is an
  // absence of information, and logging those buries the rows that mean
  // something.
  assert.ok(miss({ reason: 'no_edge' }));
  assert.ok(miss({ reason: 'wide_spread' }));
  assert.equal(miss({ reason: 'no_price' }), null);
  assert.equal(miss({ reason: 'no_clock' }), null);
  assert.equal(TUNEABLE_REASONS.has('no_price'), false);
});

test('a miss without a real market behind it is not recorded', () => {
  assert.equal(miss({ ticker: '' }), null);
  assert.equal(miss({ strike: 0 }), null);
  assert.equal(miss({ entryCents: 0 }), null);
  assert.equal(miss({ entryCents: 100 }), null);
  assert.equal(miss({ side: 'sideways' }), null);
  assert.equal(miss({ spot: 0 }), null);
});

test('one contract gets ONE row, the one with the most edge', () => {
  // A 15-minute market is refused about ninety times. Ninety rows for one
  // decision would drown the log and count one opinion ninety times over.
  let log = appendMiss([], miss({ edgeCents: 2 }));
  log = appendMiss(log, miss({ edgeCents: 5 }));
  log = appendMiss(log, miss({ edgeCents: 3 }));

  assert.equal(log.length, 1);
  assert.equal(log[0].edgeCents, 5, 'the version most worth arguing with');
});

test('a different contract is a different row', () => {
  let log = appendMiss([], miss({ ticker: 'A' }));
  log = appendMiss(log, miss({ ticker: 'B' }));
  assert.equal(log.length, 2);
});

test('a settled row is never overwritten by a new look', () => {
  const settled = { ...miss(), won: 1 };
  const log = appendMiss([settled], miss({ edgeCents: 99 }));
  assert.equal(log.length, 2);
  assert.equal(log[0].won, 1);
});

test('the log stays bounded', () => {
  let log = [];
  for (let i = 0; i < 5000; i += 1) log = appendMiss(log, miss({ ticker: `T-${i}` }));
  assert.ok(log.length <= 4000);
});

test('a miss is graded on the settlement average, like the contract itself', () => {
  const at = 1_000_000;
  const closesAt = at + 300_000;
  // Spot finishing above the strike: an UP miss would have won.
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: closesAt - t, price: 65_200 });

  const log = settleMisses([miss({ at, secondsLeft: 300 })], {
    now: closesAt + 60_000,
    samples,
  });
  assert.equal(log[0].won, 1);
});

test('the side stored is the one it WOULD have taken, not the winner', () => {
  // Storing the winning side after the fact would make every gate look
  // catastrophic.
  const at = 1_000_000;
  const closesAt = at + 300_000;
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: closesAt - t, price: 64_800 });

  const log = settleMisses([miss({ at, secondsLeft: 300, side: 'up' })], {
    now: closesAt + 60_000,
    samples,
  });
  assert.equal(log[0].won, 0, 'an UP miss that finished below is a loss');
});

test('a market that has not closed yet is left ungraded', () => {
  const log = settleMisses([miss()], { now: 1_100_000, samples: [{ at: 1_000_000, price: 65_000 }] });
  assert.equal(log[0].won, null);
});

test('with no spot around the bell it stays ungraded rather than guessing', () => {
  const log = settleMisses([miss()], { now: 9_000_000, samples: [{ at: 1, price: 65_000 }] });
  assert.equal(log[0].won, null);
});

test('the patterns say what each gate cost, per contract', () => {
  const log = [
    { reason: 'no_edge', entryCents: 50, won: 1 },
    { reason: 'no_edge', entryCents: 50, won: 0 },
    { reason: 'wide_spread', entryCents: 30, won: 1 },
    { reason: 'wide_spread', entryCents: 30, won: 1 },
  ];
  const patterns = missPatterns(log, { minimumSettled: 2 });

  const spread = patterns.find((row) => row.reason === 'wide_spread');
  const edge = patterns.find((row) => row.reason === 'no_edge');

  assert.equal(spread.winRate, 1);
  assert.equal(spread.centsPerContract, 70, 'won at 30c, paid 100');
  assert.equal(edge.centsPerContract, 0, 'one win one loss at 50c is a wash');
  // Best first, so the most expensive gate is the first thing read.
  assert.equal(patterns[0].reason, 'wide_spread');
});

test('a small sample is never given a verdict', () => {
  const [pattern] = missPatterns([{ reason: 'no_edge', entryCents: 50, won: 1 }]);
  assert.equal(pattern.enough, false);
  assert.match(verdictFor(pattern), /not enough/);
});

test('the verdict names which way the gate is wrong', () => {
  assert.match(verdictFor({ enough: true, centsPerContract: 9 }), /costing money/);
  assert.match(verdictFor({ enough: true, centsPerContract: -9 }), /saving money/);
  assert.match(verdictFor({ enough: true, centsPerContract: 0.4 }), /neutral/);
});

test('ungraded rows never reach the patterns', () => {
  assert.deepEqual(missPatterns([{ reason: 'no_edge', entryCents: 50, won: null }]), []);
});
