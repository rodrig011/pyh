import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, formatEvidence, money, stamp } from '../src/vip/evidence.js';
import { interpretStripeEvent } from '../src/payments/stripe.js';

// A dispute is decided on paperwork by somebody who will never read this
// server. Every number in the pack has to hold up against fixed input.

const day = 86400000;
const now = Date.parse('2026-08-03T00:00:00Z');
const paidAt = now - 20 * day;

const world = {
  subscription: {
    guildId: 'g',
    userId: 'buyer',
    tier: 2,
    status: 'active',
    startedAt: paidAt,
    expiresAt: paidAt + 30 * day,
    renewals: 1,
    source: 'stripe',
    autoRenew: true,
    stripeSubscriptionId: 'sub_123',
    stripeCustomerId: 'cus_456',
  },
  payments: [
    { userId: 'buyer', at: paidAt, amountCents: 10000, source: 'stripe', code: 'VIP-AAA', reference: 'sub_123' },
    { userId: 'someone-else', at: paidAt, amountCents: 5000, source: 'zelle', code: 'VIP-BBB' },
  ],
  picks: [
    { id: 'p1', guildId: 'g', asset: 'BTC', createdAt: paidAt + day },
    { id: 'p2', guildId: 'g', asset: 'BTC', createdAt: paidAt + 2 * day },
    // Before they ever paid: not theirs to have been delivered.
    { id: 'p0', guildId: 'g', asset: 'BTC', createdAt: paidAt - 5 * day },
  ],
  welcomes: [{ userId: 'buyer', delivered: true, at: paidAt + 60_000 }],
  votes: [
    { pickId: 'p1', ballots: { buyer: 'profit', other: 'loss' }, closesAt: paidAt + day + 3600_000 },
    { pickId: 'p2', ballots: { other: 'profit' }, closesAt: paidAt + 2 * day },
  ],
  orders: [{ userId: 'buyer', code: 'VIP-AAA' }],
};

test('the pack counts only what belongs to this member', () => {
  const evidence = buildEvidence(world, { userId: 'buyer', now });

  assert.equal(evidence.totals.payments, 1);
  assert.equal(evidence.totals.paidCents, 10000);
  assert.equal(evidence.engagement.ballotsCast, 1);
});

test('delivery counts only the signals published while they had access', () => {
  const evidence = buildEvidence(world, { userId: 'buyer', now });

  // p0 came before they paid and must not be claimed as delivered to them.
  assert.equal(evidence.delivery.calls, 2);
  assert.equal(evidence.access.days, 20);
});

test('a renewal is recorded, because paying twice answers the dispute', () => {
  const evidence = buildEvidence(world, { userId: 'buyer', now });
  assert.equal(evidence.delivery.renewedAfterFirstPeriod, true);

  const text = formatEvidence(evidence, { userTag: 'buyer#1' });
  assert.match(text, /renewed 1 time/);
});

test('the written pack carries what a bank checks against its own records', () => {
  const text = formatEvidence(buildEvidence(world, { userId: 'buyer', now }), { userTag: 'buyer#1' });

  assert.match(text, /sub_123/);
  assert.match(text, /cus_456/);
  assert.match(text, /\$100\.00/);
  assert.match(text, /2026-/);
  assert.match(text, /voted "profit"/);
  assert.match(text, /Digital access granted immediately/);
});

test('a thin case says so — to the mod, never to the bank', () => {
  const bare = buildEvidence(
    { subscription: null, payments: [{ userId: 'buyer', at: paidAt, amountCents: 5000, source: 'stripe' }] },
    { userId: 'buyer', now },
  );

  assert.ok(bare.weaknesses.length > 0);
  assert.match(bare.weaknesses.join(' '), /No calls were published/);

  // The weaknesses are for the mod's eyes. Handing a reviewer a list of the
  // holes in your own case is not evidence, it is a confession.
  const text = formatEvidence(bare, { userTag: 'buyer#1' });
  assert.doesNotMatch(text, /No calls were published/);
});

test('a member with nothing on record produces no case at all', () => {
  const evidence = buildEvidence({ subscription: null, payments: [] }, { userId: 'ghost', now });

  assert.equal(evidence.hasCase, false);
  assert.match(formatEvidence(evidence, { userTag: 'ghost#1' }), /No record found/);
});

test('a Stripe dispute is recognised, with its deadline', () => {
  const intent = interpretStripeEvent({
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_1',
        charge: 'ch_1',
        amount: 10000,
        reason: 'product_not_received',
        customer: 'cus_456',
        evidence_details: { due_by: 1786000000 },
        metadata: { userId: 'buyer' },
      },
    },
  });

  assert.equal(intent.action, 'dispute');
  assert.equal(intent.chargeId, 'ch_1');
  assert.equal(intent.userId, 'buyer');
  assert.equal(intent.dueBy, 1786000000 * 1000);
});

test('money and timestamps are written for somebody outside Discord', () => {
  assert.equal(money(10000), '$100.00');
  assert.equal(money(null), '—');
  assert.match(stamp(Date.parse('2026-08-03T05:44:00Z')), /^2026-08-03 05:44:00 UTC$/);
});

test('the pack never claims the customer read anything', () => {
  const text = formatEvidence(buildEvidence(world, { userId: 'buyer', now }), { userTag: 'buyer#1' });

  // Discord confirms delivery, not that a message was opened. A claim a
  // reviewer can pull apart costs the ones that would have held.
  assert.match(text, /was delivered to the customer/);
  assert.doesNotMatch(text, /opened a direct message/);
});

test('every line of the pack is in English, whoever runs the bot', () => {
  const text = formatEvidence(buildEvidence(world, { userId: 'buyer', now }), { userTag: 'buyer#1' });

  assert.doesNotMatch(text, /[áéíóúñ¿¡]/i);
  assert.match(text, /^DISPUTE EVIDENCE/);
});
