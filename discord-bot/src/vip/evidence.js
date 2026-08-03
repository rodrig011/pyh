import { SUBSCRIPTION_STATUS } from '../lib/subscriptions.js';

/**
 * Everything the seller knows about one member, assembled for a dispute.
 *
 * A card dispute is decided on paperwork, not on who is telling the truth. The
 * buyer says "I never got what I paid for"; the seller has a week to prove
 * otherwise, and the burden is entirely on the seller. What wins these is
 * boring specifics — when they paid, when access was handed over, and what
 * they did with it afterwards.
 *
 * All of it is already in the store; it has just never been in one place. Pure
 * on purpose: this ends up in front of a bank, so every number in it has to be
 * checkable against fixed input rather than trusted.
 *
 * @param {object} data
 * @param {object|null} data.subscription
 * @param {object[]} [data.payments]
 * @param {object[]} [data.picks] calls posted by the room
 * @param {object[]} [data.welcomes]
 * @param {object[]} [data.votes] the room's post-call polls
 * @param {object[]} [data.orders]
 * @param {object} options
 * @param {string} options.userId
 * @param {number} [options.now]
 */
export function buildEvidence(data, { userId, now = Date.now() } = {}) {
  const subscription = data.subscription ?? null;
  const payments = (data.payments ?? []).filter((payment) => payment.userId === userId);
  const welcomes = (data.welcomes ?? []).filter((welcome) => welcome.userId === userId);
  const orders = (data.orders ?? []).filter((order) => order.userId === userId);

  const paidCents = payments.reduce((total, payment) => total + (payment.amountCents ?? 0), 0);
  const firstPaidAt = payments.length > 0 ? Math.min(...payments.map((p) => p.at)) : null;
  const lastPaidAt = payments.length > 0 ? Math.max(...payments.map((p) => p.at)) : null;

  // Access begins when the roles were handed over, which is the moment the
  // buyer could see the thing they bought.
  const accessFrom = subscription?.startedAt ?? firstPaidAt ?? null;
  const accessUntil = subscription
    ? subscription.status === SUBSCRIPTION_STATUS.ACTIVE
      ? Math.min(subscription.expiresAt, now)
      : (subscription.endedAt ?? subscription.expiresAt)
    : null;

  // What was actually delivered in that window. A signals room's product is the
  // signals, so the count of calls published while they had access is the
  // delivery record — the equivalent of a shipment tracking number.
  const delivered =
    accessFrom === null
      ? []
      : (data.picks ?? []).filter(
          (pick) => pick.createdAt >= accessFrom && pick.createdAt <= (accessUntil ?? now),
        );

  // And what they did with it. A ballot is the strongest single item here: it
  // is the buyer, inside the product, acting on a specific signal, at a
  // timestamp — after the payment they now say bought them nothing.
  const ballots = [];
  for (const vote of data.votes ?? []) {
    const choice = vote.ballots?.[userId];
    if (!choice) continue;
    const pick = (data.picks ?? []).find((item) => item.id === vote.pickId) ?? null;
    ballots.push({ pickId: vote.pickId, choice, at: vote.closesAt ?? null, asset: pick?.asset ?? null });
  }

  const welcomed = welcomes.find((welcome) => welcome.delivered) ?? null;

  return {
    userId,
    hasCase: payments.length > 0 || subscription !== null,
    subscription: subscription
      ? {
          tier: subscription.tier,
          status: subscription.status,
          startedAt: subscription.startedAt,
          expiresAt: subscription.expiresAt,
          renewals: subscription.renewals ?? 0,
          source: subscription.source ?? 'zelle',
          autoRenew: Boolean(subscription.autoRenew),
          stripeSubscriptionId: subscription.stripeSubscriptionId ?? null,
          stripeCustomerId: subscription.stripeCustomerId ?? null,
          endedAt: subscription.endedAt ?? null,
          endedReason: subscription.endedReason ?? null,
        }
      : null,
    payments: payments
      .slice()
      .sort((a, b) => a.at - b.at)
      .map((payment) => ({
        at: payment.at,
        amountCents: payment.amountCents ?? null,
        source: payment.source ?? 'unknown',
        code: payment.code ?? null,
        reference: payment.reference ?? null,
        senderName: payment.senderName ?? null,
      })),
    totals: {
      paidCents,
      payments: payments.length,
      firstPaidAt,
      lastPaidAt,
      renewals: subscription?.renewals ?? 0,
    },
    access: {
      from: accessFrom,
      until: accessUntil,
      days: accessFrom === null ? 0 : Math.max(0, Math.round(((accessUntil ?? now) - accessFrom) / 86400000)),
    },
    delivery: {
      calls: delivered.length,
      firstCallAt: delivered.length > 0 ? Math.min(...delivered.map((pick) => pick.createdAt)) : null,
      lastCallAt: delivered.length > 0 ? Math.max(...delivered.map((pick) => pick.createdAt)) : null,
      // Renewing is the buyer saying, with their own money, that the first
      // period was worth paying for again.
      renewedAfterFirstPeriod: (subscription?.renewals ?? 0) > 0,
    },
    engagement: {
      welcomeDeliveredAt: welcomed?.at ?? null,
      ballotsCast: ballots.length,
      ballots: ballots.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-10),
      ordersOpened: orders.length,
    },
    // Said plainly so nobody has to work out whether the case is thin.
    weaknesses: weaknessesOf({ payments, delivered, ballots, subscription, welcomed }),
  };
}

