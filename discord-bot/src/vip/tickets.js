import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  time,
} from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { SUBSCRIPTION_STATUS } from '../lib/subscriptions.js';
import { TIER_NAMES, formatMoney } from '../lib/tiers.js';
import { ORDER_STATUS } from './orders.js';

const log = createLogger('tickets');

export const TICKET_OPEN = 'vip:ticket:open';
export const TICKET_CLOSE = 'vip:ticket:close';

const MEMBER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

export function ticketKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** The public message members click on. Posted once, left pinned in a channel. */
export function panelMessage() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle('💳 Paid and waiting for your role?')
        .setDescription(
          [
            'If you sent a payment and your VIP role has not arrived, open a ticket and the team will sort it out.',
            '',
            '**Before you do:** most payments land on their own within a minute. Check `/vip status` first — it shows whether yours went through.',
            '',
            'This opens a **private channel** that only you and the mods can see. It is deleted when the issue is closed.',
          ].join('\n'),
        )
        .setFooter({ text: 'Have your payment screenshot ready — it makes this much faster.' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(TICKET_OPEN)
          .setStyle(ButtonStyle.Primary)
          .setLabel('Open a payment ticket')
          .setEmoji('🎫'),
      ),
    ],
  };
}

/**
 * Who can see the ticket: the member who opened it, the mods, and nobody else.
 * @everyone is denied explicitly rather than relying on the category, so the
 * channel is private even if it ends up outside one.
 *
 * Discord refuses to let a bot grant a permission it does not hold itself, and
 * rejects the whole channel creation when you try — which reads as a confusing
 * "Missing Permissions" even though the bot can create channels fine. So the
 * grant is narrowed to what the bot actually has: the ticket still works, it
 * just hands out less.
 *
 * @param {import('discord.js').PermissionsBitField} [botPermissions]
 */
export function ticketPermissions(guild, userId, modRoleIds = [], botId, botPermissions) {
  const grantable = botPermissions
    ? MEMBER_PERMISSIONS.filter((permission) => botPermissions.has(permission))
    : MEMBER_PERMISSIONS;

  // Without these two a ticket is not a conversation, so keep them regardless
  // and let Discord complain plainly if the bot really cannot send messages.
  const allow =
    grantable.length > 0
      ? grantable
      : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: userId, allow },
  ];

  for (const roleId of modRoleIds) overwrites.push({ id: roleId, allow });
  if (botId) overwrites.push({ id: botId, allow });

  return overwrites;
}

/**
 * What the mods need in front of them the moment the ticket opens: who this is,
 * what they were told to pay, and whether the bot already knows about it.
 * Without this a ticket is just "help me" and someone has to go dig.
 */
export function memberContextEmbed(store, { guildId, userId }) {
  const subscription = store.getSubscription(guildId, userId);
  const orders = store
    .listOrders((order) => order.userId === userId && order.guildId === guildId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3);

  const membership =
    subscription?.status === SUBSCRIPTION_STATUS.ACTIVE
      ? `✅ **${TIER_NAMES[subscription.tier]}** until ${time(Math.floor(subscription.expiresAt / 1000), 'f')}`
      : subscription
        ? `⌛ ${TIER_NAMES[subscription.tier]} — ${subscription.status}`
        : '❌ no membership on record';

  const orderLines =
    orders.length > 0
      ? orders
          .map(
            (order) =>
              `\`${order.code}\` · ${TIER_NAMES[order.tier]} · ${formatMoney(order.amountCents)} · ${order.status}` +
              `${order.status === ORDER_STATUS.PENDING ? ` · expires ${time(Math.floor(order.expiresAt / 1000), 'R')}` : ''}`,
          )
          .join('\n')
      : 'No orders — this member never ran `/vip buy`.';

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Member details')
    .addFields(
      { name: 'Membership', value: membership },
      { name: 'Recent orders', value: orderLines },
      {
        name: 'To apply a payment',
        value:
          orders.length > 0
            ? `\`/vip-admin confirm code:${orders[0].code}\``
            : 'Ask them to run `/vip buy` first so there is a code to confirm.',
      },
    )
    .setFooter({ text: `User ID: ${userId}` });
}

/**
 * Opens a private channel for one member. Clicking twice returns the one they
 * already have — a second ticket just splits the conversation and hides half
 * the context from whoever picks it up.
 */
export async function openTicket(interaction, { store, config }) {
  const key = ticketKey(interaction.guildId, interaction.user.id);
  const existing = store.data.tickets?.[key];

  if (existing?.status === 'open') {
    const stillThere = await interaction.guild.channels.fetch(existing.channelId).catch(() => null);
    if (stillThere) return { status: 'already_open', channelId: existing.channelId };
  }

  const me = interaction.guild.members?.me ?? null;
  const channel = await interaction.guild.channels.create({
    name: `ticket-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId ?? undefined,
    permissionOverwrites: ticketPermissions(
      interaction.guild,
      interaction.user.id,
      config.modRoleIds,
      me?.id ?? interaction.client?.user?.id,
      me?.permissions,
    ),
    reason: `Payment ticket for ${interaction.user.tag}`,
  });

  const mentions = (config.modRoleIds ?? []).map((roleId) => `<@&${roleId}>`).join(' ');
  await channel.send({
    content: `${mentions} <@${interaction.user.id}> opened a payment ticket.`.trim(),
    allowedMentions: { roles: config.modRoleIds ?? [], users: [interaction.user.id] },
    embeds: [memberContextEmbed(store, { guildId: interaction.guildId, userId: interaction.user.id })],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(TICKET_CLOSE)
          .setStyle(ButtonStyle.Danger)
          .setLabel('Close and delete')
          .setEmoji('🔒'),
      ),
    ],
  });

  store.data.tickets = store.data.tickets ?? {};
  store.data.tickets[key] = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: channel.id,
    status: 'open',
    openedAt: Date.now(),
  };
  store.save();

  log.info(`Ticket opened by ${interaction.user.tag} (#${channel.id})`);
  return { status: 'opened', channelId: channel.id };
}

/**
 * Deletes the channel. The delay is so the "closing" message is actually seen
 * rather than vanishing with the channel the instant a mod clicks.
 */
export async function closeTicket(interaction, { store, config }, { delayMs = 5000 } = {}) {
  const channel = interaction.channel;
  const entry = Object.values(store.data.tickets ?? {}).find((ticket) => ticket.channelId === channel.id);

  if (entry) {
    entry.status = 'closed';
    entry.closedAt = Date.now();
    entry.closedBy = interaction.user.id;
    store.save();
  }

  const remove = async () => {
    try {
      await channel.delete(`Ticket closed by ${interaction.user.tag}`);
      log.info(`Ticket channel ${channel.id} deleted`);
    } catch (error) {
      log.error(`Could not delete the ticket channel ${channel.id}: ${error.message}`);
    }
  };

  if (delayMs > 0) setTimeout(remove, delayMs).unref?.();
  else await remove();

  return { status: 'closed', channelId: channel.id };
}
