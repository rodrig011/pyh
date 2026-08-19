import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HORIZON_MS,
  appendConfluenceRecord,
  confluencePatterns,
  confluenceVerdict,
  makeConfluenceRecord,
  settleConfluenceRecords,
} from '../src/signals/confluenceLog.js';

/**
 * "Which one is actually worth listening to is an empirical question, not
 * something either file gets to assert about itself." These tests are about
 * making that question answerable.
 */

const record = (over = {}) =>
  makeConfluenceRecord({
    at: 1_000_000,
    spot: 65_000,
    lean: 'up',
    score: 3,
    primaryLeaning: 'up',
    primaryWinProbability: 0.6,
    ...over,
  });

test('a squeeze — no lean at all — is not recorded, since there is nothing to grade', () => {
  assert.equal(record({ lean: null }), null);
  assert.equal(record({ lean: 'sideways' }), null);
});

test('a record with no real read behind it is not kept', () => {
  assert.equal(record({ at: 0 }), null);
  assert.equal(record({ spot: 0 }), null);
});

test('agreement with the primary model is judged against its LEANING, not its call', () => {
  // The model's `call` is which side is cheap to buy, not which way it thinks
  // price is headed — comparing confluence to the wrong one of those would
  // blame it for a disagreement that was never about direction.
  const r = record({ lean: 'up', primaryLeaning: 'up' });
  assert.equal(r.agreesWithPrimary, true);

  const disagree = record({ lean: 'up', primaryLeaning: 'down' });
  assert.equal(disagree.agreesWithPrimary, false);

  const noOpinion = record({ lean: 'up', primaryLeaning: null });
  assert.equal(noOpinion.agreesWithPrimary, null);
});

test('one horizon window gets one row, the most decisive read in it', () => {
  // A sweep firing every ten seconds would otherwise write dozens of
  // near-identical rows per fifteen-minute stretch, restating the same call
  // as if each tick were independent evidence.
  let log = appendConfluenceRecord([], record({ at: 1_000_000, score: 2 }));
  log = appendConfluenceRecord(log, record({ at: 1_010_000, score: 5 }));
  log = appendConfluenceRecord(log, record({ at: 1_020_000, score: -3 }));

  assert.equal(log.length, 1);
  assert.equal(log[0].score, 5, 'the most decisive read of the window, kept');
});

test('the next horizon window is a new row', () => {
  let log = appendConfluenceRecord([], record({ at: 1_000_000 }));
  log = appendConfluenceRecord(log, record({ at: 1_000_000 + HORIZON_MS }));
  assert.equal(log.length, 2);
});

test('a settled row is never overwritten by a later look', () => {
  // Same bucket as the incoming record (Math.floor(1_000_000 / HORIZON_MS) === 1)
  // so this actually exercises the collision path, not just two unrelated rows.
  const settled = { ...record({ at: 1_000_000 }), bucket: 1, won: 1 };
  const log = appendConfluenceRecord([settled], record({ at: 1_000_000, score: 99 }));
  assert.equal(log.length, 2);
  assert.equal(log[0].won, 1);
});

test('the log stays bounded', () => {
  let log = [];
  for (let i = 0; i < 5000; i += 1) {
    log = appendConfluenceRecord(log, record({ at: i * HORIZON_MS }));
  }
  assert.ok(log.length <= 4000);
});

test('a lean is graded on the settlement average, fifteen minutes out', () => {
  const at = 1_000_000;
  const targetAt = at + HORIZON_MS;
  // Spot finishing above where it was at the read: an UP lean would have won.
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: targetAt - t, price: 65_200 });

  const { log, settled } = settleConfluenceRecords([record({ at, spot: 65_000, lean: 'up' })], {
    now: targetAt + 60_000,
    samples,
  });
  assert.equal(log[0].won, 1);
  assert.equal(settled, 1);
});

test('a lean the wrong way is graded a loss, not silently dropped', () => {
  const at = 1_000_000;
  const targetAt = at + HORIZON_MS;
  const samples = [];
  for (let t = 60_000; t >= 0; t -= 10_000) samples.push({ at: targetAt - t, price: 64_800 });

  const { log } = settleConfluenceRecords([record({ at, spot: 65_000, lean: 'up' })], {
    now: targetAt + 60_000,
    samples,
  });
  assert.equal(log[0].won, 0);
});

test('a window that has not reached its horizon yet is left ungraded', () => {
  const { log, settled } = settleConfluenceRecords([record({ at: 1_000_000 })], {
    now: 1_000_000 + HORIZON_MS - 1000,
    samples: [{ at: 1_000_000, price: 65_000 }],
  });
  assert.equal(log[0].won, null);
  assert.equal(settled, 0, 'nothing changed, so a caller can skip the write');
});

test('with no spot around the target time it stays ungraded rather than guessing', () => {
  const { log } = settleConfluenceRecords([record({ at: 1_000_000 })], {
    now: 9_000_000,
    samples: [{ at: 1, price: 65_000 }],
  });
  assert.equal(log[0].won, null);
});

test('patterns split overall accuracy from agreement with the primary model', () => {
  const log = [
    { lean: 'up', agreesWithPrimary: true, won: 1 },
    { lean: 'up', agreesWithPrimary: true, won: 1 },
    { lean: 'down', agreesWithPrimary: false, won: 0 },
    { lean: 'down', agreesWithPrimary: false, won: 0 },
    { lean: 'up', agreesWithPrimary: null, won: 1 },
  ];
  const patterns = confluencePatterns(log, { minimumSettled: 2 });

  const overall = patterns.find((row) => row.bucket === 'overall');
  const agrees = patterns.find((row) => row.bucket === 'agrees_with_model');
  const disagrees = patterns.find((row) => row.bucket === 'disagrees_with_model');
  const noOpinion = patterns.find((row) => row.bucket === 'no_model_opinion');

  assert.equal(overall.settled, 5);
  assert.equal(agrees.winRate, 1);
  assert.equal(disagrees.winRate, 0);
  assert.equal(noOpinion.settled, 1);
});

test('a small sample is never given a verdict', () => {
  const [overall] = confluencePatterns([{ agreesWithPrimary: null, won: 1 }]);
  assert.equal(overall.enough, false);
  assert.match(confluenceVerdict(overall), /not enough/);
});

test('the verdict names whether the lean beats a coin flip', () => {
  assert.match(confluenceVerdict({ enough: true, winRate: 0.6 }), /ahead of a coin flip/);
  assert.match(confluenceVerdict({ enough: true, winRate: 0.4 }), /behind a coin flip/);
  assert.match(confluenceVerdict({ enough: true, winRate: 0.5 }), /no better than a coin flip/);
});

test('ungraded rows never reach the patterns', () => {
  const patterns = confluencePatterns([{ agreesWithPrimary: null, won: null }]);
  assert.equal(patterns.find((row) => row.bucket === 'overall').settled, 0);
});
