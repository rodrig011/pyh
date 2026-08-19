export const DAY_MS = 86400000;

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
};

/**
 * When a membership should end after a payment.
 * Renewing while still active adds the days on top of the remaining time, so
 * nobody loses what they already paid for by renewing early.
 */
export function computeExpiry({ currentExpiresAt = null, now = Date.now(), days = 30 }) {
  const base = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
  return base + days * DAY_MS;
}

/** Whole days left, rounded up: 0.2 days left still reads as "1 day". */
export function daysLeft(subscription, now = Date.now()) {
  return Math.ceil((subscription.expiresAt - now) / DAY_MS);
}

export function isExpired(subscription, now = Date.now(), graceDays = 0) {
  return now >= subscription.expiresAt + graceDays * DAY_MS;
}

/**
 * Which reminder to send, if any.
 *
 * Thresholds are "days before expiry". If several are already due (the bot was
 * offline, say), only the most urgent one is sent, and the rest are marked as
 * covered so the user never gets a burst of DMs.
 *
 * @returns {{send: number, cover: number[]}|null}
 */
export function dueReminder(subscription, now = Date.now(), thresholds = [3, 1]) {
  if (subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) return null;
  if (isExpired(subscription, now)) return null;

  const left = daysLeft(subscription, now);
  const sent = new Set(subscription.remindersSent ?? []);
  const matched = thresholds.filter((threshold) => left <= threshold);
  if (matched.length === 0) return null;

  const unsent = matched.filter((threshold) => !sent.has(threshold));
  if (unsent.length === 0) return null;

  return { send: Math.min(...unsent), cover: matched };
}

export function subscriptionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}
