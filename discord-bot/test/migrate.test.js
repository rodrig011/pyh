import test from 'node:test';
import assert from 'node:assert/strict';

import { broadcastAudience, migratedSubscriptions, planMigration } from '../src/vip/migrate.js';
import { SUBSCRIPTION_STATUS } from '../src/lib/subscriptions.js';

/**
 * The hazard: every membership is stored under `guildId:userId`. Point the bot
 * at a new server and the records do not follow — they sit in the file,
 * perfectly intact, attached to a server nobody is in. Every paying member
 * silently loses what they paid for, and nothing logs an error.
 */

const now = Date.parse('2026-08-06T12:00:00Z');
const sub = (over = {}) => ({
  guildId: 'old',
  userId: 'u1',
  tier: 1,
  status: SUBSCRIPTION_STATUS.ACTIVE,
  expiresAt: now + 20 * 86_400_000,
  ...over,
});

test('a migration can be read before it is run', () => {
  const plan = planMigration([sub(), sub({ userId: 'u2', tier: 3 })], {
    fromGuildId: 'old',
    toGuildId: 'new',
    now,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.moving.length, 2);
});

test('expired memberships are left behind, not carried over', () => {
  // History, not access. Carrying it makes the list unreadable.
  const plan = planMigration(
    [sub(), sub({ userId: 'u2', expiresAt: now - 86_400_000 })],
    { fromGuildId: 'old', toGuildId: 'new', now },
  );
  assert.equal(plan.moving.length, 1);
  assert.equal(plan.leaving, 1);
});

test('a cancelled membership does not move', () => {
  const plan = planMigration([sub({ status: SUBSCRIPTION_STATUS.EXPIRED })], {
    fromGuildId: 'old',
    toGuildId: 'new',
    now,
  });
  assert.equal(plan.moving.length, 0);
});

test('migrating to the same server is refused rather than done twice', () => {
  const plan = planMigration([sub()], { fromGuildId: 'old', toGuildId: 'old', now });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /same server/);
});

test('the records come out re-keyed to the new server', () => {
  const { subscriptions } = migratedSubscriptions([sub()], {
    fromGuildId: 'old',
    toGuildId: 'new',
    now,
  });
  assert.equal(subscriptions[0].guildId, 'new');
  assert.equal(subscriptions[0].migratedFrom, 'old');
});

test('on a collision the member keeps the LONGER membership', () => {
  // The alternative silently shortens time somebody paid for.
  const short = sub({ guildId: 'new', expiresAt: now + 2 * 86_400_000 });
  const long = sub({ guildId: 'old', expiresAt: now + 30 * 86_400_000 });

  const { subscriptions } = migratedSubscriptions([short, long], {
    fromGuildId: 'old',
    toGuildId: 'new',
    now,
  });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].expiresAt, long.expiresAt);
});

test('a longer membership already at the destination is not shortened', () => {
  const long = sub({ guildId: 'new', expiresAt: now + 30 * 86_400_000 });
  const short = sub({ guildId: 'old', expiresAt: now + 2 * 86_400_000 });

  const { subscriptions } = migratedSubscriptions([long, short], {
    fromGuildId: 'old',
    toGuildId: 'new',
    now,
  });
  assert.equal(subscriptions[0].expiresAt, long.expiresAt);
});

test('running the migration twice changes nothing the second time', () => {
  const first = migratedSubscriptions([sub()], { fromGuildId: 'old', toGuildId: 'new', now });
  const second = migratedSubscriptions(first.subscriptions, {
    fromGuildId: 'old',
    toGuildId: 'new',
    now,
  });
  assert.equal(second.subscriptions.length, 1);
  assert.equal(second.subscriptions[0].expiresAt, first.subscriptions[0].expiresAt);
});

/** Who hears an announcement. */

test('only active members are written to', () => {
  // Telling somebody whose access lapsed months ago that the server is moving
  // is a message to a stranger.
  const audience = broadcastAudience(
    [sub(), sub({ userId: 'u2', expiresAt: now - 1 }), sub({ userId: 'u3', status: SUBSCRIPTION_STATUS.EXPIRED })],
    { guildId: 'old', now },
  );
  assert.deepEqual(audience.map((s) => s.userId), ['u1']);
});

test('tiers can be picked, and no tiers means everybody', () => {
  const all = [sub({ userId: 'a', tier: 1 }), sub({ userId: 'b', tier: 2 }), sub({ userId: 'c', tier: 3 })];
  assert.equal(broadcastAudience(all, { guildId: 'old', now }).length, 3);
  assert.equal(broadcastAudience(all, { guildId: 'old', tiers: [1, 3], now }).length, 2);
});

test('one message per person, however many records they have', () => {
  const audience = broadcastAudience([sub(), sub({ tier: 2 })], { guildId: 'old', now });
  assert.equal(audience.length, 1);
});

test('members of a different server are never written to', () => {
  const audience = broadcastAudience([sub({ guildId: 'somewhere-else' })], { guildId: 'old', now });
  assert.equal(audience.length, 0);
});
