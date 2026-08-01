import { SUBSCRIPTION_STATUS, DAY_MS } from '../lib/subscriptions.js';
import { ORDER_STATUS } from './orders.js';

/**
 * Everything the owner asks at a glance: how many people are in, what is coming
 * in, and who is about to fall off.
 *
 * Pure, so the numbers can be checked against fixed data instead of eyeballed
 * in Discord — these are the figures someone will make decisions on.
 *
 * @param {{subscriptions: object[], payments: object[], orders: object[]}} data
 * @param {{now?: number, guildId?: string, tiers: object, expiringWithinDays?: number}} options
 */
export function computeStats(data, { now = Date.now(), guildId, tiers, expiringWithinDays = 7 } = {}) {
  const inGuild = (item) => !guildId || item.guildId === guildId;

  const subscriptions = (data.subscriptions ?? []).filter(inGuild);
  const orders = (data.orders ?? []).filter(inGuild);
  // Payments carry no guildId of their own; they are reached through their order.
  const guildUserIds = new Set(subscriptions.map((subscription) => subscription.userId));
  const payments = (data.payments ?? []).filter(
    (payment) => !guildId || guildUserIds.has(payment.userId),
  );

  const active = subscriptions.filter(
    (subscription) => subscription.status === SUBSCRIPTION_STATUS.ACTIVE && subscription.expiresAt > now,
  );

  const byTier = {};
  let monthlyValueCents = 0;
  for (const tier of Object.keys(tiers).map(Number)) {
    const count = active.filter((subscription) => subscription.tier === tier).length;
    byTier[tier] = count;
    monthlyValueCents += count * tiers[tier].priceCents;
  }

  const expiringSoon = active
    .filter((subscription) => subscription.expiresAt <= now + expiringWithinDays * DAY_MS)
    .sort((a, b) => a.expiresAt - b.expiresAt);

  const autoRenewing = active.filter((subscription) => subscription.autoRenew).length;

  const sum = (list) => list.reduce((total, payment) => total + (payment.amountCents ?? 0), 0);
  const since = (days) => payments.filter((payment) => payment.at > now - days * DAY_MS);

  const bySource = {};
  for (const payment of since(30)) {
    const source = payment.source ?? 'unknown';
    bySource[source] = (bySource[source] ?? 0) + (payment.amountCents ?? 0);
  }

  return {
    active: { total: active.length, byTier, autoRenewing },
    expiringSoon: { days: expiringWithinDays, count: expiringSoon.length, members: expiringSoon },
    lost30d: subscriptions.filter(
      (subscription) =>
        subscription.status !== SUBSCRIPTION_STATUS.ACTIVE &&
        (subscription.endedAt ?? 0) > now - 30 * DAY_MS,
    ).length,
    revenue: {
      last30dCents: sum(since(30)),
      last7dCents: sum(since(7)),
      allTimeCents: sum(payments),
      bySource,
    },
    payments: { last30d: since(30).length, allTime: payments.length },
    // What the current members are worth per period if they all renew.
    monthlyValueCents,
    pendingOrders: orders.filter((order) => order.status === ORDER_STATUS.PENDING).length,
  };
}
