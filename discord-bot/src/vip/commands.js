import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
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
import { ASSIGN_PREFIX, processPayment } from './paymentFlow.js';
import { grantTierRoles, revokeTierRoles } from './roles.js';
import {
  activeSubscriptions,
  endSubscription,
  planAdoption,
  upsertSubscription,
} from './subscriptions.js';
import { sendDm, sendLog } from './notify.js';
import { computeStats } from './stats.js';
import { TICKET_CLOSE, TICKET_OPEN, closeTicket, openTicket } from './tickets.js';
import { STATUS_BUTTON, storefrontMessage, tierFromButton } from './storefront.js';

const commandLog = createLogger('commands');

/**
 * The "let the rest of the channel see this" toggle.
 *
 * Admin answers are ephemeral by default, which is right for confirming a
 * payment and wrong for showing the numbers to the other mods — screenshotting
 * your own invisible reply is not a workflow. Off unless asked for, since these
 * replies carry member names and payment history.
 */
function withShare(sub) {
  return sub.addBooleanOption((option) =>
    option
      .setName('share')
      .setDescription('Post the answer in the channel so the other mods can see it')
      .setRequired(false),
  );
}

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
      withShare(sub
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
        )),
    )
    .addSubcommand((sub) =>
      withShare(sub
        .setName('lookup')
        .setDescription('Look up an order by code')
        .addStringOption((option) =>
          option.setName('code').setDescription('Order code').setRequired(true),
        )),
    )
    .addSubcommand((sub) =>
      withShare(sub.setName('pending').setDescription('List the orders awaiting payment')),
    )
    .addSubcommand((sub) =>
      withShare(sub
        .setName('cancel')
        .setDescription("Cancel any user's order")
        .addStringOption((option) =>
          option.setName('code').setDescription('Order code').setRequired(true),
        )),
    )
    .addSubcommand((sub) =>
      withShare(sub.setName('sync').setDescription('Check the Zelle mailbox right now')),
    )
    .addSubcommand((sub) =>
      withShare(sub.setName('members').setDescription('List active VIP memberships and when they expire')),
    )
    .addSubcommand((sub) =>
      sub.setName('panel').setDescription('Post the ticket panel members click when a payment is missing'),
    )
    .addSubcommand((sub) =>
      withShare(sub.setName('stats').setDescription('Members, revenue and who is about to expire')),
    )
    .addSubcommand((sub) =>
      withShare(sub
        .setName('preview')
        .setDescription('DM yourself the exact welcome message new members get')),
    )
    .addSubcommand((sub) =>
      withShare(sub
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
        )),
    )
    .addSubcommand((sub) =>
      withShare(sub
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
        )),
    )
    .addSubcommand((sub) =>
      withShare(sub
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
        )),
    )
    .addSubcommand((sub) =>
      withShare(sub
        .setName('revoke')
        .setDescription('End a membership now and take the roles back')
        .addUserOption((option) =>
          option.setName('user').setDescription('Member to revoke').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('Why (kept in the log)').setRequired(false),
        )),
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
    // Some banks forward the memo and some do not, and the buyer cannot tell
    // which theirs is. Saying the name is what identifies them keeps them from
    // assuming the code alone did the job when their bank quietly dropped it.
    ...(order.payerName
      ? [
          `**3.** Pay from the account under **${order.payerName}** — that is how you are recognised if your bank does not pass the note along.`,
          `**4.** Done — the roles land by themselves. Covers **${config.subscriptionDays} days**, then you renew by hand.`,
        ]
      : [
          `**3.** Done — the roles land by themselves. Covers **${config.subscriptionDays} days**, then you renew by hand.`,
        ]),
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

/**
 * The purchase instructions for one tier.
 *
 * Shared by the slash command and the storefront buttons — and the buttons work
 * in a DM, where interaction.guildId is null, so the guild falls back to the one
 * this bot serves.
 */
export const NAME_MODAL_PREFIX = 'vip:name:';
const NAME_FIELD = 'payerName';

/**
 * Asks who the payment will come from.
 *
 * Banks that drop the memo still name the payer, so this one answer is what
 * lets a codeless alert be matched back to a buyer without anyone stepping in.
 * It is asked at the only moment the buyer is already stopped and paying
 * attention: the instant they choose a tier.
 */
export function payerNameModal(tier, config) {
  return new ModalBuilder()
    .setCustomId(`${NAME_MODAL_PREFIX}${tier}`)
    .setTitle(`${config.tiers[tier]?.label ?? `Tier ${tier}`} — one quick thing`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(NAME_FIELD)
          .setLabel('Name on your Zelle / bank account')
          .setPlaceholder('e.g. Christopher Swails')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(60)
          .setRequired(true),
      ),
    );
}

