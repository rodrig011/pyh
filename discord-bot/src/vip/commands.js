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
    .setDescription('Buy and check your VIP membership')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Get your Zelle payment code')
        .addIntegerOption((option) =>
          option
            .setName('tier')
            .setDescription('VIP tier you want to buy')
            .setRequired(true)
            .addChoices(...tierChoices),
        ),
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Check your orders'))
    .addSubcommand((sub) => sub.setName('prices').setDescription('Show every tier and its price'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a pending order')
        .addStringOption((option) =>
          option.setName('code').setDescription('Code to cancel (if you have several)').setRequired(false),
        ),
    );

  const admin = new SlashCommandBuilder()
    .setName('vip-admin')
    .setDescription('VIP payment administration')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) =>
      sub
        .setName('confirm')
        .setDescription('Confirm a payment by hand and hand out the roles')
        .addStringOption((option) =>
          option.setName('code').setDescription('Order code').setRequired(true),
        )
        .addNumberOption((option) =>
          option
            .setName('amount')
            .setDescription('Amount received in dollars (defaults to the tier price)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('note').setDescription('Reference or name of who paid').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('lookup')
        .setDescription('Look up an order by code')
        .addStringOption((option) =>
          option.setName('code').setDescription('Order code').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('pending').setDescription('List the orders awaiting payment'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription("Cancel any user's order")
        .addStringOption((option) =>
          option.setName('code').setDescription('Order code').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('sync').setDescription('Check the Zelle mailbox right now'),
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
    [ORDER_STATUS.PENDING]: '⏳ pending',
    [ORDER_STATUS.PAID]: '✅ paid',
    [ORDER_STATUS.CANCELLED]: '🚫 cancelled',
    [ORDER_STATUS.EXPIRED]: '⌛ expired',
  }[status] ?? status;
}

function pricesEmbed(config) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('VIP tiers')
    .setDescription('Every tier includes the perks of all the tiers below it.')
    .addFields(
      [1, 2, 3].map((tier) => ({
        name: `${TIER_NAMES[tier]} — ${formatMoney(config.tiers[tier].priceCents)}`,
        value: `Grants: ${includedTiers(tier).map((level) => TIER_NAMES[level]).join(', ')}`,
      })),
    );
}

async function handleBuy(interaction, { store, config }) {
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
        `**1.** Send **${formatMoney(order.amountCents)}** via Zelle to:`,
        `> \`${config.zelleRecipient}\`${config.zelleRecipientName ? ` (${config.zelleRecipientName})` : ''}`,
        '',
        '**2.** Put **exactly** this code in the memo / note of the payment:',
        `> # ${order.code}`,
        '',
        '**3.** That is it. As soon as the payment lands the bot hands you the roles automatically.',
        '',
        `Includes: ${includedTiers(tier).map((level) => TIER_NAMES[level]).join(', ')}`,
        `This code expires ${time(Math.floor(order.expiresAt / 1000), 'R')}.`,
      ].join('\n'),
    )
    .setFooter({ text: 'Without the code in the memo the payment cannot be matched automatically.' });

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    content: existing ? 'You already had an open order for this tier, so here is its code again:' : undefined,
  });
}

async function handleStatus(interaction, { store }) {
  expireStaleOrders(store);
  const orders = store
    .listOrders((order) => order.userId === interaction.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);

  if (orders.length === 0) {
    await interaction.reply({
      content: 'You have no orders yet. Use `/vip buy` to get started.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Your orders')
    .addFields(
      orders.map((order) => ({
        name: `${order.code} — ${TIER_NAMES[order.tier]}`,
        value: `${statusLabel(order.status)} · ${formatMoney(order.amountCents)} · created ${time(Math.floor(order.createdAt / 1000), 'R')}`,
      })),
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCancel(interaction, { store, config }) {
  const raw = interaction.options.getString('code');
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
          ? `You have several pending orders, tell me which one: ${pending.map((item) => `\`${item.code}\``).join(', ')}`
          : 'I could not find a pending order of yours with that code.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  order.status = ORDER_STATUS.CANCELLED;
  store.putOrder(order);
  await interaction.reply({ content: `Order \`${order.code}\` cancelled.`, flags: MessageFlags.Ephemeral });
}

