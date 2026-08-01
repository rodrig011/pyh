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
  if (codes.length === 0) {
    return { status: 'no_code', reason: 'The payment carries no recognizable code' };
  }

  const orders = codes.map((code) => store.getOrder(code)).filter(Boolean);
  if (orders.length === 0) {
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

  return { status: 'match', order, tier: resolved.tier };
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
