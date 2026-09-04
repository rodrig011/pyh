import test from 'node:test';
import assert from 'node:assert/strict';

import { newRiskState } from '../src/picks/riskLimits.js';
import { sweepLiveTrading } from '../src/picks/watch.js';

/**
 * Two hard, per-trade overrides on a HELD position — take profit at
 * config.trading.takeProfitPercent (default 15%) and stop loss at
 * config.trading.stopLossDollars (default $5) — checked before the
 * model-driven scalp exit gets any say at all. Explicitly requested in place
 * of "hold until the model stops defending it", which has no ceiling on the
 * upside and no dollar floor on the downside.
 */

const SPOT = 65_000;
const STRIKE = 65_000;
const SECONDS_LEFT = 500;

function history() {
  const prices = [];
  let price = SPOT;
  let state = 42;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    prices.push(price);
  }
  return prices;
}

const PRICES = history();
const TICKER = 'KXBTC-65000';

function candidate(yesBidDollars, yesAskDollars) {
  return {
    price: Math.round(yesBidDollars * 100),
    market: {
      ticker: TICKER,
      exchange_index: 9,
      floor_strike: STRIKE,
      status: 'active',
      close_time: new Date(Date.now() + SECONDS_LEFT * 1000).toISOString(),
      yes_bid_dollars: String(yesBidDollars),
      yes_ask_dollars: String(yesAskDollars),
      liquidity_dollars: '4000',
    },
  };
}

function held(overrides = {}) {
  return {
    ticker: TICKER,
    exchangeIndex: 9,
    side: 'up',
    entryCents: 50,
    contracts: 10,
    strike: STRIKE,
    costDollars: 5,
    clientOrderId: 'c1',
    at: Date.now(),
    ...overrides,
  };
}

function fakeStore({ risk, orders = [] } = {}) {
  let state = risk;
  let tradeOrders = [...orders];
  return {
    riskState: () => state,
    putRiskState: (next) => { state = next; },
    listTradeOrders: () => tradeOrders,
    appendTradeOrder: (order) => { tradeOrders = [...tradeOrders, order]; },
    updateTradeOrder: (clientOrderId, patch) => {
      tradeOrders = tradeOrders.map((o) => (o.clientOrderId === clientOrderId ? { ...o, ...patch } : o));
    },
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
  keyId: 'k', privateKeyPem: 'p', ownerId: 'owner-1', dailyLimitDollars: 20, profile: 'careful',
};

function config(overrides = {}) {
  return {
    picks: {
      defaultAsset: 'BTC',
      kalshi: { enabled: true, seriesTicker: 'X', trading: { ...TRADING, ...overrides } },
    },
  };
}

async function run(held_, board, cfg = config(), fillCount = null) {
  const store = fakeStore({
    risk: { ...newRiskState({ dailyLimitDollars: 20 }), armed: true, position: held_ },
    orders: [{ clientOrderId: held_.clientOrderId, costDollars: held_.costDollars, profitDollars: null }],
  });
  const client = fakeClient();
  const placed = [];
  const result = await sweepLiveTrading(client, store, cfg, {
    openBoard: async () => ({ contracts: board }),
    fetchSpotPrice: async () => ({ price: SPOT }),
    placeOrder: async (settings, order) => {
      placed.push(order);
      const filled = fillCount === null ? order.contracts : fillCount;
      return {
        status: filled === 0 ? 'unfilled' : filled < order.contracts ? 'partial' : 'filled',
        filledCount: filled,
        orderId: 'o1',
        order: { client_order_id: 'x' },
        body: { fill_count: filled, average_fill_price: String(order.side === 'yes' ? order.limitCents / 100 : 1 - order.limitCents / 100) },
      };
    },
    now: Date.now(),
    log: { debug() {}, info() {}, error() {} },
  });
  return { result, store, client, placed };
}

test('a position up 20% sells on the take-profit override, not the model', async () => {
  // Entered at 50c, bid now 60c on 10 contracts: cost $5, proceeds $6 -> +20%.
  const board = [candidate(0.6, 0.61)];
  const { result, placed, store } = await run(held(), board);

  assert.equal(result.traded, true);
  assert.equal(result.exit, true);
  assert.equal(placed[0].limitCents, 60);
  assert.equal(placed[0].exchangeIndex, 9);
  const [order] = store.listTradeOrders();
  assert.equal(order.profitDollars, 1);
  assert.equal(store.riskState().position, null);
});

test('a partial exit leaves the unfilled contracts open and books only the filled slice', async () => {
  const board = [candidate(0.6, 0.61)];
  const { result, store } = await run(held(), board, config(), 4);

  assert.equal(result.traded, true);
  assert.equal(result.status, 'partial');
  assert.equal(store.riskState().position.contracts, 6);
  assert.equal(store.riskState().position.costDollars, 3);
  assert.ok(Math.abs(store.riskState().position.realizedProfitDollars - 0.4) < 1e-9);
  assert.equal(store.listTradeOrders()[0].profitDollars, null);
});

test('an unfilled exit leaves the entire position open', async () => {
  const board = [candidate(0.6, 0.61)];
  const { result, store } = await run(held(), board, config(), 0);

  assert.equal(result.traded, false);
  assert.equal(result.status, 'unfilled');
  assert.equal(store.riskState().position.contracts, 10);
  assert.equal(store.listTradeOrders()[0].profitDollars, null);
});

test('a position under the 15% bar is NOT sold by the take-profit override', async () => {
  // +6.4% only (53.2c bid on a 50c entry) -- below the 15% bar, and its net
  // (after both fees) sits between scalp's own "cut" and "move banked"
  // thresholds too, so nothing sells for either reason.
  const board = [candidate(0.532, 0.542)];
  const { result } = await run(held(), board);

  assert.equal(result.exit, undefined);
});

test('a position down $5 sells on the stop-loss override', async () => {
  // Entered at 50c on 20 contracts: cost $10. Bid crashes to 15c: proceeds
  // $3, a $7 loss -- past the $5 floor.
  const board = [candidate(0.15, 0.16)];
  const bigger = held({ contracts: 20, costDollars: 10 });
  const { result, placed, store } = await run(bigger, board);

  assert.equal(result.traded, true);
  assert.equal(result.exit, true);
  assert.equal(placed[0].limitCents, 15);
  const [order] = store.listTradeOrders();
  assert.equal(order.profitDollars, -7);
});

test('a position down less than $5 is NOT sold by the stop-loss override', async () => {
  // Entered at 50c on 20 contracts: cost $10. Bid at 40c: proceeds $8, a $2
  // loss -- inside the $5 floor.
  const board = [candidate(0.40, 0.41)];
  const bigger = held({ contracts: 20, costDollars: 10 });
  const { result } = await run(bigger, board);

  assert.equal(result.exit, undefined);
});

test('KALSHI_TAKE_PROFIT_PERCENT and KALSHI_STOP_LOSS_DOLLARS override the defaults', async () => {
  // +10% would not clear the default 15% bar, but does clear a configured 5%.
  const board = [candidate(0.55, 0.56)];
  const { result } = await run(held(), board, config({ takeProfitPercent: 0.05 }));

  assert.equal(result.exit, true);
});

test('a tighter configured stop loss fires sooner than the $5 default', async () => {
  // $2 down, inside the $5 default but past a configured $1 floor.
  const board = [candidate(0.40, 0.41)];
  const bigger = held({ contracts: 20, costDollars: 10 });
  const { result } = await run(bigger, board, config({ stopLossDollars: 1 }));

  assert.equal(result.exit, true);
});
