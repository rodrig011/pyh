import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createStore } from '../src/lib/store.js';
import { handleReferralCommand } from '../src/vip/referralCommands.js';
import { creditReferral } from '../src/vip/referrals.js';

const config = { guildId: 'g', modRoleIds: [] };

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'referral-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

function fakeUser(id) {
  return { id, tag: `${id}#0001`, username: id };
}

function interaction({ sub, userId = 'new1', referrer = null, member = null, admin = false, replies }) {
  return {
    guildId: 'g',
    user: fakeUser(userId),
    memberPermissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
    member: member ?? { roles: { cache: { has: () => false } } },
    options: {
      getSubcommand: () => sub,
      getUser: (name) => (name === 'referrer' || name === 'member' ? referrer : null),
    },
    reply: async (payload) => {
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
