import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createStore } from '../src/lib/store.js';
import { handleReferralCommand, handleReferralReviewButton } from '../src/vip/referralCommands.js';
import { creditReferral } from '../src/vip/referrals.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const config = { guildId: 'g', modRoleIds: [], logChannelId: 'log-chan' };

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'referral-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

function fakeUser(id, { createdTimestamp = Date.now() - 365 * DAY_MS } = {}) {
  return { id, tag: `${id}#0001`, username: id, createdTimestamp };
}

function fakeClient(posts = [], dms = []) {
  return {
    channels: {
      fetch: async (id) =>
        id === 'log-chan'
          ? { isTextBased: () => true, send: async (payload) => posts.push(payload) }
          : null,
    },
    users: { fetch: async (id) => ({ send: async (payload) => dms.push({ id, payload }) }) },
  };
}

function interaction({
  sub,
  userId = 'new1',
  userOptions = {},
  referrer = null,
  member = null,
  admin = false,
  replies,
  client = fakeClient(),
  customId = null,
}) {
  return {
    guildId: 'g',
    customId,
    client,
    user: fakeUser(userId, userOptions),
    memberPermissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
    member: member ?? { roles: { cache: { has: () => false } }, joinedTimestamp: Date.now() },
    options: {
      getSubcommand: () => sub,
      getUser: (name) => (name === 'referrer' || name === 'member' ? referrer : null),
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    update: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

test('claiming a referrer records it', async (t) => {
  const store = freshStore(t);
  const replies = [];
  await handleReferralCommand(
    interaction({ sub: 'claim', userId: 'new1', referrer: fakeUser('ref1'), replies }),
    { store, config },
  );

  const claim = store.getReferralClaim('new1');
  assert.ok(claim);
  assert.equal(claim.referrerId, 'ref1');
  assert.match(String(replies.at(-1).content), /ref1/);
});

test('you cannot refer yourself', async (t) => {
  const store = freshStore(t);
  const replies = [];
  await handleReferralCommand(
    interaction({ sub: 'claim', userId: 'u1', referrer: fakeUser('u1'), replies }),
    { store, config },
  );

  assert.equal(store.getReferralClaim('u1'), null);
  assert.match(replies[0].content, /cannot refer yourself/i);
});

test('a referral cannot be claimed a second time, even to a different referrer', async (t) => {
  const store = freshStore(t);
  const replies = [];
  await handleReferralCommand(
    interaction({ sub: 'claim', userId: 'new1', referrer: fakeUser('ref1'), replies }),
    { store, config },
  );
  await handleReferralCommand(
    interaction({ sub: 'claim', userId: 'new1', referrer: fakeUser('ref2'), replies }),
    { store, config },
  );

  assert.equal(store.getReferralClaim('new1').referrerId, 'ref1', 'the first claim wins, not the second');
  assert.match(replies.at(-1).content, /already claimed/i);
});

test('balance reflects real converted referrals, not just claims', async (t) => {
  const store = freshStore(t);
  store.recordReferralClaim(creditReferral({ referredId: 'a', referrerId: 'ref1', guildId: 'g', rewardDollars: 10, creditedAt: null, paidAt: null }));
  store.recordReferralClaim({ referredId: 'b', referrerId: 'ref1', guildId: 'g', rewardDollars: 10, creditedAt: null, paidAt: null });

  const replies = [];
  await handleReferralCommand(interaction({ sub: 'balance', userId: 'ref1', replies }), { store, config });

  const embed = replies[0].embeds[0].toJSON();
  const field = (name) => embed.fields.find((f) => f.name === name).value;
  assert.equal(field('Referred'), '2');
  assert.equal(field('Converted'), '1');
  assert.equal(field('Still owed'), '**$10.00**');
});

test('payouts is refused to non-mods', async (t) => {
  const store = freshStore(t);
  const replies = [];
  await handleReferralCommand(interaction({ sub: 'payouts', userId: 'u1', admin: false, replies }), { store, config });
  assert.match(replies[0].content, /Mods only/);
});

test('a mod sees the payout list and can mark it paid', async (t) => {
  const store = freshStore(t);
  store.recordReferralClaim(
    creditReferral({ referredId: 'a', referrerId: 'ref1', guildId: 'g', rewardDollars: 10, creditedAt: null, paidAt: null }),
  );

  const payoutReplies = [];
  await handleReferralCommand(interaction({ sub: 'payouts', userId: 'mod1', admin: true, replies: payoutReplies }), {
    store,
    config,
  });
  assert.match(payoutReplies[0].embeds[0].toJSON().description, /ref1/);

  const markReplies = [];
  await handleReferralCommand(
    interaction({ sub: 'markpaid', userId: 'mod1', admin: true, referrer: fakeUser('ref1'), replies: markReplies }),
    { store, config },
  );
  assert.match(String(markReplies[0]), /Marked 1 referral/);
  assert.ok(store.getReferralClaim('a').paidAt);

  const afterReplies = [];
  await handleReferralCommand(interaction({ sub: 'payouts', userId: 'mod1', admin: true, replies: afterReplies }), {
    store,
    config,
  });
  assert.match(afterReplies[0].content, /Nobody is owed/);
});

// Fraud resistance: a claim from a brand-new account is recorded but held
// for a mod to look at, and the mod's decision actually changes what can be
// credited -- not just the claim's own "flagged" flag in isolation.

test('a claim from a brand-new account is flagged, logged for review, and the claimant is told', async (t) => {
  const store = freshStore(t);
  const posts = [];
  const client = fakeClient(posts);
  const replies = [];

  await handleReferralCommand(
    interaction({
      sub: 'claim',
      userId: 'new1',
      userOptions: { createdTimestamp: Date.now() - DAY_MS }, // 1 day old
      referrer: fakeUser('ref1'),
      replies,
      client,
    }),
    { store, config },
  );

  const claim = store.getReferralClaim('new1');
  assert.equal(claim.flagged, true);
  assert.match(replies.at(-1).content, /quick human check/i);

  assert.equal(posts.length, 1, 'a review post went to the mod log');
  assert.match(posts[0].embeds[0].toJSON().description, /new1.*ref1|ref1.*new1/s);
  assert.equal(posts[0].components.length, 1, 'approve/reject buttons attached');
});

test('a mod approving a flagged claim, before any payment, just clears the flag', async (t) => {
  const store = freshStore(t);
  store.recordReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    rewardDollars: 10,
    creditedAt: null,
    paidAt: null,
    flagged: true,
    flagReasons: ['new_account'],
    reviewedAt: null,
    rejected: false,
  });

  const replies = [];
  await handleReferralReviewButton(
    interaction({ customId: 'referral:review:new1:approve', userId: 'mod1', admin: true, replies }),
    { store, config },
  );

  const claim = store.getReferralClaim('new1');
  assert.equal(claim.flagged, false);
  assert.equal(claim.creditedAt, null, 'not paid yet, so nothing to credit');
  assert.match(replies[0].content, /will be credited .* once/i);
});

test('a mod approving a flagged claim whose referred member ALREADY paid credits it immediately', async (t) => {
  const store = freshStore(t);
  store.recordReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    rewardDollars: 10,
    creditedAt: null,
    paidAt: null,
    flagged: true,
    flagReasons: ['new_account'],
    reviewedAt: null,
    rejected: false,
  });
  store.putSubscription({ guildId: 'g', userId: 'new1', tier: 1, expiresAt: Date.now() + 1000, renewals: 0 });

  const dms = [];
  const client = fakeClient([], dms);
  const replies = [];
  await handleReferralReviewButton(
    interaction({ customId: 'referral:review:new1:approve', userId: 'mod1', admin: true, replies, client }),
    { store, config },
  );

  const claim = store.getReferralClaim('new1');
  assert.ok(claim.creditedAt, 'credited right away, since the payment already happened');
  assert.match(replies[0].content, /credited .* right now/i);
  assert.equal(dms.length, 1, 'the referrer got the payoff DM');
  assert.equal(dms[0].id, 'ref1');
});

