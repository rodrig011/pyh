import { generateCode } from '../lib/codes.js';
import { nameMatches } from '../lib/names.js';
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
export function createOrder(store, { userId, userTag, guildId, tier, payerName, config, now = Date.now() }) {
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
    // The name the payment will arrive under. Banks that drop the memo still
    // name the payer, so this is what turns an anonymous alert back into a buyer.
    payerName: payerName ?? null,
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

  const waiting = store.listOrders(
    (order) =>
      order.status === ORDER_STATUS.PENDING &&
      order.expiresAt > now &&
      order.amountCents === payment.amountCents,
  );
  if (waiting.length === 0) return noCode;

  // The name on the alert is the strongest thing left once the memo is gone,
  // and unlike the amount it stays meaningful however long the buyer takes —
  // so a name match is trusted for the order's whole life, no time window.
  if (payment.senderName) {
    const named = waiting.filter(
      (order) => order.payerName && nameMatches(order.payerName, payment.senderName),
    );
    if (named.length === 1) {
      const order = named[0];
      return { status: 'match', order, tier: order.tier, matchedBy: 'name' };
    }
    if (named.length > 1) {
      return {
        status: 'ambiguous_amount',
        candidates: named,
        reason: `${named.length} buyers gave this name and this amount, so the payer cannot be told apart`,
      };
    }
  }

  // Nobody claimed that name. The amount alone can still identify a buyer, but
  // only while it is fresh: over days it stops being evidence of anything.
  const windowMs = Math.max(0, config.amountMatchWindowMinutes ?? 180) * 60 * 1000;
  const recent = waiting.filter(
    (order) =>
      order.createdAt >= now - windowMs &&
      // A buyer who named themselves and is not who paid is ruled out, not
      // merely unproven: falling back to the amount here would hand one
      // person's payment to another whose name the alert contradicts.
      !(payment.senderName && order.payerName),
  );

  if (recent.length === 0) return noCode;
  if (recent.length > 1) {
    return {
      status: 'ambiguous_amount',
      candidates: recent,
      reason: `${recent.length} pending orders are waiting for this exact amount, so the payer cannot be told apart`,
    };
  }

  const order = recent[0];
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
