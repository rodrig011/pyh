import { SUBSCRIPTION_STATUS, computeExpiry } from '../lib/subscriptions.js';

/**
 * Creates or renews a membership after a confirmed payment.
 *
 * Renewing while still active stacks the days on top of what is left, and a
 * higher tier upgrades the membership without shortening it. Buying a lower
 * tier than the one already held only adds time — it never demotes anyone.
 */
export function upsertSubscription(store, { guildId, userId, tier, code, days, now = Date.now() }) {
  const existing = store.getSubscription(guildId, userId);
  const wasActive = existing?.status === SUBSCRIPTION_STATUS.ACTIVE && existing.expiresAt > now;

  const subscription = {
    guildId,
    userId,
    tier: wasActive ? Math.max(existing.tier, tier) : tier,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    startedAt: wasActive ? existing.startedAt : now,
    renewedAt: now,
    expiresAt: computeExpiry({ currentExpiresAt: wasActive ? existing.expiresAt : null, now, days }),
    lastOrderCode: code ?? existing?.lastOrderCode ?? null,
    renewals: wasActive ? (existing.renewals ?? 0) + 1 : 0,
    // A fresh period means the reminders for it have not been sent yet.
    remindersSent: [],
    endedAt: null,
    endedReason: null,
  };

  return store.putSubscription(subscription);
}

/** Closes a membership (expired or revoked by a mod). */
export function endSubscription(store, subscription, { status, reason = null, now = Date.now() }) {
  subscription.status = status;
  subscription.endedAt = now;
  subscription.endedReason = reason;
  return store.putSubscription(subscription);
}

export function markReminded(store, subscription, thresholds) {
  const sent = new Set(subscription.remindersSent ?? []);
  for (const threshold of thresholds) sent.add(threshold);
  subscription.remindersSent = [...sent].sort((a, b) => b - a);
  return store.putSubscription(subscription);
}

export function activeSubscriptions(store, now = Date.now()) {
  return store.listSubscriptions(
    (subscription) => subscription.status === SUBSCRIPTION_STATUS.ACTIVE && subscription.expiresAt > now,
  );
}
