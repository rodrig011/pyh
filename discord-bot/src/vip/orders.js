import { generateCode } from '../lib/codes.js';
import { resolveGrantedTier } from '../lib/tiers.js';

export const ORDER_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

/**
 * Crea una orden pendiente con un codigo aleatorio unico.
 */
export function createOrder(store, { userId, userTag, guildId, tier, config, now = Date.now() }) {
  const tierConfig = config.tiers[tier];
  if (!tierConfig) throw new Error(`Tier invalido: ${tier}`);

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

/** Marca como expiradas las ordenes pendientes vencidas. Devuelve las afectadas. */
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
 * Intenta emparejar un pago detectado con una orden pendiente.
 * No toca roles: solo decide. Devuelve un resultado explicito para poder loguear
 * tanto los exitos como los rechazos.
 *
 * @param {object} store
 * @param {{codes: string[], amountCents: number|null, senderName?: string, source?: string, reference?: string, receivedAt?: number}} payment
 * @param {object} config
 */
export function matchPayment(store, payment, config, now = Date.now()) {
  const codes = payment.codes ?? [];
  if (codes.length === 0) {
    return { status: 'no_code', reason: 'El pago no incluye ningun codigo reconocible' };
  }

  const orders = codes.map((code) => store.getOrder(code)).filter(Boolean);
  if (orders.length === 0) {
    return { status: 'unknown_code', reason: `Codigo(s) sin orden asociada: ${codes.join(', ')}` };
  }

  const alreadyPaid = orders.find((order) => order.status === ORDER_STATUS.PAID);
  if (alreadyPaid && orders.every((order) => order.status !== ORDER_STATUS.PENDING)) {
    return { status: 'already_paid', order: alreadyPaid, reason: 'La orden ya estaba pagada' };
  }

  const order = orders.find((candidate) => candidate.status === ORDER_STATUS.PENDING);
  if (!order) {
    const other = orders[0];
    return { status: 'not_pending', order: other, reason: `La orden esta en estado "${other.status}"` };
  }

  if (order.expiresAt <= now) {
    order.status = ORDER_STATUS.EXPIRED;
    store.putOrder(order);
    return { status: 'expired', order, reason: 'La orden vencio antes de recibirse el pago' };
  }

  if (payment.amountCents === null || payment.amountCents === undefined) {
    return { status: 'no_amount', order, reason: 'No se pudo leer el monto del pago' };
  }

  const resolved = resolveGrantedTier(order, payment.amountCents, {
    tiers: config.tiers,
    toleranceCents: config.amountToleranceCents,
    upgradeOnOverpay: config.upgradeOnOverpay,
  });

  if (!resolved.ok) return { status: 'amount_mismatch', order, reason: resolved.reason };

  return { status: 'match', order, tier: resolved.tier };
}

/** Marca la orden como pagada y guarda el rastro del pago. */
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
