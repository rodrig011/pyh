import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../src/signals/engine.js';
import { PROFILES, newAccount } from '../src/picks/paper.js';
import { newRiskState } from '../src/picks/riskLimits.js';
import { sweepLiveTrading } from '../src/picks/watch.js';

/**
 * "always" for LIVE trading: real money, forced into every window with no
 * edge required, exactly what PROFILES.always already does on paper — with
 * one addition paper does not need, since paper money has no real cost: a
 * forced-loss circuit breaker, independent of and tighter than the whole
 * account's daily budget.
 *
 * These tests exercise sweepLiveTrading end to end with a fake exchange, on
 * purpose — this is the highest-stakes path in the whole repository, and the
 * wiring between readBoard, checkTrade and orderRecord is exactly the kind
 * of thing that looks right in each file alone and is wrong together.
 */

const history = () => {
  const prices = [];
  let price = 65_000;
  let state = 8_675_309;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    prices.push(price);
  }
  return prices;
};

const PRICES = history();
const SPOT = 65_000;
const SECONDS_LEFT = 500;

/** A strike ladder quoted at exactly what the model itself calls fair — so
 * careful and scalp refuse the whole board, the same fixture used to prove
 * this in paper.test.js. */
function fairLadder(strikes) {
  const cents = strikes.map((strike) => {
    const probe = evaluate(
      { prices: PRICES, spot: SPOT, strike, marketPriceCents: 50, secondsLeft: SECONDS_LEFT },
      PROFILES.always.engine,
    );
    return Math.round((probe.probability ?? 0.5) * 100);
  });
  return cents.map((price, i) => ({
    price,
    market: {
      ticker: `KXBTC-${strikes[i]}`,
      floor_strike: strikes[i],
      status: 'active',
      close_time: new Date(Date.now() + SECONDS_LEFT * 1000).toISOString(),
      yes_bid_dollars: String((price - 1) / 100),
      yes_ask_dollars: String((price + 1) / 100),
      liquidity_dollars: '4000',
    },
  }));
}

const FAIR_BOARD = fairLadder([64_900, 64_950, 65_000, 65_050, 65_100]);

function fakeStore({ risk, orders = [] } = {}) {
  let state = risk;
  let tradeOrders = [...orders];
  return {
    riskState: () => state,
    putRiskState: (next) => { state = next; },
    listTradeOrders: () => tradeOrders,
    appendTradeOrder: (order) => { tradeOrders = [...tradeOrders, order]; },
    listSamples: () => PRICES.map((price, i) => ({ at: Date.now() - (PRICES.length - i) * 30_000, price })),
  };
}

function fakeClient() {
  const sent = [];
  return {
    sent,
    users: { fetch: async () => ({ send: async (body) => { sent.push(body); } }) },
  };
}

const TRADING = {
  keyId: 'k', privateKeyPem: 'p', ownerId: 'owner-1', dailyLimitDollars: 20,
  profile: 'always', forceTradeDollars: 2,
};

function config(overrides = {}) {
  return {
    picks: {
      defaultAsset: 'BTC',
      kalshi: { enabled: true, seriesTicker: 'X', trading: { ...TRADING, ...overrides } },
    },
  };
}

async function placeOrderFilled() {
  return { status: 'placed', orderId: 'o1', order: { client_order_id: 'c1' } };
}

test('always mode forces a real trade on a board careful and scalp would refuse entirely', async () => {
  const store = fakeStore({ risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: true } });
  const client = fakeClient();

  const result = await sweepLiveTrading(client, store, config(), {
    openBoard: async () => ({ contracts: FAIR_BOARD }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: placeOrderFilled,
    now: Date.now(),
    log: { debug() {}, info() {}, error() {} },
  });

  assert.equal(result.traded, true);
  const orders = store.listTradeOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].forced, true);
  assert.match(orders[0].reason, /always mode/);
  // The forced stake, not a Kelly-sized one — bounded by forceTradeDollars,
  // possibly under it once whole-contract rounding is applied.
  assert.ok(orders[0].contracts >= 1);
  assert.ok(orders[0].costDollars > 0 && orders[0].costDollars <= TRADING.forceTradeDollars);
});

test('careful stays flat on the exact same board — always is the only profile that forces', async () => {
  const store = fakeStore({ risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: true } });
  const client = fakeClient();

  const result = await sweepLiveTrading(client, store, config({ profile: 'careful' }), {
    openBoard: async () => ({ contracts: FAIR_BOARD }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: placeOrderFilled,
    now: Date.now(),
    log: { debug() {}, info() {}, error() {} },
  });

  assert.equal(result.traded, false);
  assert.equal(store.listTradeOrders().length, 0);
});

test('the DM names always mode by name, not the old activity-floor wording', async () => {
  const store = fakeStore({ risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: true } });
  const client = fakeClient();

  await sweepLiveTrading(client, store, config(), {
    openBoard: async () => ({ contracts: FAIR_BOARD }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: placeOrderFilled,
    now: Date.now(),
    log: { debug() {}, info() {}, error() {} },
  });

  assert.equal(client.sent.length, 1);
  assert.match(client.sent[0], /always mode, no edge/);
});

test('forced trades stop once the forced-loss limit is hit, while the account stays armed', async () => {
  const now = Date.now();
  // A quarter of a $20 daily budget is $5 — already lost exactly that, all
  // from forced trades, earlier today.
  const store = fakeStore({
    risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: true },
    orders: [{ at: now, forced: true, profitDollars: -5, status: 'filled', costDollars: 2 }],
  });
  const client = fakeClient();

  const result = await sweepLiveTrading(client, store, config(), {
    openBoard: async () => ({ contracts: FAIR_BOARD }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: placeOrderFilled,
    now,
    log: { debug() {}, info() {}, error() {} },
  });

  assert.equal(result.traded, false);
  assert.equal(result.blocked, 'force_loss_limit');
  // Nothing new was placed — the ledger still shows only the pre-existing order.
  assert.equal(store.listTradeOrders().length, 1);
});

test('an explicit KALSHI_FORCE_LOSS_LIMIT_DOLLARS is honoured over the default share', async () => {
  const now = Date.now();
  const store = fakeStore({
    risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: true },
    orders: [{ at: now, forced: true, profitDollars: -1, status: 'filled', costDollars: 2 }],
  });
  const client = fakeClient();

  // $1 lost, cap set to $0.50 — should already be blocked despite being far
  // under the default 25%-of-$20 = $5 share.
  const result = await sweepLiveTrading(client, store, config({ forceLossLimitDollars: 0.5 }), {
    openBoard: async () => ({ contracts: FAIR_BOARD }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: placeOrderFilled,
    now,
    log: { debug() {}, info() {}, error() {} },
  });

  assert.equal(result.traded, false);
  assert.equal(result.blocked, 'force_loss_limit');
});

test('disarmed is disarmed — always mode does not bypass the arm switch', async () => {
  const store = fakeStore({ risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: false } });
  const client = fakeClient();

  const result = await sweepLiveTrading(client, store, config(), {
    openBoard: async () => ({ contracts: FAIR_BOARD }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: placeOrderFilled,
    now: Date.now(),
    log: { debug() {}, info() {}, error() {} },
  });

  assert.equal(result.traded, false);
  assert.equal(store.listTradeOrders().length, 0);
});
