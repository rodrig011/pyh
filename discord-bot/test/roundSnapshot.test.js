import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRoundSnapshot,
  makeRoundSnapshot,
  roundHistorySummary,
  settleRoundSnapshots,
} from '../src/signals/roundSnapshot.js';

const snap = (over = {}) =>
  makeRoundSnapshot({
    at: 1_000_000,
    ticker: 'K-1',
    closesAt: 1_000_000 + 5 * 60_000,
    spot: 65_000,
    strike: 65_000,
    ...over,
  });

test('a snapshot with no real round behind it is not kept', () => {
  assert.equal(snap({ ticker: null }), null);
  assert.equal(snap({ spot: 0 }), null);
  assert.equal(snap({ strike: 0 }), null);
  assert.equal(snap({ closesAt: 900_000 }), null, 'closesAt before at makes no sense');
});

test('a fresh look at an open ticker replaces the earlier one, not appends beside it', () => {
  let log = appendRoundSnapshot([], snap({ at: 1_000_000, spot: 65_000 }));
  log = appendRoundSnapshot(log, snap({ at: 1_010_000, spot: 65_050 }));
  assert.equal(log.length, 1);
  assert.equal(log[0].spot, 65_050);
});

test('a settled ticker is never overwritten by a later look', () => {
  const settled = { ...snap({ ticker: 'K-1' }), outcome: 1 };
  const log = appendRoundSnapshot([settled], snap({ ticker: 'K-1', at: 1_010_000 }));
  assert.equal(log.length, 2);
  assert.equal(log[0].outcome, 1);
});

test('a different ticker is a different row', () => {
  let log = appendRoundSnapshot([], snap({ ticker: 'K-1' }));
  log = appendRoundSnapshot(log, snap({ ticker: 'K-2' }));
  assert.equal(log.length, 2);
});

test('a round is graded on the settlement average once it has actually closed', () => {
  const closesAt = 1_000_000 + 5 * 60_000;
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: closesAt - t, price: 65_300 });

  const { log, settled } = settleRoundSnapshots([snap({ closesAt, strike: 65_000 })], {
    now: closesAt + 61_000,
    samples,
  });
  assert.equal(log[0].outcome, 1, 'settled above strike');
  assert.equal(settled, 1);
});

test('a round graded below strike is outcome 0, not silently dropped', () => {
  const closesAt = 1_000_000 + 5 * 60_000;
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: closesAt - t, price: 64_700 });

  const { log } = settleRoundSnapshots([snap({ closesAt, strike: 65_000 })], {
    now: closesAt + 61_000,
    samples,
  });
  assert.equal(log[0].outcome, 0);
});

test('a round still inside its grace period is left ungraded', () => {
  const closesAt = 1_000_000 + 5 * 60_000;
  const { log, settled } = settleRoundSnapshots([snap({ closesAt })], {
    now: closesAt + 1000,
    samples: [{ at: closesAt, price: 65_000 }],
  });
  assert.equal(log[0].outcome, null);
  assert.equal(settled, 0);
});

test('roundHistorySummary is honest about not having enough history yet', () => {
  const summary = roundHistorySummary([{ outcome: 1 }, { outcome: null }], { minimumSettled: 200 });
  assert.equal(summary.recorded, 2);
  assert.equal(summary.settled, 1);
  assert.equal(summary.enough, false);
});

test('roundHistorySummary flips to enough once the real threshold is met', () => {
  const rows = Array.from({ length: 5 }, () => ({ outcome: 1 }));
  const summary = roundHistorySummary(rows, { minimumSettled: 5 });
  assert.equal(summary.enough, true);
});
