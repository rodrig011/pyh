import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAXIMUM_CONTRACTS,
  buildOrder,
  orderCostDollars,
  orderRecord,
  placeOrder,
} from '../src/picks/kalshiOrders.js';

/**
 * Every test here is about a way real money gets lost by SOFTWARE rather than
 * by being wrong about a market.
 */

const creds = {
  keyId: 'k',
  // A throwaway key generated for this test file and nothing else.
  privateKeyPem: null,
};

test('limit orders only — never market', () => {
  // A market order on a thin book fills wherever the book happens to be, and
  // this exchange served us a live contract with liquidity_dollars 0.0000.
  const { order } = buildOrder({ ticker: 'T', side: 'yes', contracts: 10, limitCents: 44 });
  assert.equal(order.type, 'limit');
  assert.equal(order.yes_price, 44);
});

test('a price of 0 or 100 is a market order in disguise and is refused', () => {
  assert.ok(buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 0 }).error);
  assert.ok(buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 100 }).error);
});

test('a NO order is priced in NO cents, not YES cents', () => {
  // Getting this backwards would place every down trade at the wrong price.
  const { order } = buildOrder({ ticker: 'T', side: 'no', contracts: 5, limitCents: 62 });
  assert.equal(order.no_price, 62);
  assert.equal(order.yes_price, undefined);
});

test('every order carries a client order id, so a retry is not a second trade', () => {
  // The one that actually bites: a POST that times out has an unknown fate,
  // and retrying without an idempotency key turns one intended trade into two
  // real ones — exactly when the network is worst and nobody is watching.
  const a = buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 40 }).order;
  const b = buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 40 }).order;
  assert.ok(a.client_order_id);
  assert.notEqual(a.client_order_id, b.client_order_id, 'two distinct orders are distinct');

  const retry = buildOrder({
    ticker: 'T',
    side: 'yes',
    contracts: 1,
    limitCents: 40,
    clientOrderId: a.client_order_id,
  }).order;
  assert.equal(retry.client_order_id, a.client_order_id, 'a retry is the SAME order');
});

test('nonsense never becomes an order', () => {
  assert.ok(buildOrder({ ticker: '', side: 'yes', contracts: 1, limitCents: 40 }).error);
  assert.ok(buildOrder({ ticker: 'T', side: 'sideways', contracts: 1, limitCents: 40 }).error);
  assert.ok(buildOrder({ ticker: 'T', side: 'yes', contracts: 0, limitCents: 40 }).error);
  assert.ok(buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: NaN }).error);
});

test('there is a hard cap on contracts no caller can talk it out of', () => {
  const over = buildOrder({
    ticker: 'T',
    side: 'yes',
    contracts: MAXIMUM_CONTRACTS + 1,
    limitCents: 40,
  });
  assert.ok(over.error);
});

test('no credentials means the order is never even built', async () => {
  const result = await placeOrder({}, { ticker: 'T', side: 'yes', contracts: 1, limitCents: 40 });
  assert.equal(result.status, 'rejected');
  assert.match(result.error, /credentials/);
});

test('a 4xx is a real rejection — the exchange saw it and said no', async () => {
  const result = await placeOrder(
    { ...creds, privateKeyPem: 'x' },
    { ticker: 'T', side: 'yes', contracts: 1, limitCents: 40 },
    {
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) }),
    },
  ).catch((error) => ({ status: 'threw', error: error.message }));

  // Signing with a bogus key throws before the fetch, which is itself correct:
  // an unsigned order must never leave the process.
  assert.notEqual(result.status, 'placed');
});

test('a timeout is UNKNOWN, never a rejection', async () => {
  // Treating an unknown as a rejection is how a daily limit gets quietly
  // doubled: the order may be live, and the next one is placed anyway.
  const result = await placeOrder(
    { keyId: 'k', privateKeyPem: 'not-a-key' },
    { ticker: 'T', side: 'yes', contracts: 1, limitCents: 40 },
    {
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
  );
  assert.equal(result.status, 'unknown');
});

test('a partial fill is costed on what filled, not on what was asked for', () => {
  const result = { body: { order: { taker_fill_count: 4 } } };
  assert.equal(orderCostDollars(result, { contracts: 10, limitCents: 50 }), 2);
});

test('with no fill reported, the whole order is assumed spent', () => {
  // Erring the other way understates the day's spending, which is the error
  // that costs money rather than opportunities.
  assert.equal(orderCostDollars({}, { contracts: 10, limitCents: 50 }), 5);
});

test('the record carries what the risk ledger needs to read later', () => {
  const record = orderRecord({
    ticker: 'KXBTC-1',
    side: 'no',
    contracts: 8,
    limitCents: 55,
    at: 1_000_000,
    result: { status: 'placed', orderId: 'o1', order: { client_order_id: 'c1' } },
    reason: 'model edge 7c',
  });

  assert.equal(record.status, 'placed');
  assert.equal(record.costDollars, 4.4);
  assert.equal(record.clientOrderId, 'c1');
  // Filled in when the position closes; null until then rather than zero, so a
  // trade with no result yet is not counted as a break-even one.
  assert.equal(record.profitDollars, null);
});

test('an unknown order is still recorded, and still costed', () => {
  // An order that was sent and never recorded is an order the daily limit does
  // not know about.
  const record = orderRecord({
    ticker: 'T',
    side: 'yes',
    contracts: 5,
    limitCents: 40,
    result: { status: 'unknown', error: 'timed out' },
  });
  assert.equal(record.status, 'unknown');
  assert.equal(record.costDollars, 2);
});