test('rejecting a flagged claim locks it out, and a non-mod cannot review at all', async (t) => {
  const store = freshStore(t);
  store.recordReferralClaim({
    referredId: 'new1',
    referrerId: 'ref1',
    guildId: 'g',
    rewardDollars: 10,
    creditedAt: null,
    paidAt: null,
    flagged: true,
    flagReasons: ['new_account'],
    reviewedAt: null,
    rejected: false,
  });

  const blockedReplies = [];
  await handleReferralReviewButton(
    interaction({ customId: 'referral:review:new1:reject', userId: 'random', admin: false, replies: blockedReplies }),
    { store, config },
  );
  assert.match(blockedReplies[0].content, /Mods only/);
  assert.equal(store.getReferralClaim('new1').rejected, false, 'the non-mod press did nothing');

  const replies = [];
  await handleReferralReviewButton(
    interaction({ customId: 'referral:review:new1:reject', userId: 'mod1', admin: true, replies }),
    { store, config },
  );
  assert.equal(store.getReferralClaim('new1').rejected, true);
  assert.match(replies[0].content, /Rejected/);

  store.putSubscription({ guildId: 'g', userId: 'new1', tier: 1, expiresAt: Date.now() + 1000, renewals: 0 });
  const secondReplies = [];
  await handleReferralReviewButton(
    interaction({ customId: 'referral:review:new1:approve', userId: 'mod1', admin: true, replies: secondReplies }),
    { store, config },
  );
  assert.match(secondReplies[0].content, /Already reviewed/i);
  assert.equal(store.getReferralClaim('new1').creditedAt, null, 'rejected stays rejected, no second guess');
});
