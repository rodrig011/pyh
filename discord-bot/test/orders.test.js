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
    1: { tier: 1, priceCents: 5000, roleId: 'rol-1' },
    2: { tier: 2, priceCents: 10000, roleId: 'rol-2' },
    3: { tier: 3, priceCents: 20000, roleId: 'rol-3' },
  },
};

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

test('createOrder guarda una orden pendiente con codigo unico', (t) => {
  const store = freshStore(t);
  const a = createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });
  const b = createOrder(store, { userId: '2', guildId: 'g', tier: 1, config });

  assert.notEqual(a.code, b.code);
  assert.equal(a.status, ORDER_STATUS.PENDING);
  assert.equal(a.amountCents, 10000);
  assert.equal(store.getOrder(a.code).userId, '1');
});

test('el almacen sobrevive a un reinicio', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vipstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.json');

  const order = createOrder(createStore(path), { userId: '1', guildId: 'g', tier: 3, config });
  const reloaded = createStore(path).getOrder(order.code);

  assert.equal(reloaded.tier, 3);
  assert.equal(reloaded.status, ORDER_STATUS.PENDING);
});

test('un pago con el codigo correcto empareja la orden', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 2, config });

  const result = matchPayment(store, { codes: [order.code], amountCents: 10000 }, config);
  assert.equal(result.status, 'match');
  assert.equal(result.tier, 2);
  assert.equal(result.order.code, order.code);
});

test('pagar 200 con una orden de tier 1 otorga el tier 3', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config });

  const result = matchPayment(store, { codes: [order.code], amountCents: 20000 }, config);
  assert.equal(result.status, 'match');
  assert.equal(result.tier, 3);
});

test('un pago de menos no otorga nada', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 3, config });

  const result = matchPayment(store, { codes: [order.code], amountCents: 5000 }, config);
  assert.equal(result.status, 'amount_mismatch');
  assert.equal(store.getOrder(order.code).status, ORDER_STATUS.PENDING);
});

test('un pago sin codigo o con codigo desconocido no aplica', (t) => {
  const store = freshStore(t);
  assert.equal(matchPayment(store, { codes: [], amountCents: 5000 }, config).status, 'no_code');
  assert.equal(
    matchPayment(store, { codes: ['VIP-ZZZZ99'], amountCents: 5000 }, config).status,
    'unknown_code',
  );
});

test('una orden vencida no se puede pagar', (t) => {
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

test('el mismo correo no se puede cobrar dos veces', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config });
  const payment = { codes: [order.code], amountCents: 5000, source: 'zelle-email' };

  const first = matchPayment(store, payment, config);
  assert.equal(first.status, 'match');
  markOrderPaid(store, first.order, { tier: first.tier, payment, grantedRoleIds: ['rol-1'] });

  const second = matchPayment(store, payment, config);
  assert.equal(second.status, 'already_paid');
});

test('markOrderPaid deja el rastro del pago', (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: '7', guildId: 'g', tier: 3, config });
  markOrderPaid(store, order, {
    tier: 3,
    payment: { source: 'zelle-email', senderName: 'JUAN PEREZ', amountCents: 20000, reference: '<x@y>' },
    grantedRoleIds: ['rol-1', 'rol-2', 'rol-3'],
  });

  const saved = store.getOrder(order.code);
  assert.equal(saved.status, ORDER_STATUS.PAID);
  assert.equal(saved.grantedTier, 3);
  assert.deepEqual(saved.grantedRoleIds, ['rol-1', 'rol-2', 'rol-3']);
  assert.equal(saved.payment.senderName, 'JUAN PEREZ');
  assert.equal(store.data.payments.length, 1);
});

test('expireStaleOrders solo toca las pendientes vencidas', (t) => {
  const store = freshStore(t);
  const vieja = createOrder(store, { userId: '1', guildId: 'g', tier: 1, config, now: Date.now() - 1e10 });
  const nueva = createOrder(store, { userId: '2', guildId: 'g', tier: 1, config });

  const expired = expireStaleOrders(store);
  assert.deepEqual(expired.map((order) => order.code), [vieja.code]);
  assert.equal(store.getOrder(nueva.code).status, ORDER_STATUS.PENDING);
});

test('el correo procesado se marca una sola vez', (t) => {
  const store = freshStore(t);
  assert.equal(store.isEmailProcessed('<a@b>'), false);
  store.markEmailProcessed('<a@b>');
  store.markEmailProcessed('<a@b>');
  assert.equal(store.isEmailProcessed('<a@b>'), true);
  assert.equal(store.data.processedEmails.length, 1);
});
