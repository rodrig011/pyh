import { generateCode } from '../lib/codes.js';
import { resolveGrantedTier } from '../lib/tiers.js';

export const ORDER_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

/**
 * Creates a pending order with a unique random code.
 */
export function createOrder(store, { userId, userTag, guildId, tier, config, now = Date.now() }) {
  const tierConfig = config.tiers[tier];
  if (!tierConfig) throw new Error(`Invalid tier: ${tier}`);

  const code = generateCode({
    prefix: config.codePrefix,
    length: config.codeLength,
    isTaken: (candidate) => store.getOrder(candidate) !== null,
  });

  const order = {
    code,
    userId,
    userTag: userTag ?? null,
    guildId,
    tier,
    amountCents: tierConfig.priceCents,
    status: ORDER_STATUS.PENDING,
    createdAt: now,
    expiresAt: now + config.orderTtlHours * 3600 * 1000,
    paidAt: null,
    grantedTier: null,
    grantedRoleIds: [],
    payment: null,
  };

  return store.putOrder(order);
}

/** Marks overdue pending orders as expired. Returns the ones it touched. */
export function expireStaleOrders(store, now = Date.now()) {
  const expired = store.listOrders(
    (order) => order.status === ORDER_STATUS.PENDING && order.expiresAt <= now,
  );
  for (const order of expired) {
    order.status = ORDER_STATUS.EXPIRED;
    store.putOrder(order);
  }
  return expired;
}

/**
 * Last resort when the alert carries no code.
 *
 * Banks are inconsistent about the memo: Huntington's Zelle alert, for one,
 * says who paid and how much and never repeats the note the payer typed. Left
 * at that, every payment would need a human, which defeats the point.
 *
 * So the amount identifies the order instead — but only when it is not a guess:
 * exactly one pending order, created recently, for that exact amount. Two
 * candidates go to the mods. None at all means the money is not ours: the same
 * inbox sees the owner's personal transfers, and those must never buy anyone a
 * membership.
 */
function matchByAmount(store, payment, config, now) {
  const noCode = { status: 'no_code', reason: 'The payment carries no recognizable code' };
  if (!config.matchByAmount) return noCode;
  if (payment.amountCents === null || payment.amountCents === undefined) return noCode;

  const windowMs = Math.max(0, config.amountMatchWindowMinutes ?? 180) * 60 * 1000;
  const candidates = store.listOrders(
    (order) =>
      order.status === ORDER_STATUS.PENDING &&
      order.expiresAt > now &&
      order.createdAt >= now - windowMs &&
      order.amountCents === payment.amountCents,
  );

  if (candidates.length === 0) return noCode;
  if (candidates.length > 1) {
    return {
      status: 'ambiguous_amount',
      candidates,
      reason: `${candidates.length} pending orders are waiting for this exact amount, so the payer cannot be told apart`,
    };
  }

  const order = candidates[0];
  return { status: 'match', order, tier: order.tier, matchedBy: 'amount' };
}

/**
 * Tries to match a detected payment against a pending order.
 * It never touches roles: it only decides. The result is explicit so both
 * successes and rejections can be logged.
 *
 * @param {object} store
 * @param {{codes: string[], amountCents: number|null, senderName?: string, source?: string, reference?: string, receivedAt?: number}} payment
 * @param {object} config
 */
export function matchPayment(store, payment, config, now = Date.now()) {
  const codes = payment.codes ?? [];
  if (codes.length === 0) return matchByAmount(store, payment, config, now);

  const orders = codes.map((code) => store.getOrder(code)).filter(Boolean);
  if (orders.length === 0) {
    // The text looked like a code but belongs to no order: either the payer
    // mistyped it, or the scanner caught a phrase shaped like one ("VIP 2
    // payment" reads as VIP-2PAYME). Neither is a reason to give up while the
    // amount can still identify the buyer on its own.
    const byAmount = matchByAmount(store, payment, config, now);
    if (byAmount.status === 'match' || byAmount.status === 'ambiguous_amount') return byAmount;
    return { status: 'unknown_code', reason: `No order matches code(s): ${codes.join(', ')}` };
  }

  const alreadyPaid = orders.find((order) => order.status === ORDER_STATUS.PAID);
  if (alreadyPaid && orders.every((order) => order.status !== ORDER_STATUS.PENDING)) {
    return { status: 'already_paid', order: alreadyPaid, reason: 'The order was already paid' };
  }

  const order = orders.find((candidate) => candidate.status === ORDER_STATUS.PENDING);
  if (!order) {
    const other = orders[0];
    return { status: 'not_pending', order: other, reason: `The order is "${other.status}"` };
  }

  if (order.expiresAt <= now) {
    order.status = ORDER_STATUS.EXPIRED;
    store.putOrder(order);
    return { status: 'expired', order, reason: 'The order expired before the payment arrived' };
  }

  if (payment.amountCents === null || payment.amountCents === undefined) {
    return { status: 'no_amount', order, reason: 'Could not read the payment amount' };
  }

  const resolved = resolveGrantedTier(order, payment.amountCents, {
    tiers: config.tiers,
    toleranceCents: config.amountToleranceCents,
    upgradeOnOverpay: config.upgradeOnOverpay,
  });

  if (!resolved.ok) return { status: 'amount_mismatch', order, reason: resolved.reason };

  return { status: 'match', order, tier: resolved.tier, matchedBy: 'code' };
}

/** Marks the order as paid and stores the payment trail. */
export function markOrderPaid(store, order, { tier, payment, grantedRoleIds = [], now = Date.now() }) {
  order.status = ORDER_STATUS.PAID;
  order.paidAt = now;
  order.grantedTier = tier;
  order.grantedRoleIds = grantedRoleIds;
  order.payment = {
    source: payment.source ?? 'manual',
    senderName: payment.senderName ?? null,
    amountCents: payment.amountCents ?? null,
    reference: payment.reference ?? null,
    receivedAt: payment.receivedAt ?? now,
  };
  store.putOrder(order);
  store.recordPayment({
    code: order.code,
    userId: order.userId,
    tier,
    amountCents: payment.amountCents ?? null,
    source: order.payment.source,
    senderName: order.payment.senderName,
    reference: order.payment.reference,
    at: now,
  });
  return order;
}
