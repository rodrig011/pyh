import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
} from 'discord.js';
import { TIER_NAMES, formatMoney, includedTiers } from '../lib/tiers.js';
import { normalizeCode } from '../lib/codes.js';
import { ORDER_STATUS, createOrder, expireStaleOrders } from './orders.js';
import { processPayment } from './paymentFlow.js';

export function buildCommands(config) {
  const tierChoices = [1, 2, 3].map((tier) => ({
    name: `${TIER_NAMES[tier]} — ${formatMoney(config.tiers[tier].priceCents)}`,
    value: tier,
  }));

  const vip = new SlashCommandBuilder()
    .setName('vip')
    .setDescription('Compra y consulta tu membresia VIP')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('comprar')
        .setDescription('Genera tu codigo de pago para Zelle')
        .addIntegerOption((option) =>
          option
            .setName('tier')
            .setDescription('Nivel VIP que quieres comprar')
            .setRequired(true)
            .addChoices(...tierChoices),
        ),
    )
    .addSubcommand((sub) => sub.setName('estado').setDescription('Consulta tus ordenes'))
    .addSubcommand((sub) => sub.setName('precios').setDescription('Muestra los niveles y sus precios'))
    .addSubcommand((sub) =>
      sub
        .setName('cancelar')
        .setDescription('Cancela una orden pendiente')
        .addStringOption((option) =>
          option.setName('codigo').setDescription('Codigo a cancelar (si tienes varios)').setRequired(false),
        ),
    );

  const admin = new SlashCommandBuilder()
    .setName('vip-admin')
    .setDescription('Administracion de pagos VIP')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) =>
      sub
        .setName('confirmar')
        .setDescription('Confirma un pago a mano y entrega los roles')
        .addStringOption((option) =>
          option.setName('codigo').setDescription('Codigo de la orden').setRequired(true),
        )
        .addNumberOption((option) =>
          option
            .setName('monto')
            .setDescription('Monto recibido en dolares (por defecto, el precio del tier)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('nota').setDescription('Referencia o nombre de quien pago').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('buscar')
        .setDescription('Consulta una orden por codigo')
        .addStringOption((option) =>
          option.setName('codigo').setDescription('Codigo de la orden').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('pendientes').setDescription('Lista las ordenes pendientes'))
    .addSubcommand((sub) =>
      sub
        .setName('cancelar')
        .setDescription('Cancela la orden de cualquier usuario')
        .addStringOption((option) =>
          option.setName('codigo').setDescription('Codigo de la orden').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('sincronizar').setDescription('Revisa el correo de Zelle ahora mismo'),
    );

  return [vip.toJSON(), admin.toJSON()];
}

function isAdmin(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return true;
  if (config.adminRoleIds.length === 0) return false;
  return config.adminRoleIds.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
}

function statusLabel(status) {
  return {
    [ORDER_STATUS.PENDING]: '⏳ pendiente',
    [ORDER_STATUS.PAID]: '✅ pagada',
    [ORDER_STATUS.CANCELLED]: '🚫 cancelada',
    [ORDER_STATUS.EXPIRED]: '⌛ vencida',
  }[status] ?? status;
}

function pricesEmbed(config) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('Niveles VIP')
    .setDescription('Cada nivel incluye todos los beneficios de los niveles inferiores.')
    .addFields(
      [1, 2, 3].map((tier) => ({
        name: `${TIER_NAMES[tier]} — ${formatMoney(config.tiers[tier].priceCents)}`,
        value: `Otorga: ${includedTiers(tier).map((level) => TIER_NAMES[level]).join(', ')}`,
      })),
    );
}

async function handleComprar(interaction, { store, config }) {
  const tier = interaction.options.getInteger('tier');
  expireStaleOrders(store);

  const existing = store
    .pendingOrdersFor(interaction.user.id)
    .find((order) => order.tier === tier && order.guildId === interaction.guildId);

  const order =
    existing ??
    createOrder(store, {
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      guildId: interaction.guildId,
      tier,
      config,
    });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`${TIER_NAMES[tier]} — ${formatMoney(order.amountCents)}`)
    .setDescription(
      [
        `**1.** Envia **${formatMoney(order.amountCents)}** por Zelle a:`,
        `> \`${config.zelleRecipient}\`${config.zelleRecipientName ? ` (${config.zelleRecipientName})` : ''}`,
        '',
        '**2.** Escribe **exactamente** este codigo en la nota / memo del envio:',
        `> # ${order.code}`,
        '',
        '**3.** Listo. En cuanto llegue el pago el bot te entrega los roles automaticamente.',
        '',
        `Incluye: ${includedTiers(tier).map((level) => TIER_NAMES[level]).join(', ')}`,
        `El codigo vence ${time(Math.floor(order.expiresAt / 1000), 'R')}.`,
      ].join('\n'),
    )
    .setFooter({ text: 'Sin el codigo en la nota el pago no se puede identificar automaticamente.' });

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    content: existing ? 'Ya tenias una orden abierta para este nivel, reutilizo su codigo:' : undefined,
  });
}

