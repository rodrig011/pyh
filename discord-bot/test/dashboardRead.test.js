import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRead, enterManualPosition, manualEntry, positionAction, tradeRecord } from '../src/dashboard/read.js';
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

test('carries the descriptive indicators — RSI, momentum, trend, sigma distance', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.ok(result.indicators.rsi >= 0 && result.indicators.rsi <= 100);
  assert.ok(Number.isFinite(result.indicators.momentum));
  assert.ok(result.indicators.trendR2 >= 0 && result.indicators.trendR2 <= 1);
  assert.ok(Number.isFinite(result.indicators.sigmaDistance));
});

test('the expected range straddles spot and widens with more time left', async () => {
  const now = Date.now();
  const soon = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 60_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  const later = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 900_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.ok(soon.expectedRange.low < 65_000 && soon.expectedRange.high > 65_000);
  assert.ok(later.expectedRange.high - later.expectedRange.low > soon.expectedRange.high - soon.expectedRange.low);
});

test('real trades on the tape become real volume bars, logged for next time', async () => {
  const now = Date.now();
  let logged = null;
  const store = {
    ...fakeStore,
    recordContractTrades: (ticker, trades) => { logged = { ticker, trades }; },
    listContractTrades: () => [
      { at: now - 90_000, count: 40, side: 'yes' },
      { at: now - 20_000, count: 60, side: 'no' },
    ],
  };

  const result = await computeRead(store, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    fetchTrades: async () => ({
      trades: [{ created_time: new Date(now).toISOString(), count: 10, taker_side: 'yes', yes_price: 50 }],
    }),
    now,
  });

  assert.ok(logged, 'trades were handed to the store to remember');
  assert.equal(logged.ticker, 'K-1');
  assert.ok(result.volume.length > 0);
  assert.equal(result.volume.reduce((sum, bar) => sum + bar.value, 0), 100);
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

const quotes = { yesBidCents: 49, yesAskCents: 51, noBidCents: 49, noAskCents: 51 };

test('manualEntry prices the side actually clicked, not the model\'s side', () => {
  const up = manualEntry('up', { ticker: 'K-1', strike: 65_000, quotes, now: 5 });
  assert.deepEqual(up, { ticker: 'K-1', side: 'up', strike: 65_000, entryCents: 51, manual: true, at: 5 });

  const down = manualEntry('down', { ticker: 'K-1', strike: 65_000, quotes, now: 5 });
  assert.equal(down.entryCents, 51); // the NO ask, same number here by construction
  assert.equal(down.side, 'down');
});

test('manualEntry refuses a side that is not up or down', () => {
  assert.equal(manualEntry('sideways', { ticker: 'K-1', strike: 65_000, quotes }), null);
});

test('manualEntry refuses when there is nothing to price against', () => {
  assert.equal(manualEntry('up', { ticker: null, strike: 65_000, quotes }), null);
  assert.equal(manualEntry('up', { ticker: 'K-1', strike: 65_000, quotes: null }), null);
});

function mutableStore() {
  let dashboardPosition = null;
  return {
    listSamples: () => history.map((price, i) => ({ at: Date.now() - i * 1000, price })),
    riskState: () => null,
    dashboardPosition: () => dashboardPosition,
    setDashboardPosition: (p) => { dashboardPosition = p; return p; },
    clearDashboardPosition: () => { dashboardPosition = null; },
    listTradeOrders: () => [],
  };
}

test('enterManualPosition writes a position the next read then picks up', async () => {
  const now = Date.now();
  const store = mutableStore();

  const entered = await enterManualPosition(store, config, 'up', {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.equal(entered.ok, true);
  assert.equal(store.dashboardPosition().side, 'up');

  const read = await computeRead(store, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.ok(read.position);
  assert.equal(read.position.manual, true);
});

test('enterManualPosition fails cleanly with no market to price against', async () => {
  const store = mutableStore();
  const result = await enterManualPosition(store, config, 'up', {
    openBoard: async () => ({ contracts: [] }),
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(store.dashboardPosition(), null);
});
