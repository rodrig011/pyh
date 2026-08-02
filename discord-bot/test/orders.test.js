import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { ORDER_STATUS, createOrder, expireStaleOrders, markOrderPaid, matchPayment } from '../src/vip/orders.js';

const config = {
  codePrefix: 'VIP',
  codeLength: 6,
  orderTtlHours: 48,
  amountToleranceCents: 0,
  upgradeOnOverpay: true,
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'role-1' },
    2: { tier: 2, priceCents: 10000, roleId: 'role-2' },
    3: { tier: 3, priceCents: 20000, roleId: 'role-3' },
  },
};

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

test('createOrder saves a pending order with a unique code', (t) => {
  const store = freshStore(t);
  const a = createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });
  const b = createOrder(store, { userId: '2', guildId: 'g', tier: 1, config });

  assert.notEqual(a.code, b.code);
  assert.equal(a.status, ORDER_STATUS.PENDING);
  assert.equal(a.amountCents, 10000);
  assert.equal(store.getOrder(a.code).userId, '1');
});

test('the store survives a restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vipstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.json');

  const order = createOrder(createStore(path), { userId: '1', guildId: 'g', tier: 3, config });
  const reloaded = createStore(path).getOrder(order.code);

  assert.equal(reloaded.tier, 3);
  assert.equal(reloaded.status, ORDER_STATUS.PENDING);
});

test('a payment carrying the right code matches its order', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });

  const result = matchPayment(store, { codes: [order.code], amountCents: 10000 }, config);
  assert.equal(result.status, 'match');
  assert.equal(result.tier, 2);
  assert.equal(result.order.code, order.code);
});

test('paying 200 on a tier 1 order grants tier 3', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config });

  const result = matchPayment(store, { codes: [order.code], amountCents: 20000 }, config);
  assert.equal(result.status, 'match');
  assert.equal(result.tier, 3);
});

test('an underpayment grants nothing', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 3, config });

  const result = matchPayment(store, { codes: [order.code], amountCents: 5000 }, config);
  assert.equal(result.status, 'amount_mismatch');
  assert.equal(store.getOrder(order.code).status, ORDER_STATUS.PENDING);
});

test('a payment with no code or an unknown code does not apply', (t) => {
  const store = freshStore(t);
  assert.equal(matchPayment(store, { codes: [], amountCents: 5000 }, config).status, 'no_code');
  assert.equal(
    matchPayment(store, { codes: ['VIP-ZZZZ99'], amountCents: 5000 }, config).status,
    'unknown_code',
  );
});

// Huntington's Zelle alert never repeats the memo, so most real payments land
// with no code at all. The amount has to carry the identification instead.
const byAmount = { ...config, matchByAmount: true, amountMatchWindowMinutes: 180 };

test('with no code, a single fresh order for that exact amount is the payer', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });

  const result = matchPayment(store, { codes: [], amountCents: 10000 }, byAmount);
  assert.equal(result.status, 'match');
  assert.equal(result.order.code, order.code);
  assert.equal(result.tier, 2);
  assert.equal(result.matchedBy, 'amount');
});

test('two orders waiting on the same amount are never guessed between', (t) => {
  const store = freshStore(t);
  createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });
  createOrder(store, { userId: '2', guildId: 'g', tier: 2, config });

  const result = matchPayment(store, { codes: [], amountCents: 10000 }, byAmount);
  assert.equal(result.status, 'ambiguous_amount');
  assert.equal(result.candidates.length, 2);
});

test('a personal transfer nobody is waiting for stays a no_code', (t) => {
  const store = freshStore(t);
  createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });

  // $75 matches no tier, and the tier 2 order is waiting on $100.
  assert.equal(matchPayment(store, { codes: [], amountCents: 7500 }, byAmount).status, 'no_code');
});

