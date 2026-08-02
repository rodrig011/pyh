import test from 'node:test';
import assert from 'node:assert/strict';
import { VOTES, castVote, emptyVote, formatShare, shareBar, tallyVote, votesDue } from '../src/picks/vote.js';

const now = Date.now();

test('a fresh vote has nothing in it', () => {
  const vote = emptyVote('p1', { closesAt: now + 60000 });
  assert.deepEqual(tallyVote(vote), { profit: 0, loss: 0, total: 0, profitShare: null });
});

test('nobody voting is not the same as everybody losing', () => {
  // A bar drawn at 0% would tell the room the call lost them money.
  assert.equal(tallyVote(emptyVote('p1', { closesAt: now })).profitShare, null);
  assert.equal(shareBar(null), '—');
  assert.equal(formatShare(null), '—');
});

test('votes are counted', () => {
  const vote = emptyVote('p1', { closesAt: now + 60000 });
  castVote(vote, 'a', VOTES.PROFIT);
  castVote(vote, 'b', VOTES.PROFIT);
  castVote(vote, 'c', VOTES.LOSS);

  const tally = tallyVote(vote);
  assert.equal(tally.profit, 2);
  assert.equal(tally.loss, 1);
  assert.equal(formatShare(tally.profitShare), '67%');
});

test('one member has one voice however many times they press', () => {
  const vote = emptyVote('p1', { closesAt: now + 60000 });
  castVote(vote, 'a', VOTES.PROFIT);
  castVote(vote, 'a', VOTES.PROFIT);
  castVote(vote, 'a', VOTES.PROFIT);

  assert.equal(tallyVote(vote).total, 1);
});

test('changing your mind replaces the old answer', () => {
  const vote = emptyVote('p1', { closesAt: now + 60000 });
  castVote(vote, 'a', VOTES.PROFIT);
  const second = castVote(vote, 'a', VOTES.LOSS);

  assert.equal(second.changed, true);
  assert.equal(second.previous, VOTES.PROFIT);
  assert.deepEqual(tallyVote(vote), { profit: 0, loss: 1, total: 1, profitShare: 0 });
});

test('an unknown answer is refused', () => {
  const vote = emptyVote('p1', { closesAt: now });
  assert.throws(() => castVote(vote, 'a', 'maybe'));
});

test('only closed and unpublished votes come due', () => {
  const open = emptyVote('open', { closesAt: now + 60000 });
  const ready = emptyVote('ready', { closesAt: now - 1000 });
  const done = { ...emptyVote('done', { closesAt: now - 60000 }), resultPostedAt: now };

  assert.deepEqual(votesDue([open, ready, done], now).map((v) => v.pickId), ['ready']);
});

test('the bar fills in proportion and always has ten segments', () => {
  assert.equal(shareBar(1), '🟩'.repeat(10));
  assert.equal(shareBar(0), '🟥'.repeat(10));
  assert.equal(shareBar(0.5), `${'🟩'.repeat(5)}${'🟥'.repeat(5)}`);
  assert.equal([...shareBar(0.37)].length, 10, 'ten segments whatever the share');
});