async function buyResponse(interaction, { store, config, stripe }, tier, payerName = null) {
  const guildId = interaction.guildId ?? config.guildId;
  expireStaleOrders(store);

  const existing = store
    .pendingOrdersFor(interaction.user.id)
    .find((order) => order.tier === tier && order.guildId === guildId);

  // A buyer coming back with a different name gets it recorded: an order that
  // cannot be matched is worse than one whose name changed.
  if (existing && payerName && existing.payerName !== payerName) {
    existing.payerName = payerName;
    store.putOrder(existing);
  }

  const order =
    existing ??
    createOrder(store, {
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      guildId,
      tier,
      payerName,
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

  return {
    embeds: [embed],
    components: cardRow ? [cardRow] : [],
    content: existing ? 'You already had an open order for this tier, so here is its code again:' : undefined,
  };
}

async function handleBuy(interaction, context) {
  const tier = interaction.options.getInteger('tier');

  // Guards against a stale command registration still offering a locked tier.
  if (!availableTiers(context.config.tiers).includes(tier)) {
    await interaction.reply({
      content: `**${TIER_NAMES[tier]}** is not on sale yet — coming soon. Use \`/vip prices\` to see what is available.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The modal has to be the first reply to the interaction, so it comes before
  // any deferral. Its submission carries on where this leaves off.
  await interaction.showModal(payerNameModal(tier, context.config));
}

/** The buyer answered "who is paying?" — now create the order and hand out the code. */
async function handleNameModal(interaction, context) {
  const tier = Number(interaction.customId.slice(NAME_MODAL_PREFIX.length));
  if (!availableTiers(context.config.tiers).includes(tier)) {
    await interaction.reply({
      content: `**${TIER_NAMES[tier]}** is not on sale yet.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const payerName = interaction.fields.getTextInputValue(NAME_FIELD)?.trim() || null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buyResponse(interaction, context, tier, payerName));
}

async function handleStatus(interaction, { store, config }) {
  expireStaleOrders(store);
  const subscription = store.getSubscription(interaction.guildId ?? config.guildId, interaction.user.id);
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

/** Every button on the storefront and inside a ticket comes through here. */
async function handleButton(interaction, context) {
  const buyTier = tierFromButton(interaction.customId);
  if (buyTier !== null) {
    if (!availableTiers(context.config.tiers).includes(buyTier)) {
      return interaction.reply({
        content: `**${TIER_NAMES[buyTier]}** is not on sale yet — coming soon.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(payerNameModal(buyTier, context.config));
  }

  if (interaction.customId === STATUS_BUTTON) {
    return handleStatus(interaction, context);
  }

  if (interaction.customId === TICKET_OPEN) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await openTicket(interaction, context);
      await interaction.editReply(
        result.status === 'already_open'
          ? `You already have a ticket open: <#${result.channelId}>`
          : `Ticket opened: <#${result.channelId}> — the team has been notified.`,
      );
    } catch (error) {
      commandLog.error(`Could not open a ticket for ${interaction.user.tag}: ${error.stack ?? error.message}`);
      // Say what Discord actually refused: guessing at the cause sent people
      // chasing a permission that was already granted.
      await interaction.editReply(
        [
          'Could not open the ticket. Show a mod this message:',
          `> ${error.message}`,
          '',
          'The bot needs **Manage Channels**, and if a ticket category is configured it needs access to that category too.',
        ].join('\n'),
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
    await interaction.reply({
      content: `Closed by <@${interaction.user.id}> — this channel is deleted in a few seconds.`,
    });
    await closeTicket(interaction, context);
    return undefined;
  }

  return undefined;
}

/** Permissions the bot must hold in a channel before it can post the storefront. */
const PANEL_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
  { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
  { flag: PermissionFlagsBits.EmbedLinks, name: 'Embed Links' },
];

async function handleAdminPanel(interaction, { config }) {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.editReply('Run this inside the channel where the panel should live.');
    return;
  }

  // A "how to buy" channel is normally locked so members cannot post in it, and
  // that deny lands on the bot too. Naming the missing permission and the
  // channel beats a generic failure the mod has to guess at.
  const me = interaction.guild?.members?.me;
  const mine = me ? channel.permissionsFor(me) : null;
  const missing = mine
    ? PANEL_PERMISSIONS.filter((permission) => !mine.has(permission.flag)).map((p) => p.name)
    : [];

  if (missing.length > 0) {
    await interaction.editReply(
      [
        `I cannot post in ${channel}. Missing: **${missing.join('", "')}**.`,
        '',
        `Fix it in **${channel.name} → Edit Channel → Permissions → add the VIP bot's role**, turn those on, then run this again.`,
      ].join('\n'),
    );
    return;
  }

  try {
    await channel.send(storefrontMessage(config));
  } catch (error) {
    await interaction.editReply(
      [
        `Discord refused the post in ${channel}: **${error.message}**`,
        '',
        'Give the bot "Send Messages" and "Embed Links" on that channel specifically, then try again.',
      ].join('\n'),
    );
    return;
  }

  await interaction.editReply(
    'Panel posted — members buy and check their membership from the buttons, no commands needed. Pin it. ' +
      'The bot needs "Manage Channels" for the ticket button to work.',
  );
}

async function handleAdminStats(interaction, { store, config }) {
  const stats = computeStats(
    {
      subscriptions: store.listSubscriptions(),
      payments: store.data.payments,
      orders: store.listOrders(),
      welcomes: store.listWelcomes(),
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
      {
        name: `👋 New members reached — last 30 days`,
        value:
          stats.welcomes.last30d === 0
            ? 'Nobody has joined since the welcome DM was switched on.'
            : [
                `**${stats.welcomes.delivered}** of **${stats.welcomes.last30d}** got the welcome DM` +
                  (stats.welcomes.blocked > 0
                    ? `, **${stats.welcomes.blocked}** had DMs closed`
                    : ''),
                stats.welcomes.lastAt
                  ? `Last join: ${time(Math.floor(stats.welcomes.lastAt / 1000), 'R')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
      },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Sends the mod the same DM a new arrival gets. Reading the code is not proof
 * it arrives, and waiting for a stranger to join is not a test.
 */
async function handleAdminPreview(interaction, { config }) {
  if (!config.welcomeDm) {
    await interaction.editReply(
      'The welcome DM is switched off (`WELCOME_DM` is not `true`), so new members get nothing.',
    );
    return;
  }

  try {
    await interaction.user.send(
      storefrontMessage(config, { includeTicket: false, welcome: true }),
    );
  } catch (error) {
    await interaction.editReply(
      [
        `I could not DM you: **${error.message}**`,
        '',
        'Your own DMs are closed for this server — which is exactly what happens to some new members. ' +
          'Turn them on in Privacy Settings if you want to see the message.',
      ].join('\n'),
    );
    return;
  }

  await interaction.editReply(
    'Sent — check your DMs. That is exactly what someone sees when they join, buttons and all. ' +
      'Members with DMs closed get nothing, so `/vip-admin panel` in a public channel stays the backstop.',
  );
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

  // Answers "is automatic detection actually live?" without needing a real
  // payment to arrive first. A misconfigured watcher looks identical to a quiet
  // inbox, so the settings get reported before anything is read.
  const problems = watcher.diagnose();
  if (problems.length > 0) {
    await interaction.editReply(
      [
        '❌ **Automatic Zelle detection is OFF.** Payments have to be confirmed by hand with `/vip-admin confirm`.',
        '',
        ...problems.map((problem) => `• ${problem}`),
        '',
        'Fix these in the hosting dashboard, redeploy, then run this again.',
      ].join('\n'),
    );
    return;
  }

  try {
    const result = await watcher.poll();
    const lines = [
      `✅ **Automatic detection is live**, reading \`${watcher.imap.user}\` every ${watcher.imap.pollSeconds}s.`,
      `Check finished: ${result.checked} new email(s), ${result.payments} payment(s) detected.`,
    ];

    // Finding nothing is the complaint, not the answer. poll() only reads unread
    // mail and marks it seen, so a second run always looks empty — the mailbox
    // has to be re-read to show what is in it and why each message was refused.
    if (result.payments === 0) {
      const { total, seen } = await watcher.inspect();
      lines.push('', `**What is in the mailbox** (last ${watcher.imap.sinceDays} days: ${total} email(s))`);

      if (seen.length === 0) {
        lines.push(
          '_Nothing at all._ The alerts are not reaching this inbox — check that the bank sends them here, ' +
            'or set up forwarding from the account that does receive them.',
        );
      } else {
        for (const mail of seen) {
          const subject = (mail.subject || '(no subject)').slice(0, 60);
          if (!mail.isPayment) {
            lines.push(`❌ \`${mail.from}\` — ${subject}\n   ↳ ${mail.reason ?? 'not recognised as a payment'}`);
            continue;
          }

          lines.push(
            `✅ \`${mail.from}\` — ${subject} → **${formatMoney(mail.amountCents ?? 0)}**` +
              `, payer: ${mail.senderName ? `**${mail.senderName}**` : '**not found**'}` +
              `, codes: ${mail.codes.join(', ') || 'none'}` +
              `${mail.alreadyProcessed ? ' _(already handled)_' : ''}`,
          );

          // Without the payer name, matching by name cannot fire at all. The
          // bank's exact wording is what the parser has to be taught, so it is
          // put in front of whoever can act on it.
          if (mail.excerpt) {
            lines.push(`   ↳ no payer name in: _${mail.excerpt}_`);
          }
        }

        const nameless = seen.filter((mail) => mail.isPayment && !mail.senderName);
        lines.push(
          '',
          nameless.length > 0
            ? '⚠️ Alerts arrived with **no payer name**, so payments cannot be matched to a buyer by name — ' +
              'they will need a mod to assign them. Send the quoted wording above to whoever maintains the bot.'
            : 'If a real Zelle alert is listed with **Untrusted sender**, copy the address shown above ' +
              'into `IMAP_ALLOWED_SENDERS` — that is the one thing the bot cannot guess.',
        );
      }
    }

    const body = lines.join('\n');
    await interaction.editReply(body.length > 1900 ? `${body.slice(0, 1900)}\n…` : body);
  } catch (error) {
    const hints = {
      connect: 'Check `IMAP_HOST` and `IMAP_PORT`. For Gmail: `imap.gmail.com` on port `993`.',
      // Gmail dropped its enable/disable IMAP switch in January 2025 — IMAP is
      // always on now, so sending anyone to look for that setting wastes their
      // time on a control that no longer exists. On Gmail this is the password.
      auth:
        'Generate a **new app password** at `myaccount.google.com/apppasswords` ' +
        `(signed in as \`${watcher.imap.user}\`, with 2-Step Verification on) and update \`IMAP_PASSWORD\`. ` +
        'Note that an app password only works for the account that created it.',
      mailbox: `The mailbox \`${watcher.imap.mailbox}\` does not exist under that name. Try \`INBOX\`.`,
      search: 'The server refused the search. Lower `IMAP_SINCE_DAYS` and try again.',
    };

    // A raw "Command failed" sends people hunting for the wrong problem, so the
    // step that failed and the server's own words go in front.
    await interaction.editReply(
      [
        `❌ **The mailbox check failed** ${error.described ?? error.message}`,
        '',
        hints[error.stage] ??
          'If it mentions credentials, the app password is wrong or IMAP is off for that account.',
      ].join('\n'),
    );
  }
}

/**
 * A mod picking who a codeless payment belongs to. Grants the tier the amount
 * paid for and closes the record, so the same payment cannot be spent twice on
 * a message that stays clickable forever.
 */
async function handleAssignSelect(interaction, { store, config, client }) {
  if (!interaction.customId?.startsWith(ASSIGN_PREFIX)) return undefined;

  if (!isMod(interaction, config)) {
    return interaction.reply({
      content: 'Only the mods can assign payments.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const record = store.getUnassignedPayment(interaction.customId.slice(ASSIGN_PREFIX.length));
  if (!record) {
    return interaction.editReply('That payment is no longer on record.');
  }
  if (record.assignedTo) {
    return interaction.editReply(
      `Already assigned to <@${record.assignedTo}> — one payment, one membership.`,
    );
  }

  const userId = interaction.values[0];
  const guild = await client.guilds.fetch(config.guildId);

  let roles;
  try {
    roles = await grantTierRoles(guild, userId, record.tier, config);
  } catch (error) {
    return interaction.editReply(`Could not give <@${userId}> the roles: ${error.message}`);
  }

  store.markPaymentAssigned(record.id, userId);
  store.recordPayment({
    code: null,
    userId,
    tier: record.tier,
    amountCents: record.amountCents,
    source: record.source,
    senderName: record.senderName,
    reference: record.reference,
    at: Date.now(),
  });

  const subscription = upsertSubscription(store, {
    guildId: config.guildId,
    userId,
    tier: record.tier,
    days: config.subscriptionDays,
  });
  const expiresAt = Math.floor(subscription.expiresAt / 1000);

  await sendDm(
    client,
    userId,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('Payment confirmed!')
      .setDescription(
        [
          `Your payment of **${formatMoney(record.amountCents)}** is in.`,
          `You now have **${tierTitle(record.tier, config.tiers)}**.`,
          '',
          `This is a **${config.subscriptionDays}-day membership**, ending ${time(expiresAt, 'R')}.`,
        ].join('\n'),
      )
      .setTimestamp(),
  );

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('Payment assigned by hand')
      .setDescription(
        `<@${interaction.user.id}> gave <@${userId}> **${tierTitle(record.tier, config.tiers)}** ` +
          `for ${formatMoney(record.amountCents)} from ${record.senderName ?? 'an unnamed sender'}.`,
      )
      .setTimestamp(),
  );

  return interaction.editReply(
    `Done — <@${userId}> has **${tierTitle(record.tier, config.tiers)}** until ${time(expiresAt, 'f')}. ` +
      `Roles added: ${roles.added.length}, already had: ${roles.already.length}.`,
  );
}

/** Routes every command interaction of the VIP bot. */
export async function handleInteraction(interaction, context) {
  if (interaction.isButton()) return handleButton(interaction, context);
  if (interaction.isUserSelectMenu?.()) return handleAssignSelect(interaction, context);
  if (interaction.isModalSubmit?.() && interaction.customId?.startsWith(NAME_MODAL_PREFIX)) {
    return handleNameModal(interaction, context);
  }
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
    // Ephemeral unless the mod asked to show the room. Decided here, once, so
    // no handler can forget it — and off by default, since these replies carry
    // member names and payment history.
    const share = interaction.options.getBoolean('share') ?? false;
    await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });

    if (sub === 'confirm') return handleAdminConfirm(interaction, context);
    if (sub === 'lookup') return handleAdminLookup(interaction, context);
    if (sub === 'pending') return handleAdminPending(interaction, context);
    if (sub === 'cancel') return handleAdminCancel(interaction, context);
    if (sub === 'sync') return handleAdminSync(interaction, context);
    if (sub === 'members') return handleAdminMembers(interaction, context);
    if (sub === 'stats') return handleAdminStats(interaction, context);
    if (sub === 'panel') return handleAdminPanel(interaction, context);
    if (sub === 'preview') return handleAdminPreview(interaction, context);
    if (sub === 'grant') return handleAdminGrant(interaction, context);
    if (sub === 'adopt') return handleAdminAdopt(interaction, context);
    if (sub === 'notify') return handleAdminNotify(interaction, context);
    if (sub === 'revoke') return handleAdminRevoke(interaction, context);
    return undefined;
  }

  return undefined;
}
