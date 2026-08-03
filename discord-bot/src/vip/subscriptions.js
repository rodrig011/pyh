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

/**
 * Works out who should be adopted into the membership system.
 *
 * Members given a VIP role by hand — a migration from the old setup, say — hold
 * the role but have no membership record, so nothing ever expires for them.
 * This picks them out while leaving alone anyone already tracked, the staff who
 * hold the role for moderation, and bots.
 *
 * Pure so the selection can be tested without a guild.
 *
 * @param {Array<{id: string, isBot?: boolean, roleIds: string[]}>} members
 * @param {{roleId: string, modRoleIds?: string[], hasActiveSubscription: (id: string) => boolean}} options
 * @returns {{adopt: string[], skipped: {tracked: string[], staff: string[], bots: string[]}}}
 */
export function planAdoption(members, { roleId, modRoleIds = [], hasActiveSubscription }) {
  const result = { adopt: [], skipped: { tracked: [], staff: [], bots: [] } };

  for (const member of members) {
    if (!member.roleIds.includes(roleId)) continue;
    if (member.isBot) {
      result.skipped.bots.push(member.id);
      continue;
    }
    if (modRoleIds.some((modRole) => member.roleIds.includes(modRole))) {
      result.skipped.staff.push(member.id);
      continue;
    }
    if (hasActiveSubscription(member.id)) {
      result.skipped.tracked.push(member.id);
      continue;
    }
    result.adopt.push(member.id);
  }

  return result;
}

/**
 * The tier a member's roles already entitle them to — the highest one held.
 *
 * Tiers stack, so somebody with tier 3 also carries 1 and 2; taking the highest
 * is the only reading that does not quietly demote them.
 */
export function tierFromRoles(roleIds, tiersConfig) {
  let best = null;
  for (const tier of Object.keys(tiersConfig).map(Number).sort((a, b) => a - b)) {
    if (tiersConfig[tier]?.roleId && roleIds.includes(tiersConfig[tier].roleId)) best = tier;
  }
  return best;
}

/**
 * Adopting one named member, rather than sweeping a whole role.
 *
 * Staff are not skipped here, unlike the bulk sweep: skipping them in bulk
 * stops a mod's own role being mistaken for a paid membership, but naming
 * somebody is a deliberate act and second-guessing it would just be confusing.
 *
 * @returns {{ok: boolean, tier?: number, reason?: string}}
 */
export function planIndividualAdoption(member, { tiersConfig, tier = null, hasActiveSubscription }) {
  if (member.isBot) return { ok: false, reason: 'bot' };

  const resolved = tier ?? tierFromRoles(member.roleIds ?? [], tiersConfig);
  if (!resolved) return { ok: false, reason: 'no_tier' };
  if (!tiersConfig[resolved]) return { ok: false, reason: 'unknown_tier' };
  if (hasActiveSubscription(member.id)) return { ok: false, reason: 'already_tracked', tier: resolved };

  return { ok: true, tier: resolved };
}

export function activeSubscriptions(store, now = Date.now()) {
  return store.listSubscriptions(
    (subscription) => subscription.status === SUBSCRIPTION_STATUS.ACTIVE && subscription.expiresAt > now,
  );
}
