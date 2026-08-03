import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAY_MS,
  SUBSCRIPTION_STATUS,
  computeExpiry,
  daysLeft,
  dueReminder,
  isExpired,
} from '../src/lib/subscriptions.js';
import { createStore } from '../src/lib/store.js';
import { endSubscription, markReminded, upsertSubscription } from '../src/vip/subscriptions.js';

const NOW = Date.parse('2026-03-01T12:00:00Z');

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipsubs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

test('a new membership lasts the configured number of days', () => {
  assert.equal(computeExpiry({ now: NOW, days: 30 }), NOW + 30 * DAY_MS);
});

test('renewing early stacks the days on top of the time left', () => {
  const remaining = NOW + 10 * DAY_MS;
  assert.equal(computeExpiry({ currentExpiresAt: remaining, now: NOW, days: 30 }), remaining + 30 * DAY_MS);
});

test('renewing after expiry starts a fresh period from today', () => {
  const lapsed = NOW - 5 * DAY_MS;
  assert.equal(computeExpiry({ currentExpiresAt: lapsed, now: NOW, days: 30 }), NOW + 30 * DAY_MS);
});

test('daysLeft rounds up so a partial day still counts', () => {
  assert.equal(daysLeft({ expiresAt: NOW + 3 * DAY_MS }, NOW), 3);
  assert.equal(daysLeft({ expiresAt: NOW + 2.2 * DAY_MS }, NOW), 3);
  assert.equal(daysLeft({ expiresAt: NOW + 0.1 * DAY_MS }, NOW), 1);
});

test('isExpired honours the grace period', () => {
  const sub = { expiresAt: NOW };
  assert.equal(isExpired(sub, NOW), true);
  assert.equal(isExpired(sub, NOW - 1), false);
  assert.equal(isExpired(sub, NOW + DAY_MS, 2), false, 'still inside the 2-day grace');
  assert.equal(isExpired(sub, NOW + 3 * DAY_MS, 2), true);
});

test('reminders fire once per threshold', () => {
  const sub = { status: SUBSCRIPTION_STATUS.ACTIVE, expiresAt: NOW + 3 * DAY_MS, remindersSent: [] };
  const first = dueReminder(sub, NOW, [3, 1]);
  assert.deepEqual(first, { send: 3, cover: [3] });

  sub.remindersSent = [3];
  assert.equal(dueReminder(sub, NOW, [3, 1]), null, 'not sent twice');
});

test('a bot that was offline sends only the most urgent reminder', () => {
  const sub = { status: SUBSCRIPTION_STATUS.ACTIVE, expiresAt: NOW + 0.5 * DAY_MS, remindersSent: [] };
  const due = dueReminder(sub, NOW, [3, 1]);
  assert.equal(due.send, 1, 'the urgent one');
  assert.deepEqual(due.cover, [3, 1], 'the 3-day one is marked as covered, not sent late');
});

test('no reminders for memberships that already ended', () => {
  assert.equal(
    dueReminder({ status: SUBSCRIPTION_STATUS.EXPIRED, expiresAt: NOW + DAY_MS, remindersSent: [] }, NOW, [3]),
    null,
  );
  assert.equal(
    dueReminder({ status: SUBSCRIPTION_STATUS.ACTIVE, expiresAt: NOW - DAY_MS, remindersSent: [] }, NOW, [3]),
    null,
  );
});

test('upsertSubscription creates then renews, stacking the time', (t) => {
  const store = freshStore(t);
  const first = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, code: 'VIP-AAAA11', days: 30, now: NOW });

  assert.equal(first.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(first.expiresAt, NOW + 30 * DAY_MS);
  assert.equal(first.renewals, 0);

  const later = NOW + 20 * DAY_MS;
  const second = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, code: 'VIP-BBBB22', days: 30, now: later });

  assert.equal(second.expiresAt, first.expiresAt + 30 * DAY_MS, 'the 10 remaining days are kept');
  assert.equal(second.renewals, 1);
  assert.equal(second.startedAt, NOW, 'the original start date is preserved');
  assert.deepEqual(second.remindersSent, [], 'the new period gets its own reminders');
});

test('renewing with a higher tier upgrades, a lower one never demotes', (t) => {
  const store = freshStore(t);
  upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });

  const upgraded = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 3, days: 30, now: NOW + DAY_MS });
  assert.equal(upgraded.tier, 3);

  const downgrade = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW + 2 * DAY_MS });
  assert.equal(downgrade.tier, 3, 'buying a cheaper tier only adds time');
});

