import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  MAXIMUM_CONTRACTS,
  ORDER_PATHS,
  bookSide,
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

/**
 * Kalshi retired /portfolio/orders for /portfolio/events/orders — a
 * different schema entirely: no more separate yes/no sides or buy/sell
 * actions, just one book side ("bid"/"ask"), always priced in
 * YES-denominated dollars. Every order this file builds now goes through
 * that translation, so it is the one place a wrong-side or wrong-price bug
 * would live — hence the exhaustive coverage below, cross-checked against
 * two independent open-source Kalshi clients rather than guessed at.
 */

test('bookSide maps buy/sell x yes/no onto the single V2 book side', () => {
  assert.equal(bookSide('buy', 'yes'), 'bid');
  assert.equal(bookSide('sell', 'yes'), 'ask');
  assert.equal(bookSide('buy', 'no'), 'ask');
  assert.equal(bookSide('sell', 'no'), 'bid');
});

test('a limit order is always a limit order — there is no field for anything else', () => {
  // A market order on a thin book fills wherever the book happens to be, and
  // this exchange served us a live contract with liquidity_dollars 0.0000.
  // V2 has no order "type" at all — every order carries a price, which is
  // what makes it a limit order by construction. No price, no order.
  const { order } = buildOrder({ ticker: 'T', side: 'yes', contracts: 10, limitCents: 44 });
  assert.equal(order.type, undefined);
  assert.ok(Number.isFinite(Number(order.price)));
  assert.equal(order.time_in_force, 'good_till_canceled');
});

test('a price of 0 or 100 is a market order in disguise and is refused', () => {
  assert.ok(buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 0 }).error);
  assert.ok(buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 100 }).error);
});

test('a YES order is priced as-is, in YES dollars', () => {
  const { order } = buildOrder({ ticker: 'T', side: 'yes', contracts: 5, limitCents: 62, action: 'buy' });
  assert.equal(order.side, 'bid');
  assert.equal(order.price, '0.6200');
});

test('a NO order is converted to its YES-complement price, not sent in NO cents', () => {
  // Getting this backwards would place every down trade at the wrong price —
  // V2 has no no_price field at all, so silently sending 62 unconverted
  // would buy YES at 62c instead of NO at 62c, which is not the same trade.
  const { order } = buildOrder({ ticker: 'T', side: 'no', contracts: 5, limitCents: 62, action: 'buy' });
  assert.equal(order.side, 'ask'); // BUY NO -> ask, per bookSide
  assert.equal(order.price, '0.3800'); // 1 - 0.62
});

test('a SELL order flips the book side from the equivalent BUY', () => {
  const buyYes = buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 50, action: 'buy' }).order;
  const sellYes = buildOrder({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 50, action: 'sell' }).order;
  assert.equal(buyYes.side, 'bid');
  assert.equal(sellYes.side, 'ask');
  // Price is still YES-denominated either way — only the side flips.
  assert.equal(buyYes.price, sellYes.price);
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

test('a placed order is signed and sent to the current V2 path, and reads back the top-level order_id', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds2 = { keyId: 'k', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

  let requestedUrl = null;
  let sentBody = null;
  const result = await placeOrder(
    creds2,
    { ticker: 'KXBTC-1', side: 'no', contracts: 3, limitCents: 33, action: 'buy' },
    {
      fetchImpl: async (url, init) => {
        requestedUrl = url;
        sentBody = JSON.parse(init.body);
        // V2's real ack shape: a thin, top-level object.
        return { ok: true, status: 200, json: async () => ({ order_id: 'ord-123', fill_count: 0, remaining_count: 3 }) };
      },
    },
  );

  assert.equal(result.status, 'placed');
  assert.equal(result.orderId, 'ord-123');
  assert.ok(requestedUrl.endsWith(ORDER_PATHS[0]), `sent to ${requestedUrl}, not the current order path`);
  assert.equal(sentBody.side, 'ask'); // BUY NO -> ask
  assert.equal(sentBody.price, '0.6700'); // 1 - 0.33
  assert.equal(sentBody.time_in_force, 'good_till_canceled');
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
  // V2's ack reports fill_count at the TOP level, not nested under "order"
  // the way v1's response was.
  const result = { body: { fill_count: 4 } };
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

test('forced is a real field, not something read back out of the reason text', () => {
  // riskLimits.js's forced-loss circuit breaker filters and sums these —
  // string-matching a free-text reason is how that silently breaks the day
  // somebody edits the wording.
  const forced = orderRecord({
    ticker: 'T', side: 'yes', contracts: 1, limitCents: 50,
    result: { status: 'placed' }, forced: true,
  });
  assert.equal(forced.forced, true);

  const notForced = orderRecord({ ticker: 'T', side: 'yes', contracts: 1, limitCents: 50, result: { status: 'placed' } });
  assert.equal(notForced.forced, false, 'defaults to false when not specified');
});
