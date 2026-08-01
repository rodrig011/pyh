import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, SUBSCRIPTION_STATUS } from '../src/lib/subscriptions.js';
import { computeStats } from '../src/vip/stats.js';

const NOW = Date.parse('2026-03-01T12:00:00Z');

const tiers = {
  1: { priceCents: 5000 },
  2: { priceCents: 10000 },
  3: { priceCents: 20000 },
};

const sub = (over = {}) => ({
  guildId: 'g',
  userId: 'u',
  tier: 1,
  status: SUBSCRIPTION_STATUS.ACTIVE,
  expiresAt: NOW + 20 * DAY_MS,
  ...over,
});

const opts = { now: NOW, guildId: 'g', tiers };

test('counts active members per tier and totals them', () => {
  const stats = computeStats(
    {
      subscriptions: [
        sub({ userId: 'a', tier: 1 }),
        sub({ userId: 'b', tier: 2 }),
        sub({ userId: 'c', tier: 2 }),
        sub({ userId: 'd', tier: 3 }),
      ],
    },
    opts,
  );
  assert.equal(stats.active.total, 4);
  assert.deepEqual(stats.active.byTier, { 1: 1, 2: 2, 3: 1 });
});

test('expired and lapsed memberships are not counted as active', () => {
  const stats = computeStats(
    {
      subscriptions: [
        sub({ userId: 'a' }),
        sub({ userId: 'b', status: SUBSCRIPTION_STATUS.EXPIRED, endedAt: NOW - DAY_MS }),
        sub({ userId: 'c', expiresAt: NOW - DAY_MS }),
      ],
    },
    opts,
  );
  assert.equal(stats.active.total, 1);
  assert.equal(stats.lost30d, 1, 'the one that ended recently is reported as churn');
});

test('the period value is what the current members are worth if they all renew', () => {
  const stats = computeStats(
    { subscriptions: [sub({ userId: 'a', tier: 1 }), sub({ userId: 'b', tier: 3 })] },
    opts,
  );
  assert.equal(stats.monthlyValueCents, 25000, '$50 + $200');
});

test('revenue is split by window and by payment method', () => {
  const stats = computeStats(
    {
      subscriptions: [sub({ userId: 'a' })],
      payments: [
        { userId: 'a', amountCents: 5000, at: NOW - 2 * DAY_MS, source: 'zelle-email' },
        { userId: 'a', amountCents: 10000, at: NOW - 20 * DAY_MS, source: 'stripe' },
        { userId: 'a', amountCents: 20000, at: NOW - 90 * DAY_MS, source: 'manual' },
      ],
    },
    opts,
  );
  assert.equal(stats.revenue.last7dCents, 5000);
  assert.equal(stats.revenue.last30dCents, 15000);
  assert.equal(stats.revenue.allTimeCents, 35000);
  assert.deepEqual(stats.revenue.bySource, { 'zelle-email': 5000, stripe: 10000 });
  assert.equal(stats.payments.last30d, 2);
});

test('members about to expire are listed soonest first', () => {
  const stats = computeStats(
    {
      subscriptions: [
        sub({ userId: 'later', expiresAt: NOW + 5 * DAY_MS }),
        sub({ userId: 'soon', expiresAt: NOW + 1 * DAY_MS }),
        sub({ userId: 'safe', expiresAt: NOW + 25 * DAY_MS }),
      ],
    },
    opts,
  );
  assert.equal(stats.expiringSoon.count, 2);
  assert.deepEqual(stats.expiringSoon.members.map((s) => s.userId), ['soon', 'later']);
});

test('card members are counted separately: those renew themselves', () => {
  const stats = computeStats(
    { subscriptions: [sub({ userId: 'a', autoRenew: true }), sub({ userId: 'b' })] },
    opts,
  );
  assert.equal(stats.active.autoRenewing, 1);
});

test('another server\'s members and money never leak in', () => {
  const stats = computeStats(
    {
      subscriptions: [sub({ userId: 'mine' }), sub({ userId: 'theirs', guildId: 'other' })],
      payments: [
        { userId: 'mine', amountCents: 5000, at: NOW - DAY_MS },
        { userId: 'theirs', amountCents: 99900, at: NOW - DAY_MS },
      ],
    },
    opts,
  );
  assert.equal(stats.active.total, 1);
  assert.equal(stats.revenue.last30dCents, 5000);
});

test('an empty server reports zeros instead of blowing up', () => {
  const stats = computeStats({}, opts);
  assert.equal(stats.active.total, 0);
  assert.equal(stats.revenue.allTimeCents, 0);
  assert.equal(stats.monthlyValueCents, 0);
  assert.equal(stats.expiringSoon.count, 0);
  assert.equal(stats.pendingOrders, 0);
});
