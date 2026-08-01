export const TIER_NAMES = {
  1: 'VIP Tier 1',
  2: 'VIP Tier 2',
  3: 'VIP Tier 3',
};

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Tiers acumulativos: el tier 3 otorga tambien el 2 y el 1, el tier 2 otorga el 1.
 * @param {number} tier
 * @returns {number[]} lista ascendente de tiers incluidos
 */
export function includedTiers(tier) {
  const result = [];
  for (let i = 1; i <= tier; i += 1) result.push(i);
  return result;
}

/**
 * IDs de rol que corresponden a un tier, incluyendo los tiers inferiores.
 * @param {number} tier
 * @param {Record<number, {roleId?: string}>} tiersConfig
 */
export function roleIdsForTier(tier, tiersConfig) {
  return includedTiers(tier)
    .map((level) => tiersConfig[level]?.roleId)
    .filter(Boolean);
}

/**
 * Tier mas alto cuyo precio queda cubierto por el monto pagado.
 * @returns {number|null}
 */
export function highestTierCoveredBy(amountCents, tiersConfig, toleranceCents = 0) {
  let best = null;
  for (const tier of Object.keys(tiersConfig).map(Number).sort((a, b) => a - b)) {
    if (amountCents + toleranceCents >= tiersConfig[tier].priceCents) best = tier;
  }
  return best;
}

/**
 * Decide si un pago cubre una orden y que tier hay que otorgar.
 * @param {{tier: number}} order
 * @param {number} amountCents monto detectado en el correo de Zelle
 * @param {object} options
 * @returns {{ok: boolean, tier?: number, reason?: string}}
 */
export function resolveGrantedTier(order, amountCents, { tiers, toleranceCents = 0, upgradeOnOverpay = true }) {
  const ordered = tiers[order.tier];
  if (!ordered) return { ok: false, reason: `Tier desconocido: ${order.tier}` };
  if (amountCents + toleranceCents < ordered.priceCents) {
    return {
      ok: false,
      reason: `Monto insuficiente: se recibieron ${formatMoney(amountCents)} y el ${TIER_NAMES[order.tier]} cuesta ${formatMoney(ordered.priceCents)}`,
    };
  }
  if (!upgradeOnOverpay) return { ok: true, tier: order.tier };
  const covered = highestTierCoveredBy(amountCents, tiers, toleranceCents);
  return { ok: true, tier: Math.max(order.tier, covered ?? order.tier) };
}
