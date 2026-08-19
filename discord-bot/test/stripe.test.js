import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpretStripeEvent } from '../src/payments/stripe.js';
import { SUBSCRIPTION_STATUS } from '../src/lib/subscriptions.js';
import { createStore } from '../src/lib/store.js';
import { createOrder } from '../src/vip/orders.js';
import { applyStripeIntent } from '../src/vip/stripeFlow.js';

const config = {
  codePrefix: 'VIP',
  codeLength: 6,
  orderTtlHours: 48,
  amountToleranceCents: 0,
  upgradeOnOverpay: true,
  logChannelId: null,
  subscriptionDays: 30,
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'role-1' },
    2: { tier: 2, priceCents: 10000, roleId: 'role-2' },
    3: { tier: 3, priceCents: 20000, roleId: 'role-3' },
  },
};

function checkoutEvent(overrides = {}) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        payment_status: 'paid',
        client_reference_id: 'VIP-7K3QDM',
        metadata: { code: 'VIP-7K3QDM', guildId: 'g', userId: 'u1', tier: '2' },
        subscription: 'sub_123',
        customer: 'cus_123',
        amount_total: 10000,
        ...overrides,
      },
    },
  };
}

test('a completed card checkout activates the membership', () => {
  const intent = interpretStripeEvent(checkoutEvent());
  assert.equal(intent.action, 'activate');
  assert.equal(intent.code, 'VIP-7K3QDM');
  assert.equal(intent.subscriptionId, 'sub_123');
  assert.equal(intent.customerId, 'cus_123');
  assert.equal(intent.tier, 2);
  assert.equal(intent.amountCents, 10000);
});

test('an unpaid or one-off checkout is ignored', () => {
  assert.equal(interpretStripeEvent(checkoutEvent({ payment_status: 'unpaid' })).action, 'ignore');
  assert.equal(interpretStripeEvent(checkoutEvent({ mode: 'payment' })).action, 'ignore');
});

test('the first invoice is ignored — the checkout already granted access', () => {
  const intent = interpretStripeEvent({
    type: 'invoice.paid',
    data: { object: { billing_reason: 'subscription_create', subscription: 'sub_123' } },
  });
  assert.equal(intent.action, 'ignore');
});

test('a renewal invoice extends the membership to the new period end', () => {
  const periodEnd = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000);
  const intent = interpretStripeEvent({
    type: 'invoice.paid',
    data: {
      object: {
        billing_reason: 'subscription_cycle',
        subscription: 'sub_123',
        amount_paid: 10000,
        lines: { data: [{ period: { end: periodEnd } }] },
      },
    },
  });
  assert.equal(intent.action, 'renew');
  assert.equal(intent.subscriptionId, 'sub_123');
  assert.equal(intent.periodEnd, periodEnd);
});

test('a deleted or unpaid subscription revokes access', () => {
  assert.equal(
    interpretStripeEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } }).action,
    'cancel',
  );
  assert.equal(
    interpretStripeEvent({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'unpaid' } },
    }).action,
    'cancel',
  );
});

test('cancelling at period end only turns auto-renew off', () => {
  const intent = interpretStripeEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: true, current_period_end: 1800000000 } },
  });
  assert.equal(intent.action, 'autorenew_off');
  assert.equal(intent.periodEnd, 1800000000);
});

test('unrelated events are ignored', () => {
  assert.equal(interpretStripeEvent({ type: 'payment_intent.created', data: { object: {} } }).action, 'ignore');
  assert.equal(interpretStripeEvent(undefined).action, 'ignore');
});

