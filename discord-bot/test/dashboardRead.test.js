import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRead, positionAction, tradeRecord } from '../src/dashboard/read.js';
import { PROFILES } from '../src/picks/paper.js';

const config = {
  picks: {
    defaultAsset: 'BTC',
    kalshi: { enabled: true, seriesTicker: 'KXBTC15M' },
  },
};

const history = Array.from({ length: 90 }, (_, i) => 65_000 + Math.sin(i / 3) * 40);
const fakeStore = { listSamples: () => history.map((price, i) => ({ at: Date.now() - i * 1000, price })) };

function board(cents, strike, closesAt) {
  return {
    contracts: [
      {
        price: cents,
        market: {
          ticker: 'K-1',
          floor_strike: strike,
          close_time: new Date(closesAt).toISOString(),
          yes_bid_dollars: String((cents - 1) / 100),
          yes_ask_dollars: String((cents + 1) / 100),
          liquidity_dollars: '4000',
        },
      },
    ],
  };
}

test('reports Kalshi as off rather than crashing when it is not configured', async () => {
  const result = await computeRead(
    fakeStore,
    { picks: { kalshi: { enabled: false } } },
    { openBoard: async () => null, fetchSpotPrice: async () => ({ price: 65_000 }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /not enabled/);
});

test('reports no market rather than crashing when the board is empty', async () => {
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => ({ contracts: [] }),
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No readable market/);
});

test('reports no price rather than crashing when the feed is down', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: null }),
    now,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No live BTC price/);
});

test('a real read carries a call, a confidence and the clock', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.equal(result.ok, true);
  assert.ok(result.call === 'up' || result.call === 'down');
  assert.ok(Number.isFinite(result.winProbability));
  assert.ok(Number.isFinite(result.secondsLeft));
  assert.equal(result.asset, 'BTC');
});

test('carries a flip probability and a candle series', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.ok(result.flipProbability >= 0 && result.flipProbability <= 1);
  assert.ok(Array.isArray(result.candles));
  assert.ok(result.candles.length > 0);
});

test('reads the whale tape when a fetcher is wired in, and is null when it is not', async () => {
  const now = Date.now();
  const withWhales = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    fetchTrades: async () => ({
      trades: Array.from({ length: 3 }, () => ({
        created_time: new Date(now).toISOString(),
        count: 300,
        taker_side: 'yes',
        yes_price: 55,
      })),
    }),
    now,
  });
  assert.ok(withWhales.whales);
  assert.equal(withWhales.whales.count, 3);
  assert.match(withWhales.whales.line, /large print/);

  const withoutWhales = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.equal(withoutWhales.whales, null);
});

const positionDeps = { spot: 65_000, prices: history };

test('positionAction is null with nothing held', () => {
  assert.equal(
    positionAction(null, board(50, 65_000, Date.now() + 500_000), { ...positionDeps, now: Date.now() }),
    null,
  );
});

test('positionAction says settling once the position is off the board', () => {
  const now = Date.now();
  const position = { ticker: 'GONE', side: 'up', strike: 65_000, entryCents: 40 };
  const result = positionAction(position, board(50, 65_000, now + 500_000), { ...positionDeps, now });
  assert.equal(result.action, 'settling');
});

test('positionAction says cash_out when the scalp exit rule fires', () => {
  const now = Date.now();
  // At the money (spot == strike, so the model reads a coin flip), but the
  // market has since priced UP at 90 — a disagreement this large flips the
  // model's own verdict against the side held, which is always worth a fee
  // to escape, however far from the bell it is.
  const position = { ticker: 'K-1', side: 'up', strike: 65_000, entryCents: 20 };
  const result = positionAction(position, board(90, 65_000, now + 30_000), { ...positionDeps, now });
  assert.equal(result.action, 'cash_out');
});

test('positionAction says holding when nothing calls for an exit yet', () => {
  const now = Date.now();
  const position = { ticker: 'K-1', side: 'up', strike: 65_000, entryCents: 49 };
  const result = positionAction(position, board(50, 65_000, now + 500_000), { ...positionDeps, now });
  assert.equal(result.action, 'holding');
});

test('tradeRecord counts wins and losses from the real trade ledger only', () => {
  const record = tradeRecord([
    { profitDollars: 3.5 },
    { profitDollars: 1.2 },
    { profitDollars: -2 },
    { profitDollars: 0 },
    { profitDollars: null }, // still open — must not count either way
  ]);
  assert.deepEqual(record, { wins: 2, losses: 1, breakEven: 1, total: 4, winRate: 2 / 3 });
});

test('tradeRecord has no win rate before anything has settled', () => {
  assert.deepEqual(tradeRecord([]), { wins: 0, losses: 0, breakEven: 0, total: 0, winRate: null });
});
