import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, time } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { SUBSCRIPTION_STATUS } from '../lib/subscriptions.js';
import { TIER_NAMES, formatMoney } from '../lib/tiers.js';
import { ORDER_STATUS } from './orders.js';

const log = createLogger('tickets');

export const TICKET_OPEN = 'vip:ticket:open';
export const TICKET_CLOSE = 'vip:ticket:close';

export function ticketKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** The public message members click on. Posted once, left pinned in a channel. */
export function panelMessage(config) {
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
            'Opening a ticket creates a **private thread** where only you and the mods can see it.',
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
 * What the mods need in front of them the moment the ticket opens: who this is,
 * what they were told to pay, and whether the bot already knows about it.
 * Without this a ticket is just "help me" and someone has to go dig.
 */
export function memberContextEmbed(store, { guildId, userId, config }) {
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
 * Opens a private thread for one member. Returns the existing one instead of a
 * second thread if they click twice — a duplicate ticket just splits the
 * conversation and hides half the context from whoever picks it up.
 */
export async function openTicket(interaction, { store, config }) {
  const key = ticketKey(interaction.guildId, interaction.user.id);
  const existing = store.data.tickets?.[key];

  if (existing?.status === 'open') {
    const stillThere = await interaction.guild.channels.fetch(existing.threadId).catch(() => null);
    if (stillThere && !stillThere.archived) {
      return { status: 'already_open', threadId: existing.threadId };
    }
  }

  const thread = await interaction.channel.threads.create({
    name: `payment-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 1440,
    reason: `Payment ticket for ${interaction.user.tag}`,
  });

  await thread.members.add(interaction.user.id);

  const mentions = (config.modRoleIds ?? []).map((roleId) => `<@&${roleId}>`).join(' ');
  await thread.send({
    content: `${mentions} <@${interaction.user.id}> opened a payment ticket.`.trim(),
    allowedMentions: { roles: config.modRoleIds ?? [], users: [interaction.user.id] },
    embeds: [memberContextEmbed(store, { guildId: interaction.guildId, userId: interaction.user.id, config })],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(TICKET_CLOSE)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('Close ticket')
          .setEmoji('🔒'),
      ),
    ],
  });

  store.data.tickets = store.data.tickets ?? {};
  store.data.tickets[key] = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    threadId: thread.id,
    status: 'open',
    openedAt: Date.now(),
  };
  store.save();

  log.info(`Ticket opened by ${interaction.user.tag} (${thread.id})`);
  return { status: 'opened', threadId: thread.id };
}

/** Locks and archives the thread, and lets the member open a new one later. */
export async function closeTicket(interaction, { store }) {
  const thread = interaction.channel;
  const entry = Object.values(store.data.tickets ?? {}).find((ticket) => ticket.threadId === thread.id);

  if (entry) {
    entry.status = 'closed';
    entry.closedAt = Date.now();
    entry.closedBy = interaction.user.id;
    store.save();
  }

  await thread.setLocked(true).catch(() => {});
  await thread.setArchived(true).catch(() => {});
  log.info(`Ticket ${thread.id} closed by ${interaction.user.tag}`);
  return { status: 'closed' };
}
