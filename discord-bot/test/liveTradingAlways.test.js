import test from 'node:test';
import assert from 'node:assert/strict';

import { newRiskState } from '../src/picks/riskLimits.js';
import { sweepLiveTrading } from '../src/picks/watch.js';

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

const deps = {
  openBoard: async () => { throw new Error('forced live mode must stop before market access'); },
  fetchSpotPrice: async () => { throw new Error('forced live mode must stop before price access'); },
  placeOrder: async () => { throw new Error('forced live mode must never place an order'); },
};

test('always is permanently paper-only even when the saved live state is armed', async () => {
  const result = await sweepLiveTrading({}, fakeStore(), config({ profile: 'always' }), deps);
  assert.deepEqual(result, { traded: false, blocked: 'forced_live_disabled' });
});

test('a live activity quota is permanently disabled even on the careful profile', async () => {
  const result = await sweepLiveTrading({}, fakeStore(), config({ forceTradesPerWindow: 1 }), deps);
  assert.deepEqual(result, { traded: false, blocked: 'forced_live_disabled' });
});