async function handleEstado(interaction, { store }) {
  expireStaleOrders(store);
  const orders = store
    .listOrders((order) => order.userId === interaction.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);

  if (orders.length === 0) {
    await interaction.reply({
      content: 'No tienes ninguna orden. Usa `/vip comprar` para empezar.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Tus ordenes')
    .addFields(
      orders.map((order) => ({
        name: `${order.code} — ${TIER_NAMES[order.tier]}`,
        value: `${statusLabel(order.status)} · ${formatMoney(order.amountCents)} · creada ${time(Math.floor(order.createdAt / 1000), 'R')}`,
      })),
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCancelar(interaction, { store, config }) {
  const raw = interaction.options.getString('codigo');
  const pending = store.pendingOrdersFor(interaction.user.id);

  let order;
  if (raw) {
    const code = normalizeCode(raw, { prefix: config.codePrefix, length: config.codeLength });
    order = pending.find((candidate) => candidate.code === code);
  } else if (pending.length === 1) {
    [order] = pending;
  }

  if (!order) {
    await interaction.reply({
      content:
        pending.length > 1
          ? `Tienes varias ordenes pendientes, indica cual: ${pending.map((item) => `\`${item.code}\``).join(', ')}`
          : 'No encontre ninguna orden pendiente tuya con ese codigo.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  order.status = ORDER_STATUS.CANCELLED;
  store.putOrder(order);
  await interaction.reply({ content: `Orden \`${order.code}\` cancelada.`, flags: MessageFlags.Ephemeral });
}

async function handleAdminConfirmar(interaction, { store, config, client }) {
  const code = normalizeCode(interaction.options.getString('codigo'), {
    prefix: config.codePrefix,
    length: config.codeLength,
  });
  if (!code) {
    await interaction.editReply('Ese codigo no tiene un formato valido.');
    return;
  }

  const order = store.getOrder(code);
  if (!order) {
    await interaction.editReply(`No existe ninguna orden con el codigo \`${code}\`.`);
    return;
  }

  const montoOption = interaction.options.getNumber('monto');
  const amountCents = montoOption === null ? order.amountCents : Math.round(montoOption * 100);

  const result = await processPayment(client, store, config, {
    codes: [code],
    amountCents,
    senderName: interaction.options.getString('nota') ?? `Confirmado por ${interaction.user.tag}`,
    source: 'manual',
    reference: `manual:${interaction.user.id}`,
    receivedAt: Date.now(),
  });

  if (result.status === 'granted') {
    await interaction.editReply(
      `Listo: <@${order.userId}> recibio **${TIER_NAMES[result.tier]}** (roles: ${includedTiers(result.tier).map((level) => TIER_NAMES[level]).join(', ')}).`,
    );
  } else {
    await interaction.editReply(`No se pudo aplicar: ${result.reason ?? result.status}`);
  }
}

async function handleAdminBuscar(interaction, { store, config }) {
  const code = normalizeCode(interaction.options.getString('codigo'), {
    prefix: config.codePrefix,
    length: config.codeLength,
  });
  const order = code ? store.getOrder(code) : null;
  if (!order) {
    await interaction.editReply('No encontre esa orden.');
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Orden ${order.code}`)
    .addFields(
      { name: 'Usuario', value: `<@${order.userId}>`, inline: true },
      { name: 'Nivel', value: TIER_NAMES[order.tier], inline: true },
      { name: 'Estado', value: statusLabel(order.status), inline: true },
      { name: 'Precio', value: formatMoney(order.amountCents), inline: true },
      { name: 'Creada', value: time(Math.floor(order.createdAt / 1000), 'f'), inline: true },
      { name: 'Vence', value: time(Math.floor(order.expiresAt / 1000), 'f'), inline: true },
    );

  if (order.payment) {
    embed.addFields({
      name: 'Pago',
      value: [
        `Origen: ${order.payment.source}`,
        `Monto: ${order.payment.amountCents ? formatMoney(order.payment.amountCents) : 'n/d'}`,
        `Remitente: ${order.payment.senderName ?? 'n/d'}`,
        `Referencia: ${order.payment.reference ?? 'n/d'}`,
      ].join('\n'),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleAdminPendientes(interaction, { store }) {
  expireStaleOrders(store);
  const pending = store
    .listOrders((order) => order.status === ORDER_STATUS.PENDING)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, 20);

  if (pending.length === 0) {
    await interaction.editReply('No hay ordenes pendientes.');
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`Ordenes pendientes (${pending.length})`)
        .setDescription(
          pending
            .map(
              (order) =>
                `\`${order.code}\` · <@${order.userId}> · ${TIER_NAMES[order.tier]} · ${formatMoney(order.amountCents)} · vence ${time(Math.floor(order.expiresAt / 1000), 'R')}`,
            )
            .join('\n'),
        ),
    ],
  });
}

