import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
} from 'discord.js';
import {
  TIER_NAMES,
  availableTiers,
  formatMoney,
  includedTiers,
  tierPerks,
  tierTitle,
} from '../lib/tiers.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { createSubscriptionCheckout } from '../payments/stripe.js';
import { normalizeCode } from '../lib/codes.js';
import { SUBSCRIPTION_STATUS, daysLeft } from '../lib/subscriptions.js';
import { ORDER_STATUS, createOrder, expireStaleOrders } from './orders.js';
import { processPayment } from './paymentFlow.js';
import { grantTierRoles, revokeTierRoles } from './roles.js';
import {
  activeSubscriptions,
  endSubscription,
  planAdoption,
  upsertSubscription,
} from './subscriptions.js';
import { sendDm, sendLog } from './notify.js';
import { computeStats } from './stats.js';
import { TICKET_CLOSE, TICKET_OPEN, closeTicket, openTicket, panelMessage } from './tickets.js';

const commandLog = createLogger('commands');

export function buildCommands(config) {
  // Only tiers with a role configured can be bought; the rest read as "coming soon".
  const sellable = availableTiers(config.tiers);
  const tierChoices = (sellable.length > 0 ? sellable : [1, 2, 3]).map((tier) => ({
    name: `${tierTitle(tier, config.tiers)} — ${formatMoney(config.tiers[tier].priceCents)}`,
    value: tier,
  }));

  const vip = new SlashCommandBuilder()
    .setName('vip')
    .setDescription('Buy and check your VIP membership')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Buy VIP access — card subscription or Zelle')
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
    // Discord can only gate a command's visibility on permission bits, not on a
    // role. Once VIP_MOD_ROLE_IDS names the mod roles, hiding it behind Manage
    // Roles would stop those very mods from seeing it — so the code check
    // becomes the authority and anyone else is turned away when they try.
    .setDefaultMemberPermissions(
      config.modRoleIds.length > 0 ? null : PermissionFlagsBits.ManageRoles,
    )
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
    )
    .addSubcommand((sub) =>
      sub.setName('members').setDescription('List active VIP memberships and when they expire'),
    )
    .addSubcommand((sub) =>
      sub.setName('panel').setDescription('Post the ticket panel members click when a payment is missing'),
    )
    .addSubcommand((sub) =>
      sub.setName('stats').setDescription('Members, revenue and who is about to expire'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('notify')
        .setDescription('DM a tier that their membership period is running, with their expiry date')
        .addIntegerOption((option) =>
          option
            .setName('tier')
            .setDescription('Tier to notify')
            .setRequired(true)
            .addChoices(...tierChoices),
        )
        .addStringOption((option) =>
          option.setName('note').setDescription('Extra line to include in the DM').setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName('resend')
            .setDescription('Send again to members already notified (default: skip them)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('adopt')
        .setDescription('Start tracking members who already hold a tier role but have no membership')
        .addIntegerOption((option) =>
          option
            .setName('tier')
            .setDescription('Tier whose role holders should be adopted')
            .setRequired(true)
            .addChoices(...tierChoices),
        )
        .addIntegerOption((option) =>
          option.setName('days').setDescription('Days to give them (defaults to the usual period)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('grant')
        .setDescription('Give someone a membership without a payment (migrations, comps)')
        .addUserOption((option) =>
          option.setName('user').setDescription('Member to grant').setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('tier')
            .setDescription('Tier to grant')
            .setRequired(true)
            .addChoices(...tierChoices),
        )
        .addIntegerOption((option) =>
          option.setName('days').setDescription('Days of access (defaults to the usual period)').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('Why (kept in the log)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke')
        .setDescription('End a membership now and take the roles back')
        .addUserOption((option) =>
          option.setName('user').setDescription('Member to revoke').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('Why (kept in the log)').setRequired(false),
        ),
    );

  return [vip.toJSON(), admin.toJSON()];
}

/**
 * Who may run /vip-admin.
 *
 * With VIP_MOD_ROLE_IDS configured, only those roles qualify — having "Manage
 * Roles" is deliberately not enough any more. Administrator still passes, so a
 * server owner cannot lock themselves out of their own bot.
 */
function isMod(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

  if (config.modRoleIds.length > 0) {
    return config.modRoleIds.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  }

  // Not configured yet: fall back to the Discord permission so the bot is usable.
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
}

function statusLabel(status) {
  return {
    [ORDER_STATUS.PENDING]: '⏳ pending',
    [ORDER_STATUS.PAID]: '✅ paid',
    [ORDER_STATUS.CANCELLED]: '🚫 cancelled',
    [ORDER_STATUS.EXPIRED]: '⌛ expired',
  }[status] ?? status;
}

function pricesEmbed(config, cardEnabled) {
  const sellable = availableTiers(config.tiers);
  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('👑 KING T PARLAYS — VIP access')
    .setDescription(
      `Every tier includes everything below it. Each one is a **${config.subscriptionDays}-day membership**.\n` +
        'Buy with `/vip buy` — you get a private code and the roles land automatically.',
    )
    .addFields(
      [1, 2, 3].map((tier) => {
        const open = sellable.includes(tier);
        const perks = tierPerks(tier, config.tiers);
        return {
          name: `${open ? '' : '🔒 '}${tierTitle(tier, config.tiers)} — ${formatMoney(config.tiers[tier].priceCents)} / ${config.subscriptionDays} days`,
          value: open ? perks : `${perks}\n\n*Coming soon — not on sale yet.*`,
        };
      }),
    )
    .setFooter({
      text: cardEnabled
        ? 'Card or Zelle · renew before it runs out and your days stack — you never lose time'
        : '💳 Card and 💸 Venmo coming soon · for now it is Zelle · your days stack when you renew early',
    });
}

/**
 * The card block, shown only once Stripe can actually take a payment. While it
 * is off the method is advertised by comingSoonSection instead — a block that
 * told people to press a button that is not rendered would just confuse them.
 */
export function cardSection(cardEnabled, config, amountCents) {
  if (!cardEnabled) return [];
  return [
    '**💳 Card — pays itself**',
    `Use the button below. **${formatMoney(amountCents)} every ${config.subscriptionDays} days**, charged automatically until you cancel, so you never lose access by forgetting.`,
    '',
  ];
}

/**
 * Teases the payment methods that are not live yet, so members know they are
 * coming instead of wondering why everyone else mentions them. Each line
 * disappears by itself the moment that method is configured.
 */
export function comingSoonSection(config, cardEnabled) {
  const soon = [];
  if (!cardEnabled) soon.push('💳 **Card** — charged automatically, nothing to remember');
  if (!config.venmoRecipient) soon.push('💸 **Venmo**');
  if (soon.length === 0) return [];
  return ['', '**⏭️ Coming soon**', ...soon.map((line) => `> ${line}`)];
}

/**
 * The manual payment methods on offer. Zelle and Venmo behave identically —
 * one payment, identified by the code in the note — so they share one block of
 * instructions. A method with no handle configured is simply not shown.
 */
export function manualMethods(config) {
  const methods = [];
  if (config.zelleRecipient && !config.zelleRecipient.startsWith('(set ')) {
    methods.push({ emoji: '🏦', label: 'Zelle', handle: config.zelleRecipient, name: config.zelleRecipientName });
  }
  if (config.venmoRecipient) {
    methods.push({ emoji: '💸', label: 'Venmo', handle: config.venmoRecipient, name: config.venmoRecipientName });
  }
  return methods;
}

/** The instruction block shared by every manual method. */
export function manualSection(config, order) {
  const methods = manualMethods(config);
  if (methods.length === 0) return [];

  const heading =
    methods.length === 1
      ? `**${methods[0].emoji} ${methods[0].label} — one payment**`
      : `**${methods.map((method) => `${method.emoji} ${method.label}`).join(' or ')} — one payment**`;

  return [
    heading,
    `**1.** Send **${formatMoney(order.amountCents)}** to:`,
    ...methods.map(
      (method) => `> ${method.emoji} **${method.label}:** \`${method.handle}\`${method.name ? ` (${method.name})` : ''}`,
    ),
    '**2.** Put **exactly** this code in the memo / note:',
    `> # ${order.code}`,
    `**3.** Done — the roles land by themselves. Covers **${config.subscriptionDays} days**, then you renew by hand.`,
  ];
}

/**
 * Opens a card checkout for this order, if Stripe is configured.
 * Card failures must never block the Zelle instructions, so this returns null
 * instead of throwing.
 */
async function cardCheckoutRow(stripe, config, order) {
  if (!stripe) return null;
  try {
    const session = await createSubscriptionCheckout(stripe, { config, order });
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(`Pay by card — ${formatMoney(order.amountCents)} every ${config.subscriptionDays} days`)
        .setEmoji('💳')
        .setURL(session.url),
    );
  } catch (error) {
    commandLog.error(`Could not open a Stripe checkout for ${order.code}: ${error.message}`);
    return null;
  }
}

async function handleBuy(interaction, { store, config, stripe }) {
  const tier = interaction.options.getInteger('tier');

  // Guards against a stale command registration still offering a locked tier.
  if (!availableTiers(config.tiers).includes(tier)) {
    await interaction.reply({
      content: `**${TIER_NAMES[tier]}** is not on sale yet — coming soon. Use \`/vip prices\` to see what is available.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Opening a Stripe checkout takes a moment; defer so Discord does not time out.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    .setColor(COLORS.gold)
    .setTitle(`${tierTitle(tier, config.tiers)} — ${formatMoney(order.amountCents)}`)
    .setDescription(
      [
        tierPerks(tier, config.tiers),
        '',
        ...cardSection(Boolean(stripe), config, order.amountCents),
        ...manualSection(config, order),
        ...comingSoonSection(config, Boolean(stripe)),
        '',
        `Includes: ${includedTiers(tier).map((level) => TIER_NAMES[level]).join(', ')}`,
        `This code expires ${time(Math.floor(order.expiresAt / 1000), 'R')}.`,
      ].join('\n'),
    )
    .setFooter({
      text: 'Without the code in the memo the payment cannot be matched automatically.',
    });

  const cardRow = await cardCheckoutRow(stripe, config, order);

  await interaction.editReply({
    embeds: [embed],
    components: cardRow ? [cardRow] : [],
    content: existing ? 'You already had an open order for this tier, so here is its code again:' : undefined,
  });
}

async function handleStatus(interaction, { store, config }) {
  expireStaleOrders(store);
  const subscription = store.getSubscription(interaction.guildId, interaction.user.id);
  const orders = store
    .listOrders((order) => order.userId === interaction.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  if (!subscription && orders.length === 0) {
    await interaction.reply({
      content: 'You have no membership yet. Use `/vip buy` to get started.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('Your VIP membership');

  if (subscription?.status === SUBSCRIPTION_STATUS.ACTIVE) {
    const left = daysLeft(subscription, Date.now());
    embed.setColor(left <= 3 ? COLORS.pending : COLORS.success).addFields({
      name: `✅ ${TIER_NAMES[subscription.tier]} — active`,
      value:
        `Expires ${time(Math.floor(subscription.expiresAt / 1000), 'R')} (${time(Math.floor(subscription.expiresAt / 1000), 'f')})\n` +
        `${left} day${left === 1 ? '' : 's'} left of your ${config.subscriptionDays}-day period.\n` +
        `Renew any time with \`/vip buy tier:${subscription.tier}\` — the days stack on top of what is left.`,
    });
  } else if (subscription) {
    embed.setColor(COLORS.warning).addFields({
      name: `⌛ ${TIER_NAMES[subscription.tier]} — ${subscription.status}`,
      value: `Ended ${time(Math.floor((subscription.endedAt ?? subscription.expiresAt) / 1000), 'R')}. Use \`/vip buy\` to come back.`,
    });
  }

  if (orders.length > 0) {
    embed.addFields({
      name: 'Recent orders',
      value: orders
        .map(
          (order) =>
            `\`${order.code}\` · ${TIER_NAMES[order.tier]} · ${statusLabel(order.status)} · ${formatMoney(order.amountCents)}`,
        )
        .join('\n'),
    });
  }

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
    .setColor(COLORS.info)
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
        .setColor(COLORS.pending)
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

/** Members open tickets from a button; mods close them from another. */
async function handleButton(interaction, context) {
  if (interaction.customId === TICKET_OPEN) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await openTicket(interaction, context);
      await interaction.editReply(
        result.status === 'already_open'
          ? `You already have a ticket open: <#${result.threadId}>`
          : `Ticket opened: <#${result.threadId}> — the team has been notified.`,
      );
    } catch (error) {
      commandLog.error(`Could not open a ticket for ${interaction.user.tag}: ${error.message}`);
      await interaction.editReply(
        'Could not open the ticket. Tell a mod — the bot may be missing the permission to create private threads here.',
      );
    }
    return undefined;
  }

  if (interaction.customId === TICKET_CLOSE) {
    if (!isMod(interaction, context.config)) {
      return interaction.reply({
        content: 'Only the mod team can close a ticket.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.reply({ content: `Closed by <@${interaction.user.id}>.` });
    await closeTicket(interaction, context);
    return undefined;
  }

  return undefined;
}

async function handleAdminPanel(interaction, { config }) {
  await interaction.channel.send(panelMessage(config));
  await interaction.editReply(
    'Panel posted. Pin it so members can find it, and make sure the bot can create private threads in this channel.',
  );
}

async function handleAdminStats(interaction, { store, config }) {
  const stats = computeStats(
    {
      subscriptions: store.listSubscriptions(),
      payments: store.data.payments,
      orders: store.listOrders(),
    },
    { guildId: interaction.guildId, tiers: config.tiers },
  );

  const tierLines = [1, 2, 3]
    .map((tier) => `${tierTitle(tier, config.tiers)} — **${stats.active.byTier[tier] ?? 0}**`)
    .join('\n');

  const sourceLines =
    Object.entries(stats.revenue.bySource)
      .sort((a, b) => b[1] - a[1])
      .map(([source, cents]) => `${source}: **${formatMoney(cents)}**`)
      .join(' · ') || 'nothing yet';

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('📊 VIP overview')
    .addFields(
      {
        name: `👥 Active members — ${stats.active.total}`,
        value: `${tierLines}\n${stats.active.autoRenewing} on card auto-renew`,
        inline: true,
      },
      {
        name: '💰 Revenue',
        value: [
          `Last 7 days: **${formatMoney(stats.revenue.last7dCents)}**`,
          `Last 30 days: **${formatMoney(stats.revenue.last30dCents)}**`,
          `All time: **${formatMoney(stats.revenue.allTimeCents)}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📈 Worth per period',
        value:
          `**${formatMoney(stats.monthlyValueCents)}** if every active member renews\n` +
          `${stats.payments.last30d} payment(s) in the last 30 days`,
      },
      {
        name: `⏳ Expiring within ${stats.expiringSoon.days} days — ${stats.expiringSoon.count}`,
        value:
          stats.expiringSoon.count === 0
            ? 'Nobody, everyone has time left.'
            : stats.expiringSoon.members
                .slice(0, 10)
                .map(
                  (subscription) =>
                    `<@${subscription.userId}> · ${TIER_NAMES[subscription.tier]} · ${time(Math.floor(subscription.expiresAt / 1000), 'R')}`,
                )
                .join('\n'),
      },
      { name: '💳 Last 30 days by method', value: sourceLines, inline: true },
      {
        name: '📋 Other',
        value: `${stats.pendingOrders} unpaid order(s)\n${stats.lost30d} membership(s) lost in 30 days`,
        inline: true,
      },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleAdminMembers(interaction, { store, config }) {
  const active = activeSubscriptions(store).sort((a, b) => a.expiresAt - b.expiresAt);

  if (active.length === 0) {
    await interaction.editReply('Nobody has an active membership right now.');
    return;
  }

  const lines = active
    .slice(0, 25)
    .map(
      (subscription) =>
        `<@${subscription.userId}> · ${TIER_NAMES[subscription.tier]} · expires ${time(Math.floor(subscription.expiresAt / 1000), 'R')}` +
        `${subscription.renewals > 0 ? ` · ${subscription.renewals + 1} periods` : ''}`,
    );

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle(`Active memberships (${active.length})`)
        .setDescription(lines.join('\n'))
        .setFooter({
          text: `${config.subscriptionDays}-day memberships · roles are removed automatically when they run out`,
        }),
    ],
  });
}

async function handleAdminNotify(interaction, { store, config, client }) {
  const tier = interaction.options.getInteger('tier');
  const note = interaction.options.getString('note');
  const resend = interaction.options.getBoolean('resend') ?? false;

  const targets = activeSubscriptions(store).filter(
    (subscription) =>
      subscription.guildId === interaction.guildId &&
      subscription.tier === tier &&
      (resend || !subscription.startNoticeSentAt),
  );

  if (targets.length === 0) {
    await interaction.editReply(
      `Nobody to notify in **${TIER_NAMES[tier]}** — either there are no active members, or they have all been notified already (use \`resend:true\` to send again).`,
    );
    return;
  }

  await interaction.editReply(`Sending to ${targets.length} member(s)…`);

  let sent = 0;
  let closed = 0;

  for (const subscription of targets) {
    const expiresAt = Math.floor(subscription.expiresAt / 1000);
    const delivered = await sendDm(
      client,
      subscription.userId,
      new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle(`Your ${tierTitle(tier, config.tiers)} is active`)
        .setDescription(
          [
            note,
            note ? '' : null,
            `Your **${config.subscriptionDays}-day** period is running and ends ${time(expiresAt, 'F')} — ${time(expiresAt, 'R')}.`,
            '',
            'We will DM you before it runs out. If it is not renewed by then, the VIP roles come off automatically.',
            `Renew any time with \`/vip buy tier:${tier}\` — the days stack on top of what is left, so renewing early never costs you time.`,
            '',
            'Check your own dates whenever you want with `/vip status`.',
          ]
            .filter((line) => line !== null)
            .join('\n'),
        )
        .setTimestamp(),
    );

    if (delivered) sent += 1;
    else closed += 1;

    subscription.startNoticeSentAt = Date.now();
    store.putSubscription(subscription);

    // Opening many DM channels quickly is the fastest way to hit a rate limit.
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('Membership notice sent')
      .setDescription(`**${TIER_NAMES[tier]}** — ${sent} delivered, ${closed} with DMs closed`)
      .addFields({ name: 'By', value: `<@${interaction.user.id}>`, inline: true })
      .setTimestamp(),
  );

  await interaction.editReply(
    [
      `Done: **${sent}** member(s) notified in **${TIER_NAMES[tier]}**.`,
      closed > 0
        ? `**${closed}** could not be reached — their DMs are closed. They can still see their dates with \`/vip status\`.`
        : null,
      'Nobody is notified twice unless you pass `resend:true`.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function handleAdminAdopt(interaction, { store, config, client }) {
  const tier = interaction.options.getInteger('tier');
  const days = interaction.options.getInteger('days') ?? config.subscriptionDays;
  const roleId = config.tiers[tier]?.roleId;

  if (!roleId) {
    await interaction.editReply(`Tier ${tier} has no role configured, so there is nobody to adopt.`);
    return;
  }

  const guild = await client.guilds.fetch(interaction.guildId);
  const members = await guild.members.fetch();

  const plan = planAdoption(
    [...members.values()].map((member) => ({
      id: member.id,
      isBot: member.user.bot,
      roleIds: [...member.roles.cache.keys()],
    })),
    {
      roleId,
      modRoleIds: config.modRoleIds,
      hasActiveSubscription: (userId) =>
        store.getSubscription(interaction.guildId, userId)?.status === SUBSCRIPTION_STATUS.ACTIVE,
    },
  );

  for (const userId of plan.adopt) {
    const subscription = upsertSubscription(store, {
      guildId: interaction.guildId,
      userId,
      tier,
      code: null,
      days,
    });
    subscription.source = 'migration';
    subscription.autoRenew = false;
    subscription.grantReason = `adopted by ${interaction.user.tag}`;
    store.putSubscription(subscription);
  }

  const until = Math.floor((Date.now() + days * 86400000) / 1000);

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('Existing role holders adopted')
      .setDescription(`${plan.adopt.length} member(s) now have a tracked **${TIER_NAMES[tier]}** membership`)
      .addFields(
        { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Days given', value: String(days), inline: true },
        { name: 'Until', value: time(until, 'f'), inline: true },
      )
      .setTimestamp(),
  );

  await interaction.editReply(
    [
      `**${plan.adopt.length}** member(s) adopted into **${TIER_NAMES[tier]}** — they now expire ${time(until, 'R')} and will get the usual reminders.`,
      `Skipped: ${plan.skipped.tracked.length} already tracked, ${plan.skipped.staff.length} staff, ${plan.skipped.bots.length} bot(s).`,
      'Running this again is safe — anyone already tracked is left alone.',
    ].join('\n'),
  );
}

async function handleAdminGrant(interaction, { store, config, client }) {
  const user = interaction.options.getUser('user');
  const tier = interaction.options.getInteger('tier');
  const days = interaction.options.getInteger('days') ?? config.subscriptionDays;
  const reason = interaction.options.getString('reason') ?? `granted by ${interaction.user.tag}`;

  const guild = await client.guilds.fetch(interaction.guildId);
  let roles;
  try {
    roles = await grantTierRoles(guild, user.id, tier, config, reason);
  } catch (error) {
    await interaction.editReply(`Could not give the roles to <@${user.id}>: ${error.message}`);
    return;
  }

  const subscription = upsertSubscription(store, {
    guildId: interaction.guildId,
    userId: user.id,
    tier,
    code: null,
    days,
  });
  subscription.source = 'manual';
  subscription.autoRenew = false;
  subscription.grantReason = reason;
  store.putSubscription(subscription);

  const expiresAt = Math.floor(subscription.expiresAt / 1000);

  await sendDm(
    client,
    user.id,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(`You have ${tierTitle(tier, config.tiers)}`)
      .setDescription(
        [
          `Your access is active until ${time(expiresAt, 'F')} (${time(expiresAt, 'R')}).`,
          '',
          'We will remind you before it ends. Renew any time with `/vip buy` — the days stack on top of what is left.',
        ].join('\n'),
      )
      .setTimestamp(),
  );

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('Membership granted by hand')
      .setDescription(`<@${user.id}> received **${TIER_NAMES[tier]}**`)
      .addFields(
        { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Days', value: String(days), inline: true },
        { name: 'Until', value: time(expiresAt, 'f'), inline: true },
        { name: 'Reason', value: reason },
      )
      .setTimestamp(),
  );

  await interaction.editReply(
    `<@${user.id}> now has **${TIER_NAMES[tier]}** for ${days} days (${roles.added.length} role(s) added, ${roles.already.length} already held). They expire ${time(expiresAt, 'R')} like any other membership.`,
  );
}

async function handleAdminRevoke(interaction, { store, config, client }) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') ?? `revoked by ${interaction.user.tag}`;
  const subscription = store.getSubscription(interaction.guildId, user.id);

  if (!subscription || subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    await interaction.editReply(`<@${user.id}> has no active membership.`);
    return;
  }

  const guild = await client.guilds.fetch(interaction.guildId);
  const revoked = await revokeTierRoles(guild, user.id, subscription.tier, config, reason);
  endSubscription(store, subscription, { status: SUBSCRIPTION_STATUS.REVOKED, reason });

  await interaction.editReply(
    `Membership of <@${user.id}> (**${TIER_NAMES[subscription.tier]}**) revoked. ${revoked.removed.length} role(s) removed${revoked.absent ? ' — the user already left the server' : ''}.`,
  );
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
  if (interaction.isButton()) return handleButton(interaction, context);
  if (!interaction.isChatInputCommand()) return;
  const sub = interaction.options.getSubcommand();

  if (interaction.commandName === 'vip') {
    if (sub === 'buy') return handleBuy(interaction, context);
    if (sub === 'status') return handleStatus(interaction, context);
    if (sub === 'cancel') return handleCancel(interaction, context);
    if (sub === 'prices') {
      return interaction.reply({
        embeds: [pricesEmbed(context.config, Boolean(context.stripe))],
        flags: MessageFlags.Ephemeral,
      });
    }
    return undefined;
  }

  if (interaction.commandName === 'vip-admin') {
    if (!isMod(interaction, context.config)) {
      return interaction.reply({
        content: 'Only the mod team can use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'confirm') return handleAdminConfirm(interaction, context);
    if (sub === 'lookup') return handleAdminLookup(interaction, context);
    if (sub === 'pending') return handleAdminPending(interaction, context);
    if (sub === 'cancel') return handleAdminCancel(interaction, context);
    if (sub === 'sync') return handleAdminSync(interaction, context);
    if (sub === 'members') return handleAdminMembers(interaction, context);
    if (sub === 'stats') return handleAdminStats(interaction, context);
    if (sub === 'panel') return handleAdminPanel(interaction, context);
    if (sub === 'grant') return handleAdminGrant(interaction, context);
    if (sub === 'adopt') return handleAdminAdopt(interaction, context);
    if (sub === 'notify') return handleAdminNotify(interaction, context);
    if (sub === 'revoke') return handleAdminRevoke(interaction, context);
    return undefined;
  }

  return undefined;
}