test('a mistyped code still lands if the amount points at one order', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 3, config });

  const result = matchPayment(store, { codes: ['VIP-ZZZZ99'], amountCents: 20000 }, byAmount);
  assert.equal(result.status, 'match');
  assert.equal(result.order.code, order.code);
  assert.equal(result.matchedBy, 'amount');
});

test('a phrase that only looks like a code does not block the amount match', (t) => {
  const store = freshStore(t);
  // "Your VIP 2 payment is pending" scans as VIP-2PAYME.
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });

  const result = matchPayment(store, { codes: ['VIP-2PAYME'], amountCents: 10000 }, byAmount);
  assert.equal(result.status, 'match');
  assert.equal(result.order.code, order.code);
});

test('a code nobody can place and an amount nobody awaits is still unknown_code', (t) => {
  const store = freshStore(t);
  const result = matchPayment(store, { codes: ['VIP-ZZZZ99'], amountCents: 7500 }, byAmount);
  assert.equal(result.status, 'unknown_code');
});

test('a real code beats the amount and keeps its own tier', (t) => {
  const store = freshStore(t);
  const tier1 = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config });
  createOrder(store, { userId: '2', guildId: 'g', tier: 1, config });

  // Two orders sit at $50, so the amount alone would be ambiguous. The code
  // settles it.
  const result = matchPayment(store, { codes: [tier1.code], amountCents: 5000 }, byAmount);
  assert.equal(result.status, 'match');
  assert.equal(result.matchedBy, 'code');
  assert.equal(result.order.userId, '1');
});

test('an order older than the window is not matched by amount alone', (t) => {
  const store = freshStore(t);
  // Still pending (48h TTL) but placed four hours ago: too stale to assume the
  // money that just arrived is this person's.
  createOrder(store, {
    userId: '1',
    guildId: 'g',
    tier: 1,
    config,
    now: Date.now() - 4 * 3600 * 1000,
  });

  assert.equal(matchPayment(store, { codes: [], amountCents: 5000 }, byAmount).status, 'no_code');
});

test('an already paid order does not soak up the next payment of the same size', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config });
  markOrderPaid(store, order, { tier: 1, payment: { amountCents: 5000 }, grantedRoleIds: [] });

  assert.equal(matchPayment(store, { codes: [], amountCents: 5000 }, byAmount).status, 'no_code');
});

test('MATCH_BY_AMOUNT=false goes back to code-only', (t) => {
  const store = freshStore(t);
  createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });

  const off = { ...byAmount, matchByAmount: false };
  assert.equal(matchPayment(store, { codes: [], amountCents: 10000 }, off).status, 'no_code');
});

test('an expired order cannot be paid', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, {
    userId: '1',
    guildId: 'g',
    tier: 1,
    config,
    now: Date.now() - 72 * 3600 * 1000,
  });

  const result = matchPayment(store, { codes: [order.code], amountCents: 5000 }, config);
  assert.equal(result.status, 'expired');
  assert.equal(store.getOrder(order.code).status, ORDER_STATUS.EXPIRED);
});

test('the same payment cannot be redeemed twice', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config });
  const payment = { codes: [order.code], amountCents: 5000, source: 'zelle-email' };

  const first = matchPayment(store, payment, config);
  assert.equal(first.status, 'match');
  markOrderPaid(store, first.order, { tier: first.tier, payment, grantedRoleIds: ['role-1'] });

  const second = matchPayment(store, payment, config);
  assert.equal(second.status, 'already_paid');
});

test('markOrderPaid keeps the payment trail', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '7', guildId: 'g', tier: 3, config });
  markOrderPaid(store, order, {
    tier: 3,
    payment: { source: 'zelle-email', senderName: 'JUAN PEREZ', amountCents: 20000, reference: '<x@y>' },
    grantedRoleIds: ['role-1', 'role-2', 'role-3'],
  });

  const saved = store.getOrder(order.code);
  assert.equal(saved.status, ORDER_STATUS.PAID);
  assert.equal(saved.grantedTier, 3);
  assert.deepEqual(saved.grantedRoleIds, ['role-1', 'role-2', 'role-3']);
  assert.equal(saved.payment.senderName, 'JUAN PEREZ');
  assert.equal(store.data.payments.length, 1);
});

