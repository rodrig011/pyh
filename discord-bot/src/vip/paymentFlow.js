import { ActionRowBuilder, EmbedBuilder, UserSelectMenuBuilder, time } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { TIER_NAMES, formatMoney, includedTiers, isLifetime, tierPricedAt } from '../lib/tiers.js';
import { markOrderPaid, matchPayment } from './orders.js';
import { sendDm, sendLog } from './notify.js';
import { grantTierRoles } from './roles.js';
import { upsertSubscription } from './subscriptions.js';
import { creditAndNotifyReferral } from './referrals.js';

const log = createLogger('payments');

export const ASSIGN_PREFIX = 'vip:assign:';

/** The member picker a mod uses to attach a codeless payment to whoever paid. */
export function assignRow(unassignedId, tier) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`${ASSIGN_PREFIX}${unassignedId}`)
      .setPlaceholder(`Who paid? They get ${TIER_NAMES[tier]}`)
      .setMinValues(1)
      .setMaxValues(1),
  );
}

/**
 * Takes a detected payment (from email or confirmed by hand), matches it to an
 * order and hands out the corresponding roles.
 *
 * @returns {Promise<{status: string, reason?: string, order?: object, tier?: number, roles?: object}>}
 */
export async function processPayment(client, store, config, payment) {
  const match = matchPayment(store, payment, config);

  if (match.status !== 'match') {
    log.warn(`Payment not applied (${match.status}): ${match.reason}`);

    // A payment with no code at all is most likely nothing to do with the bot —
    // the same inbox receives the owner's personal Zelle activity. Posting those
    // to a mod channel would leak private transfers and drown the entries that
    // do matter, so they stay out of Discord entirely unless asked for.
    if (match.status === 'no_code' && !config.logUnmatchedPayments) {
      // Huntington's Zelle alert drops the memo, so a paying customer whose
      // order has already aged out arrives looking exactly like a personal
      // transfer. An amount landing exactly on a tier price is the difference:
      // nobody sends a friend $100.00 to the cent on the day a tier costs that.
      const tier = tierPricedAt(payment.amountCents, config.tiers);
      if (tier) {
        const record = store.recordUnassignedPayment({
          amountCents: payment.amountCents,
          tier,
          senderName: payment.senderName ?? null,
          source: payment.source ?? 'zelle-email',
          reference: payment.reference ?? null,
          at: payment.receivedAt ?? Date.now(),
        });

        await sendLog(
          client,
          config,
          new EmbedBuilder()
            .setColor(COLORS.warning)
            .setTitle('💵 Payment received with no code')
            .setDescription(
              `**${payment.senderName ?? 'Someone'}** sent **${formatMoney(payment.amountCents)}** — exactly the ${TIER_NAMES[tier]} price.\n` +
                'The bank did not forward the note, so the buyer cannot be identified automatically. Pick who it was below.',
            )
            .setFooter({ text: 'Ignore this if it was a personal transfer — nothing happens until you choose.' })
            .setTimestamp(),
          { ping: true, components: [assignRow(record.id, tier)] },
        );

        log.info(`Payment of ${payment.amountCents} cents with no code awaits assignment (${record.id})`);
        return { ...match, status: 'needs_assignment', unassignedId: record.id, tier };
      }

      log.info(`Ignoring a payment with no code (${payment.amountCents} cents) — assumed personal`);
      return match;
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('Payment received but not applied')
      .setDescription(match.reason ?? match.status)
      .addFields(
        { name: 'Amount', value: payment.amountCents ? formatMoney(payment.amountCents) : 'unknown', inline: true },
        { name: 'Codes', value: (payment.codes ?? []).join(', ') || 'none', inline: true },
        { name: 'Sender', value: payment.senderName ?? 'unknown', inline: true },
      )
      .setFooter({ text: 'Check who this is and apply it with /vip-admin confirm' })
      .setTimestamp();

    // Several people are waiting on the same price with no code to tell them
    // apart. Naming them turns the decision into one click for a mod.
    if (match.candidates?.length) {
      embed.addFields({
        name: 'Waiting for this amount',
        value: match.candidates
          .map((candidate) => `\`${candidate.code}\` — <@${candidate.userId}>`)
          .join('\n'),
      });
    }

    await sendLog(client, config, embed, { ping: true });
    return match;
  }

  const { order, tier } = match;
  const guild = await client.guilds.fetch(order.guildId);
  let roles = { added: [], already: [], missing: [], failed: [], absent: false };

  try {
    roles = await grantTierRoles(guild, order.userId, tier, config);
  } catch (error) {
    log.error(`Could not assign roles to ${order.userId}: ${error.message}`);
    await sendLog(
      client,
      config,
      new EmbedBuilder()
        .setColor(COLORS.danger)
        .setTitle('Valid payment but role assignment failed')
        .setDescription(`Order \`${order.code}\` from <@${order.userId}>: ${error.message}`)
        .setTimestamp(),
    );
    return { status: 'role_error', order, tier, reason: error.message };
  }

  markOrderPaid(store, order, {
    tier,
    payment,
    grantedRoleIds: [...roles.added, ...roles.already],
  });

  const subscription = upsertSubscription(store, {
    guildId: order.guildId,
    userId: order.userId,
    tier,
    code: order.code,
    days: config.subscriptionDays,
  });

  const tierList = includedTiers(tier)
    .map((level) => TIER_NAMES[level])
    .join(', ');

  // Somebody can buy from a DM before they have ever joined. The membership is
  // real either way — it is paid for — so it is recorded now and the roles are
  // handed over the moment they walk in.
  const awaitingJoin = roles.absent;
  const expiresAt = Math.floor(subscription.expiresAt / 1000);
  const renewal = subscription.renewals > 0;

  // A referral pays out once -- on the referred member's FIRST payment, never
  // on a renewal from someone who already converted. A flagged claim (new
  // account, or claimed long after actually joining) is held back until a
  // mod approves it -- see referrals.js's creditReferral and
  // creditAndNotifyReferral, which is the single place this and a mod's
  // approval button both go through.
  if (!renewal) {
    const claim = store.getReferralClaim(order.userId);
    if (claim) await creditAndNotifyReferral(client, store, config, claim);
  }

  await sendDm(
    client,
    order.userId,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(renewal ? 'Membership renewed!' : 'Payment confirmed!')
      .setDescription(
        [
          `We received your payment of **${formatMoney(payment.amountCents ?? order.amountCents)}** with code \`${order.code}\`.`,
          awaitingJoin
            ? `**Join the server and your access is waiting:** ${config.serverInviteUrl ?? '(ask a mod for the invite)'}\nYour roles are handed over the second you walk in.`
            : `You now have access to: **${tierList}**.`,
          '',
          isLifetime(config.subscriptionDays)
            ? 'This is a **one-time, lifetime membership** — nothing to renew, ever.'
            : `This is a **${config.subscriptionDays}-day membership**. It ends ${time(expiresAt, 'R')} — ${time(expiresAt, 'F')}.\n` +
              'We will remind you before then. If it is not renewed, the bot removes the roles automatically.',
        ].join('\n'),
      )
      .setTimestamp(),
  );

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('Payment applied')
      .setDescription(`<@${order.userId}> received **${TIER_NAMES[tier]}**`)
      .addFields(
        { name: 'Code', value: `\`${order.code}\``, inline: true },
        { name: 'Amount', value: formatMoney(payment.amountCents ?? order.amountCents), inline: true },
        { name: 'Source', value: payment.source ?? 'manual', inline: true },
        {
          name: 'Identified by',
          value: match.matchedBy === 'amount' ? 'the amount (no code in the alert)' : 'the code in the note',
          inline: true,
        },
        { name: awaitingJoin ? 'Roles waiting (not in the server yet)' : 'Roles granted', value: tierList },
        { name: renewal ? 'Renewed until' : 'Expires', value: time(expiresAt, 'f'), inline: true },
      )
      .setTimestamp(),
    { ping: true },
  );

  log.info(
    `Order ${order.code} paid: ${order.userId} -> ${TIER_NAMES[tier]} until ${new Date(subscription.expiresAt).toISOString()}`,
  );
  return { status: 'granted', order, tier, roles, subscription };
}
