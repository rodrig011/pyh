import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { TIER_NAMES, formatMoney, includedTiers } from '../lib/tiers.js';
import { markOrderPaid, matchPayment } from './orders.js';
import { grantTierRoles } from './roles.js';

const log = createLogger('payments');

async function sendLog(client, config, embed) {
  if (!config.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (error) {
    log.warn(`Could not write to the log channel: ${error.message}`);
  }
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
    await sendLog(
      client,
      config,
      new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('Payment received but not applied')
        .setDescription(match.reason ?? match.status)
        .addFields(
          { name: 'Amount', value: payment.amountCents ? formatMoney(payment.amountCents) : 'unknown', inline: true },
          { name: 'Codes', value: (payment.codes ?? []).join(', ') || 'none', inline: true },
          { name: 'Sender', value: payment.senderName ?? 'unknown', inline: true },
        )
        .setTimestamp(),
    );
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

  const tierList = includedTiers(tier)
    .map((level) => TIER_NAMES[level])
    .join(', ');

  // Let the buyer know by DM (may fail if their DMs are closed).
  try {
    const user = await client.users.fetch(order.userId);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('Payment confirmed!')
          .setDescription(
            `We received your payment of **${formatMoney(payment.amountCents ?? order.amountCents)}** with code \`${order.code}\`.\n` +
              `You now have access to: **${tierList}**.`,
          )
          .setTimestamp(),
      ],
    });
  } catch (error) {
    log.warn(`Could not DM ${order.userId}: ${error.message}`);
  }

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
        { name: 'Roles granted', value: tierList },
      )
      .setTimestamp(),
  );

  log.info(`Order ${order.code} paid: ${order.userId} -> ${TIER_NAMES[tier]}`);
  return { status: 'granted', order, tier, roles };
}
