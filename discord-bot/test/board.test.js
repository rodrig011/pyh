import test from 'node:test';
import assert from 'node:assert/strict';

import { readBoard, nearestTheMoney, censusLine, boardIsUnreadable } from '../src/signals/board.js';
import { boardForClose, openBoard } from '../src/picks/kalshi.js';

/**
 * The bug these tests exist for: "it skips every single market".
 *
 * It was true, and the cause was not the thresholds. Kalshi lists a ladder of
 * strikes per fifteen-minute window and the bot read exactly one of them —
 * whichever closed soonest — so it was refusing a board of a dozen markets on
 * the evidence of one, and the one was usually already far from the money.
 */

const HISTORY = Array.from({ length: 90 }, (_, i) => 65_000 + Math.sin(i / 3) * 40);

function strike(price, cents, { ticker = `K-${price}`, closesAt = '2026-01-01T00:15:00Z' } = {}) {
  return {
    price: cents,
    market: {
      ticker,
      floor_strike: price,
      status: 'active',
      close_time: closesAt,
      yes_bid_dollars: String((cents - 1) / 100),
      yes_ask_dollars: String((cents + 1) / 100),
      liquidity_dollars: '4000',
    },
  };
}

const CONTEXT = { prices: HISTORY, spot: 65_000, secondsLeft: 420 };

test('the whole ladder is read, not just one strike', () => {
  const board = readBoard(
    [strike(64_800, 70), strike(64_900, 60), strike(65_000, 50), strike(65_100, 40)],
    CONTEXT,
  );

  assert.equal(board.looked, 4);
  assert.equal(board.reads.length, 4);
  // Every strike gets its own read, and they are not all the same read.
  const probabilities = board.reads.map((entry) => entry.read.result.probability);
  assert.ok(new Set(probabilities.map((p) => p?.toFixed(4))).size > 1);
});

test('a strike with no usable price is dropped rather than read as zero', () => {
  const board = readBoard(
    [strike(65_000, 50), { price: null, market: { ticker: 'X', floor_strike: 65_100 } }],
    CONTEXT,
  );
  assert.equal(board.looked, 1);
});

test('a candidate carrying its own strike is accepted', () => {
  // The exchange puts the strike on the market. A caller reading one known
  // contract already has it, and requiring the feed's field silently dropped
  // every such candidate — the board came back empty and the engine looked
  // like it had stopped seeing markets at all.
  const board = readBoard(
    [{ price: 50, strike: 65_000, market: { ticker: 'T', yes_bid_dollars: '0.49', yes_ask_dollars: '0.51' } }],
    CONTEXT,
  );
  assert.equal(board.looked, 1);
});

test('refusals are counted by reason, because a bare count diagnoses nothing', () => {
  // "Refused 41" cannot tell a fair market from a broken price feed. The
  // breakdown can, and that is the difference between the engine working and
  // the engine being quietly dead.
  const board = readBoard([strike(65_000, 50), strike(70_000, 50), strike(60_000, 50)], CONTEXT);

  assert.ok(board.census.length > 0);
  const total = board.census.reduce((sum, { count }) => sum + count, 0);
  assert.equal(total, board.refused);
  // Sorted biggest first: the top reason is the one worth arguing with.
  for (let i = 1; i < board.census.length; i += 1) {
    assert.ok(board.census[i - 1].count >= board.census[i].count);
  }
});

test('the best strike is the one with the most edge left AFTER fees', () => {
  // Ranking on gross edge picks the cheap far-out strike whose edge the
  // exchange then eats. The ordering has to survive the fee schedule.
  const board = readBoard([strike(64_700, 30), strike(65_000, 50), strike(65_300, 70)], CONTEXT);

  for (let i = 1; i < board.tradeable.length; i += 1) {
    assert.ok(board.tradeable[i - 1].read.netEdgeCents >= board.tradeable[i].read.netEdgeCents);
  }
  if (board.best) assert.equal(board.best, board.tradeable[0]);
});