async function handleAdminConfirm(interaction, { store, config, client }) {
  const code = normalizeCode(interaction.options.getString('code'), {
    prefix: config.codePrefix,
    length: config.codeLength,
  });
  if (!code) {
    await interaction.editReply('That code is not in a valid format.');
    return;
  }

  const order = store.getOrder(code);
  if (!order) {
    await interaction.editReply(`There is no order with code \`${code}\`.`);
    return;
  }

  const amountOption = interaction.options.getNumber('amount');
  const amountCents = amountOption === null ? order.amountCents : Math.round(amountOption * 100);

  const result = await processPayment(client, store, config, {
    codes: [code],
    amountCents,
    senderName: interaction.options.getString('note') ?? `Confirmed by ${interaction.user.tag}`,
    source: 'manual',
    reference: `manual:${interaction.user.id}`,
    receivedAt: Date.now(),
  });

  if (result.status === 'granted') {
    await interaction.editReply(
      `Done: <@${order.userId}> received **${TIER_NAMES[result.tier]}** (roles: ${includedTiers(result.tier).map((level) => TIER_NAMES[level]).join(', ')}).`,
    );
  } else {
    await interaction.editReply(`Could not apply it: ${result.reason ?? result.status}`);
  }
}

async function handleAdminLookup(interaction, { store, config }) {
  const code = normalizeCode(interaction.options.getString('code'), {
    prefix: config.codePrefix,
    length: config.codeLength,
  });
  const order = code ? store.getOrder(code) : null;
  if (!order) {
    await interaction.editReply('I could not find that order.');
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Order ${order.code}`)
    .addFields(
      { name: 'User', value: `<@${order.userId}>`, inline: true },
      { name: 'Tier', value: TIER_NAMES[order.tier], inline: true },
      { name: 'Status', value: statusLabel(order.status), inline: true },
      { name: 'Price', value: formatMoney(order.amountCents), inline: true },
      { name: 'Created', value: time(Math.floor(order.createdAt / 1000), 'f'), inline: true },
      { name: 'Expires', value: time(Math.floor(order.expiresAt / 1000), 'f'), inline: true },
    );

  if (order.payment) {
    embed.addFields({
      name: 'Payment',
      value: [
        `Source: ${order.payment.source}`,
        `Amount: ${order.payment.amountCents ? formatMoney(order.payment.amountCents) : 'n/a'}`,
        `Sender: ${order.payment.senderName ?? 'n/a'}`,
        `Reference: ${order.payment.reference ?? 'n/a'}`,
      ].join('\n'),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleAdminPending(interaction, { store }) {
  expireStaleOrders(store);
  const pending = store
    .listOrders((order) => order.status === ORDER_STATUS.PENDING)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, 20);

  if (pending.length === 0) {
    await interaction.editReply('There are no pending orders.');
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`Pending orders (${pending.length})`)
        .setDescription(
          pending
            .map(
              (order) =>
                `\`${order.code}\` · <@${order.userId}> · ${TIER_NAMES[order.tier]} · ${formatMoney(order.amountCents)} · expires ${time(Math.floor(order.expiresAt / 1000), 'R')}`,
            )
            .join('\n'),
        ),
    ],
  });
}

async function handleAdminCancel(interaction, { store, config }) {
  const code = normalizeCode(interaction.options.getString('code'), {
    prefix: config.codePrefix,
    length: config.codeLength,
  });
  const order = code ? store.getOrder(code) : null;
  if (!order) {
    await interaction.editReply('I could not find that order.');
    return;
  }
  order.status = ORDER_STATUS.CANCELLED;
  store.putOrder(order);
  await interaction.editReply(`Order \`${order.code}\` from <@${order.userId}> cancelled.`);
}

async function handleAdminSync(interaction, { watcher }) {
  if (!watcher) {
    await interaction.editReply('The mailbox watcher is not running (check your IMAP settings).');
    return;
  }
  try {
    const result = await watcher.poll();
    await interaction.editReply(
      `Check finished: ${result.checked} new email(s), ${result.payments} payment(s) detected.`,
    );
  } catch (error) {
    await interaction.editReply(`The mailbox check failed: ${error.message}`);
  }
}

/** Routes every command interaction of the VIP bot. */
export async function handleInteraction(interaction, context) {
  if (!interaction.isChatInputCommand()) return;
  const sub = interaction.options.getSubcommand();

  if (interaction.commandName === 'vip') {
    if (sub === 'buy') return handleBuy(interaction, context);
    if (sub === 'status') return handleStatus(interaction, context);
    if (sub === 'cancel') return handleCancel(interaction, context);
    if (sub === 'prices') {
      return interaction.reply({ embeds: [pricesEmbed(context.config)], flags: MessageFlags.Ephemeral });
    }
    return undefined;
  }

  if (interaction.commandName === 'vip-admin') {
    if (!isAdmin(interaction, context.config)) {
      return interaction.reply({
        content: 'You do not have permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'confirm') return handleAdminConfirm(interaction, context);
    if (sub === 'lookup') return handleAdminLookup(interaction, context);
    if (sub === 'pending') return handleAdminPending(interaction, context);
    if (sub === 'cancel') return handleAdminCancel(interaction, context);
    if (sub === 'sync') return handleAdminSync(interaction, context);
    return undefined;
  }

  return undefined;
}
