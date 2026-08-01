import { EmbedBuilder } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import { TIER_NAMES, formatMoney, includedTiers } from '../lib/tiers.js';
import { markOrderPaid, matchPayment } from './orders.js';
import { grantTierRoles } from './roles.js';

const log = createLogger('pagos');

async function sendLog(client, config, embed) {
  if (!config.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (error) {
    log.warn(`No se pudo escribir en el canal de registro: ${error.message}`);
  }
}

/**
 * Toma un pago detectado (por correo o confirmado a mano), lo empareja con una
 * orden y entrega los roles correspondientes.
 *
 * @returns {Promise<{status: string, reason?: string, order?: object, tier?: number, roles?: object}>}
 */
export async function processPayment(client, store, config, payment) {
  const match = matchPayment(store, payment, config);

  if (match.status !== 'match') {
    log.warn(`Pago no aplicado (${match.status}): ${match.reason}`);
    await sendLog(
      client,
      config,
      new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('Pago recibido sin aplicar')
        .setDescription(match.reason ?? match.status)
        .addFields(
          { name: 'Monto', value: payment.amountCents ? formatMoney(payment.amountCents) : 'desconocido', inline: true },
          { name: 'Codigos', value: (payment.codes ?? []).join(', ') || 'ninguno', inline: true },
          { name: 'Remitente', value: payment.senderName ?? 'desconocido', inline: true },
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
    log.error(`No se pudo asignar roles a ${order.userId}: ${error.message}`);
    await sendLog(
      client,
      config,
      new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Pago valido pero fallo la asignacion de roles')
        .setDescription(`Orden \`${order.code}\` de <@${order.userId}>: ${error.message}`)
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

  // Aviso al comprador por privado (puede fallar si tiene los DM cerrados).
  try {
    const user = await client.users.fetch(order.userId);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('¡Pago confirmado!')
          .setDescription(
            `Recibimos tu pago de **${formatMoney(payment.amountCents ?? order.amountCents)}** con el codigo \`${order.code}\`.\n` +
              `Ya tienes acceso a: **${tierList}**.`,
          )
          .setTimestamp(),
      ],
    });
  } catch (error) {
    log.warn(`No se pudo enviar DM a ${order.userId}: ${error.message}`);
  }

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Pago aplicado')
      .setDescription(`<@${order.userId}> recibio **${TIER_NAMES[tier]}**`)
      .addFields(
        { name: 'Codigo', value: `\`${order.code}\``, inline: true },
        { name: 'Monto', value: formatMoney(payment.amountCents ?? order.amountCents), inline: true },
        { name: 'Origen', value: payment.source ?? 'manual', inline: true },
        { name: 'Roles otorgados', value: tierList },
      )
      .setTimestamp(),
  );

  log.info(`Orden ${order.code} pagada: ${order.userId} -> ${TIER_NAMES[tier]}`);
  return { status: 'granted', order, tier, roles };
}