test('an expired membership restarts instead of stacking', (t) => {
  const store = freshStore(t);
  const first = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });
  endSubscription(store, first, { status: SUBSCRIPTION_STATUS.EXPIRED, now: NOW + 31 * DAY_MS });

  const comeback = NOW + 60 * DAY_MS;
  const again = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: comeback });

  assert.equal(again.expiresAt, comeback + 30 * DAY_MS);
  assert.equal(again.renewals, 0, 'a comeback is a fresh membership, not a renewal');
  assert.equal(again.status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('subscriptions are stored per guild and per user', (t) => {
  const store = freshStore(t);
  upsertSubscription(store, { guildId: 'g1', userId: 'u', tier: 1, days: 30, now: NOW });
  upsertSubscription(store, { guildId: 'g2', userId: 'u', tier: 3, days: 30, now: NOW });

  assert.equal(store.getSubscription('g1', 'u').tier, 1);
  assert.equal(store.getSubscription('g2', 'u').tier, 3);
  assert.equal(store.getSubscription('g1', 'other'), null);
});

test('markReminded records every covered threshold', (t) => {
  const store = freshStore(t);
  const sub = upsertSubscription(store, { guildId: 'g', userId: 'u', tier: 1, days: 30, now: NOW });
  markReminded(store, sub, [3, 1]);
  assert.deepEqual(store.getSubscription('g', 'u').remindersSent, [3, 1]);
});

test('the store keeps subscriptions across a restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vipsubs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.json');

  upsertSubscription(createStore(path), { guildId: 'g', userId: 'u', tier: 2, days: 30, now: NOW });
  const reloaded = createStore(path).getSubscription('g', 'u');

  assert.equal(reloaded.tier, 2);
  assert.equal(reloaded.expiresAt, NOW + 30 * DAY_MS);
});

test('the store reports at boot when it cannot be written', async () => {
  const { chmodSync } = await import('node:fs');

  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const good = createStore(join(dir, 'store.json'));
  assert.equal(good.writeError, null);

  // Root ignores the mode bits, so a read-only directory proves nothing there.
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(dir, 0o500);
    try {
      const locked = createStore(join(dir, 'locked', 'store.json'));
      assert.ok(locked.writeError, 'a store in an unwritable directory must say so');
    } finally {
      chmodSync(dir, 0o700);
    }
  }
});

test('a corrupt store is rebuilt from its backup instead of refusing to start', async () => {
  const { writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const path = join(dir, 'store.json');

  const first = createStore(path);
  first.putSubscription({ guildId: 'g', userId: 'u', tier: 1, status: 'active', expiresAt: 1 });
  // A second write is what produces the backup: the first had nothing to copy.
  first.putSubscription({ guildId: 'g', userId: 'u2', tier: 2, status: 'active', expiresAt: 1 });
  assert.ok(existsSync(`${path}.bak`), 'saving twice must leave a backup');

  writeFileSync(path, '{ this is not json');

  const rebuilt = createStore(path);
  assert.equal(rebuilt.recoveredFrom, `${path}.bak`);
  assert.ok(rebuilt.getSubscription('g', 'u'), 'the earlier membership must come back');
});

test('a store that vanished comes back from its backup', async () => {
  const { unlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const path = join(dir, 'store.json');

  const first = createStore(path);
  first.putSubscription({ guildId: 'g', userId: 'u', tier: 1, status: 'active', expiresAt: 1 });
  first.putSubscription({ guildId: 'g', userId: 'u2', tier: 1, status: 'active', expiresAt: 1 });
  unlinkSync(path);

  const rebuilt = createStore(path);
  assert.equal(rebuilt.recoveredFrom, `${path}.bak`);
  assert.ok(rebuilt.getSubscription('g', 'u'));
});

test('a corrupt store with no backup still refuses rather than starting empty', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const path = join(dir, 'store.json');
  writeFileSync(path, '{ broken');

  assert.throws(() => createStore(path), /Could not read the store/);
});

test('a healthy store is never reported as recovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const path = join(dir, 'store.json');

  const first = createStore(path);
  first.putSubscription({ guildId: 'g', userId: 'u', tier: 1, status: 'active', expiresAt: 1 });

  assert.equal(createStore(path).recoveredFrom, null);
});