async function handleAdminCancelar(interaction, { store, config }) {
  const code = normalizeCode(interaction.options.getString('codigo'), {
    prefix: config.codePrefix,
    length: config.codeLength,
  });
  const order = code ? store.getOrder(code) : null;
  if (!order) {
    await interaction.editReply('No encontre esa orden.');
    return;
  }
  order.status = ORDER_STATUS.CANCELLED;
  store.putOrder(order);
  await interaction.editReply(`Orden \`${order.code}\` de <@${order.userId}> cancelada.`);
}

async function handleAdminSincronizar(interaction, { watcher }) {
  if (!watcher) {
    await interaction.editReply('El vigilante de correo no esta activo (revisa la configuracion IMAP).');
    return;
  }
  try {
    const result = await watcher.poll();
    await interaction.editReply(
      `Revision terminada: ${result.checked} correo(s) nuevo(s), ${result.payments} pago(s) detectado(s).`,
    );
  } catch (error) {
    await interaction.editReply(`Fallo la revision del correo: ${error.message}`);
  }
}

/** Enruta cualquier interaccion de comando del bot VIP. */
export async function handleInteraction(interaction, context) {
  if (!interaction.isChatInputCommand()) return;
  const sub = interaction.options.getSubcommand();

  if (interaction.commandName === 'vip') {
    if (sub === 'comprar') return handleComprar(interaction, context);
    if (sub === 'estado') return handleEstado(interaction, context);
    if (sub === 'cancelar') return handleCancelar(interaction, context);
    if (sub === 'precios') {
      return interaction.reply({ embeds: [pricesEmbed(context.config)], flags: MessageFlags.Ephemeral });
    }
    return undefined;
  }

  if (interaction.commandName === 'vip-admin') {
    if (!isAdmin(interaction, context.config)) {
      return interaction.reply({
        content: 'No tienes permiso para usar este comando.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'confirmar') return handleAdminConfirmar(interaction, context);
    if (sub === 'buscar') return handleAdminBuscar(interaction, context);
    if (sub === 'pendientes') return handleAdminPendientes(interaction, context);
    if (sub === 'cancelar') return handleAdminCancelar(interaction, context);
    if (sub === 'sincronizar') return handleAdminSincronizar(interaction, context);
    return undefined;
  }

  return undefined;
}
