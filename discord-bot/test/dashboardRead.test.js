import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRead } from '../src/dashboard/read.js';

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
