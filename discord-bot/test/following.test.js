import test from 'node:test';
import assert from 'node:assert/strict';
import {
  followerCount,
  followerReturn,
  formatLag,
  formatPercent,
  memberRecord,
  portfolioReturn,
  recordFollow,
  roomVersusAnalyst,
} from '../src/picks/following.js';

// An analyst's record answers "were the calls good". This answers the only
// question a member is paying to have answered: "am I making money". They come
// apart constantly, and every number here ends up in front of the member whose
// money it describes.

const contract = (over = {}) => ({
  id: 'p1',
  asset: 'BTC',
  direction: 'up',
  priceUnit: 'cents',
  entry: 39,
  exit: 50,
  sizePercent: 50,
  outcome: 'win',
  createdAt: 1000,
  ...over,
});

test('a member is scored on their own entry, not the analyst’s', () => {
  const pick = contract();

  // The analyst got 39 and made 28%. A member who paid 45 made 11%.
  assert.equal(Math.round(followerReturn(pick, { price: 39 })), 28);
  assert.equal(Math.round(followerReturn(pick, { price: 45 })), 11);
});

test('a call the board scores as a win can still be a loss for whoever was late', () => {
  const pick = contract({ entry: 39, exit: 50, outcome: 'win' });

  // In at 55 on a call that closed at 50: the room's loser on a winning call.
  assert.ok(followerReturn(pick, { price: 55 }) < 0);
});

test('the return on the book uses the size the call carried', () => {
  const pick = contract({ sizePercent: 25 });

  // +28% on the contract with a quarter of the book in is +7% on the account.
  assert.equal(Math.round(portfolioReturn(pick, { price: 39 })), 7);
});

test('on spot, a SHORT that fell made money', () => {
  const short = { priceUnit: 'usd', direction: 'down', entry: 100, exit: 90, sizePercent: 100 };
  const long = { priceUnit: 'usd', direction: 'up', entry: 100, exit: 90, sizePercent: 100 };

  assert.equal(Math.round(followerReturn(short, { price: 100 })), 10);
  assert.equal(Math.round(followerReturn(long, { price: 100 })), -10);
});

test('pressing twice does not open a second position', () => {
  const follows = [];
  const first = recordFollow(follows, { pickId: 'p1', userId: 'u', price: 40, unit: 'cents', at: 5 });
  follows.push(first.follow);
  const second = recordFollow(follows, { pickId: 'p1', userId: 'u', price: 55, unit: 'cents', at: 900 });

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  // The first press is the honest timestamp and the honest price.
  assert.equal(second.follow.price, 40);
});

test('a record compounds across trades, the way a book actually moves', () => {
  const picks = [
    contract({ id: 'a', entry: 40, exit: 50, sizePercent: 100 }),
    contract({ id: 'b', entry: 50, exit: 40, sizePercent: 100, outcome: 'loss' }),
  ];
  const follows = [
    { pickId: 'a', userId: 'u', price: 40, at: 1000 },
    { pickId: 'b', userId: 'u', price: 50, at: 1000 },
  ];

  const record = memberRecord(follows, picks, 'u');
  assert.equal(record.wins, 1);
  assert.equal(record.losses, 1);
  // +25% then -20% is exactly flat, not the +5% a naive sum would report.
  assert.ok(Math.abs(record.returnPercent) < 0.001);
});

test('the calls a member sat out are counted too', () => {
  const picks = [
    contract({ id: 'a' }),
    contract({ id: 'b' }),
    contract({ id: 'c' }),
  ];
  const follows = [{ pickId: 'a', userId: 'u', price: 39, at: 1000 }];

  const record = memberRecord(follows, picks, 'u');
  assert.equal(record.graded, 1);
  assert.equal(record.missed, 2);
  assert.ok(record.missedReturnPercent > 0, 'they skipped two winners and should be told');
});

test('lag is measured from the call going out to the member acting', () => {
  const picks = [contract({ createdAt: 1000 })];
  const follows = [{ pickId: 'p1', userId: 'u', price: 39, at: 1000 + 90_000 }];

  assert.equal(memberRecord(follows, picks, 'u').averageLagSeconds, 90);
  assert.equal(formatLag(90), '1m 30s');
  assert.equal(formatLag(45), '45s');
});

test('one member never sees another member’s trades', () => {
  const picks = [contract({ id: 'a' })];
  const follows = [
    { pickId: 'a', userId: 'them', price: 39, at: 1000 },
    { pickId: 'a', userId: 'me', price: 48, at: 1000 },
  ];

  assert.equal(memberRecord(follows, picks, 'me').graded, 1);
  assert.ok(memberRecord(follows, picks, 'me').returnPercent < memberRecord(follows, picks, 'them').returnPercent);
});

test('the room is reported beside the analyst, gap and all', () => {
  const pick = contract({ entry: 39, exit: 50, sizePercent: 100 });
  const follows = [
    { pickId: 'p1', userId: 'a', price: 39, at: 1 },
    { pickId: 'p1', userId: 'b', price: 48, at: 2 },
    { pickId: 'p1', userId: 'c', price: 55, at: 3 },
  ];

  const room = roomVersusAnalyst(follows, pick);
  assert.equal(room.followers, 3);
  assert.equal(room.inProfit, 2);
  assert.ok(room.roomPercent < room.analystPercent, 'the room got in later and made less');
  assert.ok(room.gap < 0);
  assert.equal(followerCount(follows, 'p1'), 3);
});

test('nothing is invented when there is no price to work from', () => {
  assert.equal(followerReturn(contract({ exit: null }), { price: 39 }), null);
  assert.equal(followerReturn(contract(), { price: null }), null);
  assert.equal(followerReturn(contract(), { price: 0 }), null);
  assert.equal(roomVersusAnalyst([], contract()), null);
  assert.equal(formatPercent(null), '—');
});
