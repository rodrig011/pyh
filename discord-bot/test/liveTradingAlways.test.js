import test from 'node:test';
import assert from 'node:assert/strict';

import { newRiskState } from '../src/picks/riskLimits.js';
import { sweepLiveTrading } from '../src/picks/watch.js';
import { LIVE_PROFILES } from '../src/picks/paper.js';

function fakeStore() {
  const orders = [];
  return {
    riskState: () => ({ ...newRiskState({ dailyLimitDollars: 20 }), armed: true }),
    listTradeOrders: () => orders,
    appendTradeOrder: (order) => orders.push(order),
    listSamples: () => [],
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
