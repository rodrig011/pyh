export const TIER_NAMES = {
  1: 'VIP Tier 1',
  2: 'VIP Tier 2',
  3: 'VIP Tier 3',
};

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "VIP Tier 2 · VIP" — the tier plus whatever the server calls it. */
export function tierTitle(tier, tiersConfig) {
  const label = tiersConfig?.[tier]?.label;
  return label ? `${TIER_NAMES[tier]} · ${label}` : TIER_NAMES[tier];
}

/** The selling points of a tier, as a block of text. */
export function tierPerks(tier, tiersConfig) {
  const perks = tiersConfig?.[tier]?.perks ?? [];
  return perks.join('\n');
}

/**
 * Tiers stack: tier 3 also grants 2 and 1, tier 2 also grants 1.
 * @param {number} tier
 * @returns {number[]} ascending list of included tiers
 */
export function includedTiers(tier) {
  const result = [];
  for (let i = 1; i <= tier; i += 1) result.push(i);
  return result;
}

/**
 * Role IDs that belong to a tier, including every lower tier.
 * @param {number} tier
 * @param {Record<number, {roleId?: string}>} tiersConfig
 */
export function roleIdsForTier(tier, tiersConfig) {
  return includedTiers(tier)
    .map((level) => tiersConfig[level]?.roleId)
    .filter(Boolean);
}

/**
 * Tiers that are actually sellable: the ones whose role exists in the config.
 * A tier with no ROLE_TIER_n is treated as "coming soon" — it is never offered
 * for sale, so nobody can pay for a role the bot cannot hand out.
 * @returns {number[]} ascending
 */
export function availableTiers(tiersConfig) {
  return Object.keys(tiersConfig)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((tier) => Boolean(tiersConfig[tier].roleId));
}

/**
 * Highest tier whose price is covered by the amount paid.
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
 * Decides whether a payment covers an order and which tier to grant.
 * @param {{tier: number}} order
 * @param {number} amountCents amount detected in the Zelle email
 * @param {object} options
 * @returns {{ok: boolean, tier?: number, reason?: string}}
 */
export function resolveGrantedTier(order, amountCents, { tiers, toleranceCents = 0, upgradeOnOverpay = true }) {
  const ordered = tiers[order.tier];
  if (!ordered) return { ok: false, reason: `Unknown tier: ${order.tier}` };
  if (amountCents + toleranceCents < ordered.priceCents) {
    return {
      ok: false,
      reason: `Amount too low: received ${formatMoney(amountCents)} but ${TIER_NAMES[order.tier]} costs ${formatMoney(ordered.priceCents)}`,
    };
  }
  if (!upgradeOnOverpay) return { ok: true, tier: order.tier };
  const covered = highestTierCoveredBy(amountCents, tiers, toleranceCents);
  // Never upgrade into a tier that has no role configured yet.
  const ceiling = availableTiers(tiers).at(-1) ?? order.tier;
  return { ok: true, tier: Math.min(Math.max(order.tier, covered ?? order.tier), ceiling) };
}