/** Discord stub for the flow tests. */
function fakeClient() {
  const state = { added: [], removed: [], dms: [] };
  const held = new Set();
  const member = {
    roles: {
      cache: { has: (id) => held.has(id) },
      add: async (role) => {
        state.added.push(role.id ?? role);
        held.add(role.id ?? role);
      },
      remove: async (id) => {
        state.removed.push(id);
        held.delete(id);
      },
    },
  };
  const guild = {
    id: 'g',
    roles: {
      cache: { get: (id) => ({ id, name: id }) },
      fetch: async (id) => ({ id, name: id }),
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
  const dir = mkdtempSync(join(tmpdir(), 'vipstripe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

const stripeStub = (periodEndMs) => ({
  subscriptions: {
    retrieve: async () => ({
      status: 'active',
      current_period_end: Math.floor(periodEndMs / 1000),
      cancel_at_period_end: false,
    }),
  },
});

test('activating a card checkout grants roles and marks it auto-renewing', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 2, config });
  const periodEnd = Date.now() + 30 * 86400000;

  const result = await applyStripeIntent(
    client,
    store,
    config,
    { action: 'activate', code: order.code, subscriptionId: 'sub_1', customerId: 'cus_1', amountCents: 10000 },
    stripeStub(periodEnd),
  );

  assert.equal(result.status, 'granted');
  assert.deepEqual(state.added, ['role-1', 'role-2']);

  const subscription = store.getSubscription('g', 'u1');
  assert.equal(subscription.source, 'stripe');
  assert.equal(subscription.autoRenew, true);
  assert.equal(subscription.stripeSubscriptionId, 'sub_1');
  assert.equal(Math.floor(subscription.expiresAt / 1000), Math.floor(periodEnd / 1000));
});

test('a renewal pushes the expiry out without touching roles', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 1, config });
  await applyStripeIntent(
    client,
    store,
    config,
    { action: 'activate', code: order.code, subscriptionId: 'sub_1', amountCents: 5000 },
    stripeStub(Date.now() + 30 * 86400000),
  );
  state.added.length = 0;

  const nextPeriod = Math.floor((Date.now() + 60 * 86400000) / 1000);
  const result = await applyStripeIntent(client, store, config, {
    action: 'renew',
    subscriptionId: 'sub_1',
    periodEnd: nextPeriod,
  });

  assert.equal(result.status, 'renewed');
  assert.equal(store.getSubscription('g', 'u1').expiresAt, nextPeriod * 1000);
  assert.deepEqual(state.added, [], 'roles were already there');
  assert.deepEqual(state.removed, []);
});

test('a cancelled card subscription takes the roles back', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 2, config });
  await applyStripeIntent(
    client,
    store,
    config,
    { action: 'activate', code: order.code, subscriptionId: 'sub_1', amountCents: 10000 },
    stripeStub(Date.now() + 30 * 86400000),
  );

  const result = await applyStripeIntent(client, store, config, {
    action: 'cancel',
    subscriptionId: 'sub_1',
    reason: 'card declined',
  });

  assert.equal(result.status, 'revoked');
  assert.deepEqual(state.removed, ['role-1', 'role-2']);
  assert.equal(store.getSubscription('g', 'u1').status, SUBSCRIPTION_STATUS.EXPIRED);
});

test('turning auto-renew off keeps access but brings the reminders back', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 1, config });
  await applyStripeIntent(
    client,
    store,
    config,
    { action: 'activate', code: order.code, subscriptionId: 'sub_1', amountCents: 5000 },
    stripeStub(Date.now() + 30 * 86400000),
  );

  const periodEnd = Math.floor((Date.now() + 12 * 86400000) / 1000);
  await applyStripeIntent(client, store, config, {
    action: 'autorenew_off',
    subscriptionId: 'sub_1',
    periodEnd,
  });

  const subscription = store.getSubscription('g', 'u1');
  assert.equal(subscription.autoRenew, false);
  assert.equal(subscription.status, SUBSCRIPTION_STATUS.ACTIVE, 'access continues to the end of the period');
  assert.equal(subscription.expiresAt, periodEnd * 1000);
  assert.deepEqual(state.removed, []);
});

test('an event for an unknown subscription is reported, not applied', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();

  const renew = await applyStripeIntent(client, store, config, { action: 'renew', subscriptionId: 'sub_nope' });
  const cancel = await applyStripeIntent(client, store, config, { action: 'cancel', subscriptionId: 'sub_nope' });

  assert.equal(renew.status, 'unknown_subscription');
  assert.equal(cancel.status, 'unknown_subscription');
  assert.deepEqual(state.removed, []);
});

test('a checkout with no order code grants nothing', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();

  const result = await applyStripeIntent(client, store, config, {
    action: 'activate',
    code: null,
    subscriptionId: 'sub_1',
  });

  assert.equal(result.status, 'no_code');
  assert.deepEqual(state.added, []);
});
