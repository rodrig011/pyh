import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, SUBSCRIPTION_STATUS } from '../src/lib/subscriptions.js';
import { createStore } from '../src/lib/store.js';
import { upsertSubscription } from '../src/vip/subscriptions.js';
import { sweepSubscriptions } from '../src/vip/subscriptionSweeper.js';

const NOW = Date.parse('2026-03-01T12:00:00Z');

const config = {
  subscriptionDays: 30,
  reminderDaysBefore: [3, 1],
  subscriptionGraceDays: 0,
  logChannelId: null,
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'role-1' },
    2: { tier: 2, priceCents: 10000, roleId: 'role-2' },
    3: { tier: 3, priceCents: 20000, roleId: 'role-3' },
  },
};

/** Discord stub that records role removals and DMs, and can simulate a member who left. */
function fakeClient({ memberPresent = true, roles = ['role-1', 'role-2', 'role-3'] } = {}) {
  const state = { removed: [], dms: [] };
  const held = new Set(roles);

  const member = {
    roles: {
      cache: { has: (id) => held.has(id) },
      remove: async (id) => {
        state.removed.push(id);
        held.delete(id);
      },
    },
  };

  const guild = {
    id: 'g',
    members: { fetch: async () => (memberPresent ? member : Promise.reject(new Error('Unknown Member'))) },
  };

  return {
    state,
    client: {
      guilds: { fetch: async () => guild },
      users: {
        fetch: async (id) => ({ send: async (payload) => state.dms.push({ id, payload }) }),
      },
      channels: { fetch: async () => null },
    },
  };
}

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipsweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

test('an expired membership loses its roles and gets a DM', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 2, days: 30, now: NOW });

  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS);

  assert.equal(result.expired, 1);
  assert.deepEqual(state.removed, ['role-1', 'role-2'], 'tier 2 gives back roles 1 and 2');
  assert.equal(state.dms.length, 1);
  assert.equal(store.getSubscription('g', 'u').status, SUBSCRIPTION_STATUS.EXPIRED);
});

test('an active membership is left alone', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  const result = await sweepSubscriptions(client, store, config, NOW + 10 * DAY_MS);

  assert.deepEqual(result, { reminded: 0, expired: 0, failed: 0, reconciled: 0 });
  assert.deepEqual(state.removed, []);
  assert.deepEqual(state.dms, []);
});

test('the member is warned three days out, once', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  const nearly = NOW + 27 * DAY_MS + 1000;
  assert.equal((await sweepSubscriptions(client, store, config, nearly)).reminded, 1);
  assert.equal((await sweepSubscriptions(client, store, config, nearly)).reminded, 0, 'not repeated');

  assert.equal(state.dms.length, 1);
  assert.deepEqual(state.removed, [], 'warning only, no roles touched yet');
});

test('the reminder is followed by a second one the last day', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  await sweepSubscriptions(client, store, config, NOW + 27 * DAY_MS + 1000);
  await sweepSubscriptions(client, store, config, NOW + 29 * DAY_MS + 1000);

  assert.equal(state.dms.length, 2);
  assert.deepEqual(store.getSubscription('g', 'u').remindersSent, [3, 1]);
});

test('a member who left the server is expired without crashing', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient({ memberPresent: false });
  upsertSubscription(store, { guildId: 'g', userId: 'gone', tier: 3, days: 30, now: NOW });

  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS);

  assert.equal(result.expired, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(state.removed, []);
  assert.equal(store.getSubscription('g', 'gone').status, SUBSCRIPTION_STATUS.EXPIRED);
});

test('closed DMs do not stop the roles from being removed', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  client.users.fetch = async () => ({
    send: async () => {
      throw new Error('Cannot send messages to this user');
    },
  });
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS);

  assert.equal(result.expired, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(state.removed, ['role-1']);
});

test('the grace period holds the roles a little longer', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const withGrace = { ...config, subscriptionGraceDays: 2 };
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  assert.equal((await sweepSubscriptions(client, store, withGrace, NOW + 31 * DAY_MS)).expired, 0);
  assert.deepEqual(state.removed, []);

  assert.equal((await sweepSubscriptions(client, store, withGrace, NOW + 33 * DAY_MS)).expired, 1);
  assert.deepEqual(state.removed, ['role-1']);
});

test('renewing before the sweep keeps the roles', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  // Renewed on day 29, so on day 31 there is still plenty of time left.
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW + 29 * DAY_MS });
  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS);

  assert.equal(result.expired, 0);
  assert.deepEqual(state.removed, []);
  assert.equal(store.getSubscription('g', 'u').status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('a card membership is never nagged to renew — it bills itself', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const sub = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });
  sub.autoRenew = true;
  sub.source = 'stripe';
  store.putSubscription(sub);

  const result = await sweepSubscriptions(client, store, config, NOW + 29 * DAY_MS);

  assert.equal(result.reminded, 0);
  assert.deepEqual(state.dms, []);
});

test('reminders come back once the member cancels auto-renew', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const sub = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });
  sub.autoRenew = false;
  store.putSubscription(sub);

  const result = await sweepSubscriptions(client, store, config, NOW + 29 * DAY_MS);

  assert.equal(result.reminded, 1);
  assert.equal(state.dms.length, 1);
});

test('a missed renewal webhook does not cost a paying member their roles', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const sub = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 2, days: 30, now: NOW });
  sub.stripeSubscriptionId = 'sub_live';
  sub.autoRenew = true;
  store.putSubscription(sub);

  // Our copy looks expired, but Stripe says they are paid for another period.
  const stripe = {
    subscriptions: {
      retrieve: async () => ({
        status: 'active',
        current_period_end: Math.floor((NOW + 60 * DAY_MS) / 1000),
        cancel_at_period_end: false,
      }),
    },
  };

  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS, stripe);

  assert.equal(result.reconciled, 1);
  assert.equal(result.expired, 0);
  assert.deepEqual(state.removed, [], 'roles stay');
  assert.equal(store.getSubscription('g', 'u').expiresAt, NOW + 60 * DAY_MS);
});

test('a card subscription that really ended still loses its roles', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const sub = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });
  sub.stripeSubscriptionId = 'sub_dead';
  sub.autoRenew = true;
  store.putSubscription(sub);

  const stripe = {
    subscriptions: {
      retrieve: async () => ({ status: 'canceled', current_period_end: null, cancel_at_period_end: false }),
    },
  };

  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS, stripe);

  assert.equal(result.expired, 1);
  assert.deepEqual(state.removed, ['role-1']);
});

test('a Stripe outage during the sweep does not strand the membership', async (t) => {
  const store = freshStore(t);
  const { client, state } = fakeClient();
  const sub = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });
  sub.stripeSubscriptionId = 'sub_x';
  store.putSubscription(sub);

  const stripe = {
    subscriptions: {
      retrieve: async () => {
        throw new Error('Stripe is down');
      },
    },
  };

  const result = await sweepSubscriptions(client, store, config, NOW + 31 * DAY_MS, stripe);

  // Falls back to our own record rather than crashing the sweep.
  assert.equal(result.failed, 0);
  assert.equal(result.expired, 1);
  assert.deepEqual(state.removed, ['role-1']);
});
