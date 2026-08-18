import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERRAL_REWARD_DOLLARS,
  buildReferralClaim,
  creditReferral,
  markReferralPaid,
  outstandingPayouts,
  referralBalance,
} from '../src/vip/referrals.js';

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
