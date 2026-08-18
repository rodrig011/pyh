/**
 * Referrals: bring a paying member, earn $10 once they actually pay.
 *
 * Deliberately tied to a CONFIRMED first payment, not to joining the server.
 * A reward for showing up costs nothing to fake with alt accounts and would
 * drain the program in a day; a reward for a real, first-time payment only
 * ever pays out because real money already came in to fund it. See
 * paymentFlow.js, which credits a claim the moment a non-renewal payment
 * clears — never before.
 */

export const REFERRAL_REWARD_DOLLARS = 10;

/** A referred member naming who sent them, before that first payment lands. */
export function buildReferralClaim({ referredId, referrerId, guildId, now = Date.now() }) {
  if (!referredId || !referrerId || !guildId) {
    throw new Error('A referral needs who was referred, who referred them, and which server');
  }
  if (referredId === referrerId) {
    throw new Error('You cannot refer yourself');
  }

  return {
    referredId,
    referrerId,
    guildId,
    claimedAt: now,
    // Set once the referred member's first payment actually clears -- not at
    // claim time, when there is nothing behind it yet but a name someone typed.
    creditedAt: null,
    rewardDollars: REFERRAL_REWARD_DOLLARS,
    // Set by a mod once they have actually sent the money by hand -- the same
    // manually-verified spirit as the rest of this bot's payment handling.
    paidAt: null,
  };
}

/** The referred member's first payment just cleared -- the claim is now owed. */
export function creditReferral(claim, { now = Date.now() } = {}) {
  if (claim.creditedAt) return claim;
  return { ...claim, creditedAt: now };
}

/** A mod has paid the referrer by hand. */
export function markReferralPaid(claim, { now = Date.now() } = {}) {
  return { ...claim, paidAt: now };
}

/** One referrer's running balance: how many converted, earned, paid, owed. */
export function referralBalance(claims, referrerId) {
  const mine = (claims ?? []).filter((claim) => claim.referrerId === referrerId);
  const earned = mine.filter((claim) => claim.creditedAt);
  const paid = earned.filter((claim) => claim.paidAt);
  const owed = earned.filter((claim) => !claim.paidAt);

  return {
    referred: mine.length,
    converted: earned.length,
    pending: mine.length - earned.length,
    earnedDollars: earned.reduce((sum, claim) => sum + claim.rewardDollars, 0),
    paidDollars: paid.reduce((sum, claim) => sum + claim.rewardDollars, 0),
    owedDollars: owed.reduce((sum, claim) => sum + claim.rewardDollars, 0),
  };
}

/** Every referrer still owed something, most owed first -- a mod's payout list. */
export function outstandingPayouts(claims) {
  const referrerIds = [
    ...new Set((claims ?? []).filter((claim) => claim.creditedAt && !claim.paidAt).map((claim) => claim.referrerId)),
  ];

  return referrerIds
    .map((referrerId) => ({ referrerId, ...referralBalance(claims, referrerId) }))
    .filter((row) => row.owedDollars > 0)
    .sort((a, b) => b.owedDollars - a.owedDollars);
}
