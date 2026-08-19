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

test('carries the extended indicators — EMA stack, MACD, Bollinger width, ATR, session', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.ok(['bullish', 'bearish', 'mixed', null].includes(result.indicators.emaStack));
  assert.ok(
    result.indicators.bollingerWidthPercent === null || result.indicators.bollingerWidthPercent >= 0,
  );
  assert.ok(typeof result.indicators.session === 'string');
});

test('carries confluence — a second, independent lean, never fed into the call above', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.ok(['up', 'down', null].includes(result.confluence.lean));
  assert.ok(Array.isArray(result.confluence.reasons));
  // Measured accuracy is always shaped the same way, even before anything
  // has settled — the dashboard should never have to guard against a shape
  // that only shows up once a fortnight of history exists.
  assert.deepEqual(
    result.confluenceMeasured.map((row) => row.bucket).sort(),
    ['agrees_with_model', 'disagrees_with_model', 'no_model_opinion', 'overall'].sort(),
  );
});

test('live-trading status is read-only and defaults sensibly with nothing armed', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.equal(result.liveTrading.armed, false);
  assert.equal(result.liveTrading.killed, false);
  assert.equal(result.liveTrading.spent, 0);
});

test('live-trading status reflects the real risk state when one exists', async () => {
  const now = Date.now();
  const store = {
    ...fakeStore,
    riskState: () => ({ armed: true, killed: false, dailyLimitDollars: 20 }),
    listTradeOrders: () => [{ at: now, status: 'filled', costDollars: 4, profitDollars: 1.2 }],
  };
  const result = await computeRead(store, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.equal(result.liveTrading.armed, true);
  assert.equal(result.liveTrading.spent, 4);
  assert.equal(result.liveTrading.remaining, 16);
});

test("live trading carries today's own orders, newest first, for a person asking which trade lost", async () => {
  const now = Date.now();
  const yesterday = now - 25 * 60 * 60 * 1000;
  const store = {
    ...fakeStore,
    riskState: () => ({ armed: true, killed: false, dailyLimitDollars: 20 }),
    listTradeOrders: () => [
      { at: now - 2000, status: 'filled', side: 'yes', contracts: 3, limitCents: 60, costDollars: 1.8, profitDollars: -0.6 },
      { at: now - 1000, status: 'filled', side: 'no', contracts: 2, limitCents: 40, costDollars: 0.8, profitDollars: null },
      { at: now - 3000, status: 'rejected', side: 'yes', contracts: 5, limitCents: 50, costDollars: 0 },
      { at: yesterday, status: 'filled', side: 'yes', contracts: 1, limitCents: 50, costDollars: 0.5, profitDollars: 0.2 },
    ],
  };
  const result = await computeRead(store, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  const orders = result.liveTrading.recentOrders;
  assert.equal(orders.length, 2, 'the rejected order and yesterday\'s order are both excluded');
  assert.equal(orders[0].at, now - 1000, 'newest first');
  assert.equal(orders[0].profitDollars, null, 'still open, not guessed at');
  assert.equal(orders[1].profitDollars, -0.6);
});

test('the track record says so before anything has settled, rather than showing zeros as if measured', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.equal(result.trackRecord.ready, false);
});

test('the track record is the exact same measurement /picks edge reports, from the same recorded quotes', async () => {
  const now = Date.now();
  const quotes = [
    { at: now - 1000, ticker: 'K-1', asset: 'BTC', spot: 65_000, strike: 64_800, bid: 40, ask: 42, secondsLeft: 100, model: 0.6, outcome: 1 },
    { at: now - 1000, ticker: 'K-2', asset: 'BTC', spot: 65_000, strike: 65_200, bid: 55, ask: 57, secondsLeft: 100, model: 0.4, outcome: 0 },
  ];
  const store = { ...fakeStore, listQuotes: () => quotes, putQuotes: () => quotes };
  const result = await computeRead(store, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.equal(result.trackRecord.ready, true);
  assert.equal(result.trackRecord.settled, 2);
  assert.equal(result.trackRecord.markets, 2);
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

test('order flow is computed from the same tape as the whale reading, and is null without one', async () => {
  const now = Date.now();
  const withFlow = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    fetchTrades: async () => ({
      trades: [
        { created_time: new Date(now).toISOString(), count: 10, taker_side: 'yes', yes_price: 60 },
        { created_time: new Date(now).toISOString(), count: 5, taker_side: 'no', yes_price: 40 },
      ],
    }),
    now,
  });
  assert.ok(withFlow.orderFlow);
  assert.equal(withFlow.orderFlow.yesDollars, 6);
  assert.equal(withFlow.orderFlow.noDollars, 2);

  const withoutFlow = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.equal(withoutFlow.orderFlow, null);
});

test('patterns come back as a real object, all null, when there is not enough candle history', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });
  assert.ok(result.patterns);
  assert.deepEqual(Object.keys(result.patterns).sort(), [
    'bearFlag',
    'cupAndHandle',
    'doubleBottom',
    'doubleTop',
    'headAndShoulders',
    'inverseHeadAndShoulders',
    'reverseCupAndHandle',
  ]);
  assert.ok(Object.values(result.patterns).every((v) => v === null));
  assert.deepEqual(result.levels, []);
  assert.deepEqual(result.fairValueGaps, []);
});

test('the reversal radar and round history are honest about having no settled history yet', async () => {
  const now = Date.now();
  const result = await computeRead(fakeStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  const overall = result.patternTrackRecord.find((row) => row.patternKey === 'overall');
  assert.equal(overall.settled, 0);
  assert.equal(overall.enough, false);

  assert.equal(result.roundHistory.recorded, 0);
  assert.equal(result.roundHistory.settled, 0);
  assert.equal(result.roundHistory.enough, false);
});

test('a real double-top shape in the price history is actually detected end to end', async () => {
  const now = Date.now();
  // One sample per minute for 40 minutes, ramping to a peak, back down, up to
  // an equal second peak, then down again -- bucketed by computeRead into
  // the 1-minute candles patterns.js reads.
  const anchors = [64_800, 65_200, 64_900, 65_210, 64_700];
  const perLeg = 10;
  const samples = [];
  let minute = 0;
  for (let a = 0; a < anchors.length - 1; a += 1) {
    for (let i = 0; i < perLeg; i += 1) {
      const price = anchors[a] + (anchors[a + 1] - anchors[a]) * (i / perLeg);
      samples.push({ at: now - (anchors.length * perLeg - minute) * 60_000, price });
      minute += 1;
    }
  }
  const shapedStore = { listSamples: () => samples };

  const result = await computeRead(shapedStore, config, {
    openBoard: async () => board(50, 65_000, now + 500_000),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    now,
  });

  assert.ok(result.patterns.doubleTop, 'the shape built into the fixture was actually found');
  assert.equal(result.patterns.doubleTop.label, 'Double Top');
  assert.ok(result.patterns.doubleTop.invalidate > Math.max(...result.patterns.doubleTop.peaks) - 1);

  // The same two peaks that make this a double top are, independently, a
  // resistance level real enough for findSupportResistance to pick up.
  const resistance = result.levels.find((level) => level.type === 'resistance');
  assert.ok(resistance, 'the twice-tested peak should read as a resistance level');
  assert.ok(resistance.touches >= 2);
  assert.ok(Array.isArray(result.fairValueGaps));
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