/**
 * Where this dossier is thin.
 *
 * Handing a mod a confident-looking pack that a bank will reject teaches them
 * to trust it. Saying which part is weak is what makes the strong parts worth
 * something.
 */
function weaknessesOf({ payments, delivered, ballots, subscription, welcomed }) {
  const gaps = [];
  if (payments.length === 0) {
    gaps.push('No payment is recorded against this member at all — check the order code first.');
  }
  if (delivered.length === 0) {
    gaps.push('No calls were published while they had access. There is no delivery to point at.');
  }
  if (ballots.length === 0 && !welcomed) {
    gaps.push(
      'Nothing shows them using the room — no votes, no delivered welcome. The case rests on access alone.',
    );
  }
  if (subscription && subscription.source !== 'stripe') {
    gaps.push(
      'This membership was not paid by card, so a card dispute for it may belong to a different purchase.',
    );
  }
  return gaps;
}

/** Cents to "$50.00", for a document somebody outside Discord will read. */
export function money(cents) {
  return cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`;
}

/** A timestamp a bank can match against its own records: UTC, to the second. */
export function stamp(at) {
  return at ? new Date(at).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
}

/**
 * The dossier as plain text, ready to paste into Stripe's evidence box.
 *
 * Deliberately not an embed: this leaves Discord. Stripe's form takes text, and
 * a reviewer at a bank reads it beside a dozen others.
 */
export function formatEvidence(evidence, { userTag = null, productName = 'VIP membership' } = {}) {
  if (!evidence.hasCase) {
    return `No record found for ${userTag ?? evidence.userId}. Nothing was charged and no membership exists.`;
  }

  const lines = [
    `DISPUTE EVIDENCE — ${productName}`,
    `Customer: ${userTag ?? ''} (Discord ID ${evidence.userId})`,
    '',
    'WHAT WAS SOLD',
    `A ${productName}: access to a private Discord server publishing live trading signals.`,
    'Digital access granted immediately on payment. No physical goods.',
    '',
    'PAYMENT',
  ];

  for (const payment of evidence.payments) {
    lines.push(
      `- ${stamp(payment.at)} — ${money(payment.amountCents)} via ${payment.source}` +
        (payment.code ? ` (order ${payment.code})` : '') +
        (payment.reference ? ` [ref ${payment.reference}]` : ''),
    );
  }
  lines.push(`Total paid: ${money(evidence.totals.paidCents)} across ${evidence.totals.payments} payment(s).`);

  if (evidence.subscription?.stripeSubscriptionId) {
    lines.push(`Stripe subscription: ${evidence.subscription.stripeSubscriptionId}`);
  }
  if (evidence.subscription?.stripeCustomerId) {
    lines.push(`Stripe customer: ${evidence.subscription.stripeCustomerId}`);
  }

  lines.push(
    '',
    'ACCESS GRANTED',
    `Access began ${stamp(evidence.access.from)} and ran to ${stamp(evidence.access.until)} — ${evidence.access.days} day(s).`,
  );
  if (evidence.engagement.welcomeDeliveredAt) {
    lines.push(
      `The customer received and opened a direct message confirming their access at ${stamp(evidence.engagement.welcomeDeliveredAt)}.`,
    );
  }

  lines.push('', 'WHAT WAS DELIVERED');
  if (evidence.delivery.calls > 0) {
    lines.push(
      `${evidence.delivery.calls} trading signal(s) were published to the customer while they had access,`,
      `from ${stamp(evidence.delivery.firstCallAt)} to ${stamp(evidence.delivery.lastCallAt)}.`,
      'Each one carries a timestamp, a direction, an entry price and a recorded outcome.',
    );
  } else {
    lines.push('No signals were published during their access period.');
  }

  if (evidence.engagement.ballotsCast > 0) {
    lines.push(
      '',
      'CUSTOMER USE OF THE SERVICE',
      `The customer voted in ${evidence.engagement.ballotsCast} post-signal poll(s) inside the server,`,
      'which requires being present in the paid channels. Most recent:',
      ...evidence.engagement.ballots
        .slice(-5)
        .map((ballot) => `- ${stamp(ballot.at)} — voted "${ballot.choice}"${ballot.asset ? ` on a ${ballot.asset} call` : ''}`),
    );
  }

  if (evidence.delivery.renewedAfterFirstPeriod) {
    lines.push(
      '',
      `The customer renewed ${evidence.totals.renewals} time(s) after their first period ended,`,
      'paying again for the same service they are now disputing.',
    );
  }

  return lines.join('\n');
}
