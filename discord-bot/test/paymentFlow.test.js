import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { createOrder } from '../src/vip/orders.js';
import { processPayment } from '../src/vip/paymentFlow.js';

const config = {
  codePrefix: 'VIP',
  codeLength: 6,
  orderTtlHours: 48,
  amountToleranceCents: 0,
  upgradeOnOverpay: true,
  logChannelId: null,
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'role-1' },
    2: { tier: 2, priceCents: 10000, roleId: 'role-2' },
    3: { tier: 3, priceCents: 20000, roleId: 'role-3' },
  },
};

/** Stubbed Discord client: records the roles granted and the DMs sent. */
function fakeClient() {
  const state = { roles: [], dms: [] };
  const memberRoles = new Set();

  const member = {
    roles: {
      cache: { has: (id) => memberRoles.has(id) },
      add: async (role) => {
        state.roles.push(role.id);
        memberRoles.add(role.id);
      },
    },
  };

  const guild = {
    id: 'g',
    roles: {
      cache: { get: (id) => (['role-1', 'role-2', 'role-3'].includes(id) ? { id, name: id } : undefined) },
      fetch: async (id) => (['role-1', 'role-2', 'role-3'].includes(id) ? { id, name: id } : null),
    },
    members: { fetch: async () => member },
  };

  return {
    state,
    client: {
      guilds: { fetch: async () => guild },
      users: { fetch: async () => ({ send: async (payload) => state.dms.push(payload) }) },
      channels: { fetch: async () => null },
    },
  };
}

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

test('a tier 3 payment grants all three roles', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 3, config });

  const result = await processPayment(client, store, config, {
    codes: [order.code],
    amountCents: 20000,
    source: 'zelle-email',
    senderName: 'JUAN PEREZ',
  });

  assert.equal(result.status, 'granted');
  assert.equal(result.tier, 3);
  assert.deepEqual(state.roles, ['role-1', 'role-2', 'role-3']);
  assert.equal(state.dms.length, 1, 'the buyer is notified by DM');
  assert.equal(store.getOrder(order.code).status, 'paid');
});

test('a tier 2 payment grants roles 1 and 2', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 2, config });

  const result = await processPayment(client, store, config, { codes: [order.code], amountCents: 10000 });

  assert.equal(result.tier, 2);
  assert.deepEqual(state.roles, ['role-1', 'role-2']);
});

test('a tier 1 payment grants role 1 only', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 1, config });

  const result = await processPayment(client, store, config, { codes: [order.code], amountCents: 5000 });

  assert.equal(result.tier, 1);
  assert.deepEqual(state.roles, ['role-1']);
});

test('an underpayment grants no roles at all', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 3, config });

  const result = await processPayment(client, store, config, { codes: [order.code], amountCents: 5000 });

  assert.equal(result.status, 'amount_mismatch');
  assert.deepEqual(state.roles, []);
  assert.equal(store.getOrder(order.code).status, 'pending');
});

test('a payment with a made-up code grants nothing', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  createOrder(store, { userId: 'u1', guildId: 'g', tier: 3, config });

  const result = await processPayment(client, store, config, { codes: ['VIP-ZZZZ99'], amountCents: 20000 });

  assert.equal(result.status, 'unknown_code');
  assert.deepEqual(state.roles, []);
});

test('replaying the same payment does not grant the roles again', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 2, config });
  const payment = { codes: [order.code], amountCents: 10000, source: 'zelle-email' };

  await processPayment(client, store, config, payment);
  const repeat = await processPayment(client, store, config, payment);

  assert.equal(repeat.status, 'already_paid');
  assert.deepEqual(state.roles, ['role-1', 'role-2'], 'roles are not duplicated');
});
