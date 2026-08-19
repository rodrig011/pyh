import { SUBSCRIPTION_STATUS } from '../lib/subscriptions.js';

/**
 * Moving the whole operation to a different Discord server.
 *
 * The hazard, and it is not obvious: every membership is stored under a key of
 * `guildId:userId`. Change `VIP_GUILD_ID` and point the bot at a new server and
 * the records do not move with it — they sit in the file, perfectly intact,
 * attached to a server nobody is in. Every paying member silently loses the
 * access they paid for, and nothing logs an error, because from the bot's point
 * of view the new server simply has no members yet.
 *
 * That would be discovered by the members, one at a time, as their roles fail
 * to appear. Which is the worst possible way to discover it, and the reason
 * this file exists rather than a line in a checklist.
 *
 * Everything here is pure and previewable. A migration that cannot be inspected
 * before it runs is a migration nobody should run.
 */

/**
 * What moving to `toGuildId` would do, without doing it.
 *
 * Reports every membership by name so the list can be read before anything is
 * written — and separates the ones already at the destination, because running
 * a migration twice must not be able to hurt.
 */
export function planMigration(subscriptions, { fromGuildId, toGuildId, now = Date.now() } = {}) {
  if (!fromGuildId || !toGuildId) {
    return { ok: false, reason: 'both the old and the new server id are needed', moving: [] };
  }
  if (fromGuildId === toGuildId) {
    return { ok: false, reason: 'those are the same server', moving: [] };
  }

  const all = subscriptions ?? [];
  const source = all.filter((subscription) => subscription?.guildId === fromGuildId);
  const already = all.filter((subscription) => subscription?.guildId === toGuildId);

  // Only what is still worth moving. A membership that expired months ago is
  // history, not access, and carrying it over just makes the list unreadable.
  const live = source.filter(
    (subscription) =>
      subscription.status === SUBSCRIPTION_STATUS.ACTIVE && subscription.expiresAt > now,
  );

  // Somebody who exists on both sides. Moving would overwrite the destination
  // record, so the one with more time left wins and it is said out loud.
  const collisions = live.filter((subscription) =>
    already.some((other) => other.userId === subscription.userId),
  );

  return {
    ok: true,
    reason: null,
    fromGuildId,
    toGuildId,
    moving: live,
    // Expired or cancelled: left where they are on purpose.
    leaving: source.length - live.length,
    collisions,
    alreadyThere: already.length,
  };
}

/**
 * The moved records. Does not touch the store — the caller writes them, so the
 * decision to write is separate from the arithmetic of what to write.
 *
 * On a collision the record with more time left survives, because the member
 * paid for that time and the alternative silently shortens it.
 */
export function migratedSubscriptions(subscriptions, { fromGuildId, toGuildId, now = Date.now() } = {}) {
  const plan = planMigration(subscriptions, { fromGuildId, toGuildId, now });
  if (!plan.ok) return { ok: false, reason: plan.reason, subscriptions: [] };

  const destination = new Map(
    (subscriptions ?? [])
      .filter((subscription) => subscription?.guildId === toGuildId)
      .map((subscription) => [subscription.userId, subscription]),
  );

  for (const subscription of plan.moving) {
    const existing = destination.get(subscription.userId);
    const moved = { ...subscription, guildId: toGuildId, migratedFrom: fromGuildId, migratedAt: now };
    if (!existing || (subscription.expiresAt ?? 0) > (existing.expiresAt ?? 0)) {
      destination.set(subscription.userId, moved);
    }
  }

  return { ok: true, reason: null, subscriptions: [...destination.values()], plan };
}

/**
 * Everyone who should hear an announcement, by tier.
 *
 * Active memberships only: telling somebody whose access lapsed three months
 * ago that the server is moving is a message to a stranger.
 */
export function broadcastAudience(subscriptions, { guildId, tiers = null, now = Date.now() } = {}) {
  const wanted = tiers === null ? null : new Set(tiers.map(Number));

  return (subscriptions ?? [])
    .filter((subscription) => subscription?.guildId === guildId)
    .filter(
      (subscription) =>
        subscription.status === SUBSCRIPTION_STATUS.ACTIVE && subscription.expiresAt > now,
    )
    .filter((subscription) => wanted === null || wanted.has(Number(subscription.tier)))
    // One message per person, however many records they have.
    .filter(
      (subscription, index, list) =>
        list.findIndex((other) => other.userId === subscription.userId) === index,
    );
}

/**
 * Everyone who actually holds a VIP role, whatever the payment records say.
 *
 * The broadcast reached ELEVEN people out of a room of hundreds, and the reason
 * is that it read the subscription store — which only knows about people who
 * paid THROUGH THIS BOT. Everybody who was given a role by hand, or who paid
 * before the bot existed, or who paid the owner directly, has the role and no
 * record. From the store's point of view they are not members at all.
 *
 * The role is the truth of who is in the room. The store is a truth about who
 * paid, and the two have never been the same set.
 *
 * Returns Discord user IDs. Bots are dropped: messaging them is a guaranteed
 * failure and pollutes the count.
 */
export function roleAudience(members, roleIds) {
  const wanted = new Set((roleIds ?? []).filter(Boolean));
  if (wanted.size === 0) return [];

  const found = new Set();
  for (const member of members ?? []) {
    if (member?.user?.bot) continue;
    const has = member?.roles?.cache;
    if (!has) continue;
    if ([...wanted].some((roleId) => has.has(roleId))) found.add(member.id);
  }
  return [...found];
}

/**
 * Everybody to write to: role holders AND anybody with a live subscription.
 *
 * The union rather than either alone. A role holder with no payment record is
 * still in the room, and a payer whose role was removed by accident still paid.
 * Missing somebody costs more than messaging one person twice — and the dedupe
 * means nobody IS messaged twice.
 */
export function everyoneToNotify({ members, roleIds, subscriptions, guildId, now = Date.now() }) {
  const fromRoles = roleAudience(members, roleIds);
  const fromStore = broadcastAudience(subscriptions, { guildId, now }).map((s) => s.userId);
  return [...new Set([...fromRoles, ...fromStore])];
}
