import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_WINDOW_DAYS,
  NEW_ACCOUNT_DAYS,
  REFERRAL_REWARD_DOLLARS,
  approveReferralClaim,
  buildReferralClaim,
  creditReferral,
  markReferralPaid,
  outstandingPayouts,
  referralBalance,
  rejectReferralClaim,
} from '../src/vip/referrals.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('a claim starts uncredited and unpaid', () => {
  const claim = buildReferralClaim({ referredId: 'new1', referrerId: 'ref1', guildId: 'g' });
  assert.equal(claim.creditedAt, null);
  assert.equal(claim.paidAt, null);
  assert.equal(claim.rewardDollars, REFERRAL_REWARD_DOLLARS);
});

test('nobody can refer themselves', () => {
  assert.throws(() => buildReferralClaim({ referredId: 'u1', referrerId: 'u1', guildId: 'g' }), /cannot refer yourself/i);
});

test('crediting a claim twice does not double the reward', () => {
  const claim = buildReferralClaim({ referredId: 'new1', referrerId: 'ref1', guildId: 'g' });
  const once = creditReferral(claim, { now: 100 });
  const twice = creditReferral(once, { now: 200 });
  assert.equal(twice.creditedAt, 100, 'the second credit attempt changes nothing');
});

test('referralBalance counts referred, converted, and owed correctly', () => {
  const claims = [
    buildReferralClaim({ referredId: 'a', referrerId: 'ref', guildId: 'g' }), // still pending
    creditReferral(buildReferralClaim({ referredId: 'b', referrerId: 'ref', guildId: 'g' })), // owed
    markReferralPaid(creditReferral(buildReferralClaim({ referredId: 'c', referrerId: 'ref', guildId: 'g' }))), // paid
    creditReferral(buildReferralClaim({ referredId: 'd', referrerId: 'somebody-else', guildId: 'g' })), // not mine
  ];

  const balance = referralBalance(claims, 'ref');
  assert.equal(balance.referred, 3);
  assert.equal(balance.converted, 2);
  assert.equal(balance.pending, 1);
  assert.equal(balance.earnedDollars, 20);
  assert.equal(balance.paidDollars, 10);
  assert.equal(balance.owedDollars, 10);
});

test('outstandingPayouts lists only referrers who are actually owed something, most owed first', () => {
  const claims = [
    creditReferral(buildReferralClaim({ referredId: 'a', referrerId: 'big', guildId: 'g' })),
    creditReferral(buildReferralClaim({ referredId: 'b', referrerId: 'big', guildId: 'g' })),
    creditReferral(buildReferralClaim({ referredId: 'c', referrerId: 'small', guildId: 'g' })),
    markReferralPaid(creditReferral(buildReferralClaim({ referredId: 'd', referrerId: 'paid-up', guildId: 'g' }))),
    buildReferralClaim({ referredId: 'e', referrerId: 'never-converted', guildId: 'g' }),
  ];

  const rows = outstandingPayouts(claims);
  assert.deepEqual(rows.map((r) => r.referrerId), ['big', 'small']);
  assert.equal(rows[0].owedDollars, 20);
  assert.equal(rows[1].owedDollars, 10);
});

// Fraud resistance: a bot cannot tell a real referral from two people
// agreeing to fake one, but it CAN flag the two shapes that pattern almost
// always takes -- a throwaway account, or a claim filed well after the fact.

test('a brand new Discord account flags the claim as needing review', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredAccountCreatedAt: now - 2 * DAY_MS,
  });

  assert.equal(claim.flagged, true);
  assert.deepEqual(claim.flagReasons, ['new_account']);
});

test('an account older than the threshold is not flagged for age', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredAccountCreatedAt: now - (NEW_ACCOUNT_DAYS + 1) * DAY_MS,
  });

  assert.equal(claim.flagged, false);
});

test('claiming long after actually joining the server flags the claim', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredJoinedAt: now - (CLAIM_WINDOW_DAYS + 1) * DAY_MS,
  });

  assert.equal(claim.flagged, true);
  assert.deepEqual(claim.flagReasons, ['stale_claim']);
});

test('claiming right after joining is not flagged', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredJoinedAt: now - 1000,
  });

  assert.equal(claim.flagged, false);
});

test('a flagged claim cannot be credited, even once the payment clears', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredAccountCreatedAt: now,
  });

  const attempt = creditReferral(claim);
  assert.equal(attempt.creditedAt, null, 'the flag holds the credit back');
});

test('approving a flagged claim clears the flag and allows crediting', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredAccountCreatedAt: now,
  });

  const approved = approveReferralClaim(claim);
  assert.equal(approved.flagged, false);
  assert.ok(approved.reviewedAt);

  const credited = creditReferral(approved);
  assert.ok(credited.creditedAt, 'now creditable');
});

test('rejecting a flagged claim locks it out for good, even if later "approved"', () => {
  const now = Date.now();
  const claim = buildReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    now,
    referredAccountCreatedAt: now,
  });

  const rejected = rejectReferralClaim(claim);
  assert.equal(rejected.rejected, true);

  const attempt = creditReferral(rejected);
  assert.equal(attempt.creditedAt, null);
});
