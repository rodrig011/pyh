import { EmbedBuilder, time } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { TIER_NAMES, formatMoney, includedTiers } from '../lib/tiers.js';
import { markOrderPaid, matchPayment } from './orders.js';
import { sendDm, sendLog } from './notify.js';
import { grantTierRoles } from './roles.js';
import { upsertSubscription } from './subscriptions.js';

const log = createLogger('payments');

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
  let roles = { added: [], already: [], missing: [], failed: [] };

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
  const expiresAt = Math.floor(subscription.expiresAt / 1000);
  const renewal = subscription.renewals > 0;

  await sendDm(
    client,
    order.userId,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(renewal ? 'Membership renewed!' : 'Payment confirmed!')
      .setDescription(
        [
          `We received your payment of **${formatMoney(payment.amountCents ?? order.amountCents)}** with code \`${order.code}\`.`,
          `You now have access to: **${tierList}**.`,
          '',
          `This is a **${config.subscriptionDays}-day membership**. It ends ${time(expiresAt, 'R')} — ${time(expiresAt, 'F')}.`,
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
        { name: 'Roles granted', value: tierList },
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
