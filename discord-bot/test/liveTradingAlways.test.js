import test from 'node:test';
import assert from 'node:assert/strict';

import { newRiskState } from '../src/picks/riskLimits.js';
import { sweepLiveTrading } from '../src/picks/watch.js';
import { LIVE_PROFILES } from '../src/picks/paper.js';

function fakeStore({ profile = null, samples = [] } = {}) {
  const orders = [];
  let state = { ...newRiskState({ dailyLimitDollars: 20, profile }), armed: true };
  return {
    riskState: () => state,
    putRiskState: (next) => { state = next; return state; },
    listTradeOrders: () => orders,
    appendTradeOrder: (order) => orders.push(order),
    listSamples: () => samples,
  };
}

function config(trading = {}) {
  return {
    picks: {
      defaultAsset: 'BTC',
      kalshi: {
        enabled: true,
        seriesTicker: 'KXBTC15M',
        trading: { keyId: 'k', privateKeyPem: 'p', profile: 'careful', ...trading },
      },
    },
  };
}

const blockedDeps = {
  openBoard: async () => { throw new Error('activity quota must stop before market access'); },
  fetchSpotPrice: async () => { throw new Error('activity quota must stop before price access'); },
  placeOrder: async () => { throw new Error('forced live mode must never place an order'); },
};

test('live always is selectable but remains model-driven', async () => {
  let boardReads = 0;
  const result = await sweepLiveTrading({}, fakeStore(), config({ profile: 'always' }), {
    openBoard: async () => {
      boardReads += 1;
      return { contracts: [] };
    },
    fetchSpotPrice: async () => ({ price: 65_000 }),
    placeOrder: async () => { throw new Error('an empty board cannot place an order'); },
  });

  assert.equal(boardReads, 1);
  assert.deepEqual(result, { traded: false });
  assert.equal(LIVE_PROFILES.always.forceEveryWindow, undefined);
  assert.ok(LIVE_PROFILES.always.engine.minimumEdgeCents > 0);
});

test('a live activity quota is permanently disabled even on the careful profile', async () => {
  const result = await sweepLiveTrading({}, fakeStore(), config({ forceTradesPerWindow: 1 }), blockedDeps);
  assert.deepEqual(result, { traded: false, blocked: 'forced_live_disabled' });
});

test('always turns a model-refused market into an expiring approval, not an order', async () => {
  const now = Date.parse('2026-09-01T20:00:00Z');
  const samples = Array.from({ length: 90 }, (_, i) => ({
    at: now - (89 - i) * 30_000,
    price: 65_000 + Math.sin(i / 3) * 25,
  }));
  const store = fakeStore({ profile: 'always', samples });
  const market = {
    ticker: 'KXBTC15M-TEST',
    exchange_index: 6,
    floor_strike: 65_000,
    status: 'active',
    close_time: '2026-09-01T20:07:00Z',
    yes_bid_dollars: '0.49',
    yes_ask_dollars: '0.51',
    liquidity_dollars: '4000',
  };

  const result = await sweepLiveTrading({}, store, config({ profile: 'always' }), {
    now,
    openBoard: async () => ({ contracts: [{ market, price: 50 }] }),
    fetchSpotPrice: async () => ({ price: 65_000 }),
    placeOrder: async () => { throw new Error('approval is required before an order'); },
  });

  assert.deepEqual(result, { traded: false, pending: true });
  assert.equal(store.riskState().pendingApproval.ticker, market.ticker);
  assert.equal(store.riskState().pendingApproval.exchangeIndex, 6);
  assert.equal(store.listTradeOrders().length, 0);
});
