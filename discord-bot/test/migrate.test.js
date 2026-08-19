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

/**
 * The broadcast reached ELEVEN people out of a room of hundreds.
 *
 * It read the subscription store, which only knows about people who paid
 * THROUGH THE BOT. Everyone given a role by hand, or who paid before the bot
 * existed, or who paid the owner directly, has the role and no record — and
 * from the store's point of view was never a member at all.
 *
 * The role is the truth of who is in the room. The store is a truth about who
 * paid, and the two have never been the same set.
 */

import { everyoneToNotify, roleAudience } from '../src/vip/migrate.js';

const member = (id, roles, { bot = false } = {}) => ({
  id,
  user: { bot },
  roles: { cache: new Set(roles) },
});

test('everyone holding a VIP role is written to, record or not', () => {
  const members = [
    member('a', ['role-1']),
    member('b', ['role-2']),
    member('c', ['role-3']),
    member('d', ['some-other-role']),
  ];
  const found = roleAudience(members, ['role-1', 'role-2', 'role-3']);
  assert.deepEqual(found.sort(), ['a', 'b', 'c']);
});

test('somebody holding two tiers is written to once', () => {
  const found = roleAudience([member('a', ['role-1', 'role-2'])], ['role-1', 'role-2']);
  assert.deepEqual(found, ['a']);
});

test('bots are never messaged', () => {
  // A guaranteed failure that pollutes the count.
  const found = roleAudience([member('a', ['role-1']), member('bot', ['role-1'], { bot: true })], ['role-1']);
  assert.deepEqual(found, ['a']);
});

test('with no roles configured nobody is written to, rather than everybody', () => {
  assert.deepEqual(roleAudience([member('a', ['role-1'])], []), []);
  assert.deepEqual(roleAudience([member('a', ['role-1'])], [null, undefined]), []);
});

test('role holders AND payers both get it, deduped', () => {
  // A role holder with no payment record is still in the room; a payer whose
  // role was removed by accident still paid. Missing somebody costs more than
  // messaging one person twice — and the dedupe means nobody is.
  const members = [member('role-only', ['role-1']), member('both', ['role-1'])];
  const subscriptions = [
    sub({ userId: 'both' }),
    sub({ userId: 'payer-only' }),
  ];

  const everyone = everyoneToNotify({
    members,
    roleIds: ['role-1'],
    subscriptions,
    guildId: 'old',
    now,
  });

  assert.deepEqual(everyone.sort(), ['both', 'payer-only', 'role-only']);
});

test('the union never messages the same person twice', () => {
  const everyone = everyoneToNotify({
    members: [member('u1', ['role-1'])],
    roleIds: ['role-1'],
    subscriptions: [sub({ userId: 'u1' }), sub({ userId: 'u1', tier: 2 })],
    guildId: 'old',
    now,
  });
  assert.deepEqual(everyone, ['u1']);
});