test('nearest the money is about price, not about edge', () => {
  // What a room is looking at is the coin-flip strike, not whichever one
  // happened to offer the fattest number.
  const board = readBoard([strike(64_000, 88), strike(65_000, 49), strike(66_000, 8)], CONTEXT);
  const near = nearestTheMoney(board.reads);
  assert.equal(near.strike, 65_000);
});

test('a ladder that is mostly unreadable is stood aside from entirely', () => {
  // The one refusal that was explicitly asked to stay: when the whole board
  // says the volatility cannot be read, that is one condition showing up a
  // dozen times, not a dozen opinions — and the strike that slipped through is
  // a false positive, not the exception.
  const unreadable = {
    looked: 10,
    census: [
      { reason: 'trending', count: 5 },
      { reason: 'vol_uncertain', count: 3 },
      { reason: 'no_edge', count: 2 },
    ],
  };
  assert.equal(boardIsUnreadable(unreadable), true);

  const ordinary = {
    looked: 10,
    census: [
      { reason: 'no_edge', count: 8 },
      { reason: 'trending', count: 1 },
    ],
  };
  assert.equal(boardIsUnreadable(ordinary), false);
});

test('a board too small to have an opinion is not called unreadable', () => {
  assert.equal(boardIsUnreadable({ looked: 2, census: [{ reason: 'trending', count: 2 }] }), false);
  assert.equal(boardIsUnreadable(null), false);
});

test('the census reads as a sentence a person can act on', () => {
  const line = censusLine([
    { reason: 'no_edge', count: 30 },
    { reason: 'thin_book', count: 4 },
  ]);
  assert.match(line, /30× no edge/);
  assert.match(line, /4× thin book/);
  assert.equal(censusLine([]), null);
});

test('the window is every strike closing at the same bell, not the first one', () => {
  const now = Date.parse('2026-01-01T00:05:00Z');
  const markets = [
    { ticker: 'A', status: 'active', close_time: '2026-01-01T00:15:00Z' },
    { ticker: 'B', status: 'active', close_time: '2026-01-01T00:15:00Z' },
    { ticker: 'C', status: 'active', close_time: '2026-01-01T00:15:00Z' },
    // A later window: a different bet, and it must not be mixed in.
    { ticker: 'D', status: 'active', close_time: '2026-01-01T00:30:00Z' },
  ];

  const board = boardForClose(markets, { now });
  assert.deepEqual(board.map((m) => m.ticker).sort(), ['A', 'B', 'C']);
});

test('a stray second in a timestamp does not drop a strike off the board', () => {
  const now = Date.parse('2026-01-01T00:05:00Z');
  const markets = [
    { ticker: 'A', status: 'active', close_time: '2026-01-01T00:15:00Z' },
    { ticker: 'B', status: 'active', close_time: '2026-01-01T00:15:01Z' },
  ];
  assert.equal(boardForClose(markets, { now }).length, 2);
});

test('openBoard prices every strike and says how many it could not', async () => {
  const markets = [
    {
      ticker: 'A',
      status: 'active',
      close_time: '2026-01-01T00:15:00Z',
      yes_bid_dollars: '0.49',
      yes_ask_dollars: '0.51',
    },
    {
      ticker: 'B',
      status: 'active',
      close_time: '2026-01-01T00:15:00Z',
      yes_bid_dollars: '0.30',
      yes_ask_dollars: '0.32',
    },
    // Listed, but nothing quoted on it.
    { ticker: 'C', status: 'active', close_time: '2026-01-01T00:15:00Z' },
  ];

  const result = await openBoard(
    { seriesTicker: 'KXBTC' },
    {
      now: Date.parse('2026-01-01T00:05:00Z'),
      fetchImpl: async () => ({ ok: true, json: async () => ({ markets }) }),
    },
  );

  assert.equal(result.contracts.length, 2);
  assert.equal(result.listed, 3);
  assert.equal(result.quoted, 2);
  assert.equal(result.error, null);
});

test('a feed that is down returns an empty board rather than throwing', async () => {
  const result = await openBoard(
    { seriesTicker: 'KXBTC' },
    { fetchImpl: async () => ({ ok: false, status: 503 }) },
  );
  assert.deepEqual(result.contracts, []);
  assert.match(result.error, /503/);
});
