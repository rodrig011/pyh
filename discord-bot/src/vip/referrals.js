import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { sendDm, sendLog } from './notify.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;

// A Discord account made specifically to farm this program is, almost
// always, a BRAND NEW account -- nobody keeps a years-old alt on standby.
// Below this age, the claim still gets recorded but needs a mod's eyes
// before it can ever turn into money.
export const NEW_ACCOUNT_DAYS = 14;

// A genuine referral is claimed right around when the person actually joins
// -- that is the whole shape of "I brought someone in". A claim filed long
// after joining is either someone who forgot, or two people agreeing after
// the fact to split a reward neither of them earned honestly. Flagged
// either way, since a bot cannot tell those apart -- a mod can ask.
export const CLAIM_WINDOW_DAYS = 3;

/**
 * A referred member naming who sent them, before that first payment lands.
 *
 * Two cheap, well-established anti-farming signals: how old the referred
 * account is, and how long ago they actually joined this server. Neither
 * refuses the claim outright -- a bot guessing wrong here blocks a real
 * referral for no reason -- they flag it for a human to glance at instead.
 */
export function buildReferralClaim({
  referredId,
  referrerId,
  guildId,
  now = Date.now(),
  referredAccountCreatedAt = null,
  referredJoinedAt = null,
}) {
  if (!referredId || !referrerId || !guildId) {
    throw new Error('A referral needs who was referred, who referred them, and which server');
  }
  if (referredId === referrerId) {
    throw new Error('You cannot refer yourself');
  }

  const flagReasons = [];
  if (Number.isFinite(referredAccountCreatedAt) && now - referredAccountCreatedAt < NEW_ACCOUNT_DAYS * DAY_MS) {
    flagReasons.push('new_account');
  }
  if (Number.isFinite(referredJoinedAt) && now - referredJoinedAt > CLAIM_WINDOW_DAYS * DAY_MS) {
    flagReasons.push('stale_claim');
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
    // A flagged claim can still be recorded and later approved, but it can
    // never credit a reward while flagged=true -- see paymentFlow.js.
    flagReasons,
    flagged: flagReasons.length > 0,
    // A mod's decision on a flagged claim. null while unreviewed.
    reviewedAt: null,
    rejected: false,
  };
}

/**
 * The referred member's first payment just cleared -- the claim is now owed.
 * Refuses a flagged or rejected claim outright: crediting it is exactly the
 * one thing the flag exists to hold back until a mod has looked at it.
 */
export function creditReferral(claim, { now = Date.now() } = {}) {
  if (claim.creditedAt || claim.flagged || claim.rejected) return claim;
  return { ...claim, creditedAt: now };
}

/** A mod looked at a flagged claim and it is fine -- clears the hold. */
export function approveReferralClaim(claim, { now = Date.now() } = {}) {
  return { ...claim, flagged: false, reviewedAt: now };
}

/** A mod looked at a flagged claim and it is not fine -- locked out for good. */
export function rejectReferralClaim(claim, { now = Date.now() } = {}) {
  return { ...claim, rejected: true, reviewedAt: now };
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

/**
 * Credits a claim and tells both sides, if it is actually creditable.
 * Shared between the normal path (paymentFlow.js, the moment a first
 * payment clears) and a mod approving a claim whose referred member had
 * ALREADY paid while it sat flagged. creditReferral() is the single source
 * of truth for whether crediting is allowed at all (never flagged, never
 * rejected, never twice) — this only adds the Discord side effects once it
 * actually happens.
 */
export async function creditAndNotifyReferral(client, store, config, claim) {
  const credited = creditReferral(claim);
  if (!credited.creditedAt || credited.creditedAt === claim.creditedAt) return credited;

  store.putReferralClaim(credited);

  await sendDm(
    client,
    credited.referrerId,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🤝 Referral paid off!')
      .setDescription(
        `<@${credited.referredId}> just made their first payment — you earned **$${credited.rewardDollars}**.\n` +
          'Check `/referral balance` any time. A mod pays you out by hand and runs `/referral markpaid`.',
      )
      .setTimestamp(),
  );

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🤝 Referral converted')
      .setDescription(
        `<@${credited.referrerId}> referred <@${credited.referredId}>, who just paid. **$${credited.rewardDollars}** owed — see \`/referral payouts\`.`,
      )
      .setTimestamp(),
    { ping: true },
  );

  return credited;
}