test('expireStaleOrders only touches overdue pending orders', (t) => {
  const store = freshStore(t);
  const old = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config, now: Date.now() - 1e10 });
  const recent = createOrder(store, { userId: '2', guildId: 'g', tier: 1, config });

  const expired = expireStaleOrders(store);
  assert.deepEqual(expired.map((order) => order.code), [old.code]);
  assert.equal(store.getOrder(recent.code).status, ORDER_STATUS.PENDING);
});

test('a processed email is only recorded once', (t) => {
  const store = freshStore(t);
  assert.equal(store.isEmailProcessed('<a@b>'), false);
  store.markEmailProcessed('<a@b>');
  store.markEmailProcessed('<a@b>');
  assert.equal(store.isEmailProcessed('<a@b>'), true);
  assert.equal(store.data.processedEmails.length, 1);
});

// The name on the bank alert is the only identifying thing left once the memo
// is gone. It is what turns "a mod clicks a button" back into "it just works".

test('the payer name matches an order the amount window has already aged out of', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, {
    userId: '1',
    guildId: 'g',
    tier: 2,
    payerName: 'Chris Swails',
    config,
    // A day old: far outside the 3-hour amount window, still inside the TTL.
    now: Date.now() - 24 * 3600 * 1000,
  });

  const result = matchPayment(
    store,
    { codes: [], amountCents: 10000, senderName: 'CHRISTOPHER SWAILS' },
    byAmount,
  );

  assert.equal(result.status, 'match');
  assert.equal(result.order.code, order.code);
  assert.equal(result.matchedBy, 'name');
});

test('the name picks the right buyer when two are waiting on the same amount', (t) => {
  const store = freshStore(t);
  createOrder(store, { userId: '1', guildId: 'g', tier: 2, payerName: 'Maria Gomez', config });
  const mine = createOrder(store, {
    userId: '2',
    guildId: 'g',
    tier: 2,
    payerName: 'Christopher Swails',
    config,
  });

  const result = matchPayment(
    store,
    { codes: [], amountCents: 10000, senderName: 'CHRISTOPHER SWAILS' },
    byAmount,
  );

  assert.equal(result.status, 'match');
  assert.equal(result.order.code, mine.code);
  assert.equal(result.order.userId, '2');
});

test('a name nobody claimed does not steal a fresh order', (t) => {
  const store = freshStore(t);
  createOrder(store, { userId: '1', guildId: 'g', tier: 2, payerName: 'Maria Gomez', config });

  // The order is fresh, so the amount window would have matched it — but a
  // different person's name is on the payment, which rules it out.
  const result = matchPayment(
    store,
    { codes: [], amountCents: 10000, senderName: 'CHRISTOPHER SWAILS' },
    byAmount,
  );

  assert.equal(result.status, 'no_code');
});

test('two buyers who gave the same name are sent to the mods, not guessed', (t) => {
  const store = freshStore(t);
  createOrder(store, { userId: '1', guildId: 'g', tier: 1, payerName: 'Chris Swails', config });
  createOrder(store, { userId: '2', guildId: 'g', tier: 1, payerName: 'Christopher Swails', config });

  const result = matchPayment(
    store,
    { codes: [], amountCents: 5000, senderName: 'CHRISTOPHER SWAILS' },
    byAmount,
  );

  assert.equal(result.status, 'ambiguous_amount');
  assert.equal(result.candidates.length, 2);
});

test('an order with no name still matches on amount while it is fresh', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 3, config });

  const result = matchPayment(
    store,
    { codes: [], amountCents: 20000, senderName: 'SOMEONE ELSE' },
    byAmount,
  );

  assert.equal(result.status, 'match');
  assert.equal(result.order.code, order.code);
  assert.equal(result.matchedBy, 'amount');
});
