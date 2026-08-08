import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
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
  isLifetime,
  tierHeading,
  tierPerks,
  tierTitle,
} from '../lib/tiers.js';
import { COLORS } from '../lib/brand.js';
import { postPermissionHelp } from '../lib/channelAccess.js';
import { createLogger } from '../lib/logger.js';
import { buildMessage } from '../lib/build.js';
import { signalPanelAction } from '../picks/signalPanel.js';
import { everyoneToNotify, migratedSubscriptions, planMigration } from './migrate.js';
import { handleSignalPanelButton } from '../picks/commands.js';
import { createSubscriptionCheckout } from '../payments/stripe.js';
import { buildEvidence, formatEvidence, money } from './evidence.js';
import { normalizeCode } from '../lib/codes.js';
import { SUBSCRIPTION_STATUS, daysLeft } from '../lib/subscriptions.js';
import { ORDER_STATUS, createOrder, expireStaleOrders } from './orders.js';
import { ASSIGN_PREFIX, processPayment } from './paymentFlow.js';
import { grantTierRoles, revokeTierRoles } from './roles.js';
import {
  activeSubscriptions,
  endSubscription,
  planAdoption,
  planIndividualAdoption,
  upsertSubscription,
} from './subscriptions.js';
import { sendDm, sendLog } from './notify.js';
import { computeStats } from './stats.js';
import { walletBalances } from './wallet.js';
import { TICKET_CLOSE, TICKET_OPEN, closeTicket, openTicket } from './tickets.js';
import { STATUS_BUTTON, storefrontMessage, tierFromButton } from './storefront.js';
import {
  SETTLE_PREFIX,
  buildPickCommands,
  handleCall,
  handleFollowButton,
  handlePanelButton,
  handlePickAutocomplete,
  handleSizeButton,
  handleSizeModal,
  handleVoteButton,
  handlePicks,
  handleSettleButton,
} from '../picks/commands.js';
import { FOLLOW_PREFIX, PANEL_PREFIX, SIZE_MODAL, SIZE_PREFIX, VOTE_PREFIX } from '../picks/panel.js';

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
    // Installable onto a user account, not just the server. Discord will not
    // let anyone DM a bot they share no server with, so without this a poster
    // saying "DM the bot to join" is an instruction nobody can follow — they
    // would have to join first, which is the thing being sold.
    .setIntegrationTypes([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    ])
    .setContexts([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ])
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
      withShare(sub.setName('stripe').setDescription('Check whether card payments are actually live')),
    )
    .addSubcommand((sub) =>
      withShare(sub
        .setName('evidence')
        .setDescription('Build the dispute evidence pack for a member (chargebacks)')
        .addUserOption((option) =>
          option.setName('user').setDescription('Who is disputing').setRequired(true),
        )),
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
      withShare(sub.setName('wallet').setDescription("Each team member's share of the revenue so far")),
    )
    .addSubcommand((sub) =>
      sub
        .setName('broadcast')
        .setDescription('DM every active member — you write the message')
        .addStringOption((option) =>
          option.setName('message').setDescription('What to send them').setRequired(true).setMaxLength(1800),
        )
        .addStringOption((option) =>
          option
            .setName('tiers')
            .setDescription('Which tiers, comma separated (default: all)'),
        )
        .addBooleanOption((option) =>
          option.setName('send').setDescription('False (default) previews it without sending'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('migrate')
        .setDescription('Move every membership to a different server before you switch over')
        .addStringOption((option) =>
          option.setName('to').setDescription('The new server ID').setRequired(true),
        )
        .addBooleanOption((option) =>
          option.setName('confirm').setDescription('False (default) previews it without moving'),
        ),
    )
    .addSubcommand((sub) =>
      withShare(
        sub
          .setName('version')
          .setDescription('Which build is actually running — check a deploy landed without a dashboard'),
      ),
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
        .setDescription('Start tracking somebody who already holds a tier role but has no membership')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('One person to adopt. Leave empty to sweep a whole tier')
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName('tier')
            .setDescription('Tier to give them. With a user, defaults to the highest role they hold')
            .setRequired(false)
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

  return [vip.toJSON(), admin.toJSON(), ...buildPickCommands(config)];
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
  const lifetime = isLifetime(config.subscriptionDays);
  const onlyTier = sellable.length === 1;

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`👑 ${config.brandName} — VIP access`)
    .setDescription(
      (lifetime
        ? 'One-time payment. Lifetime access — nothing to renew, ever.\n'
        : onlyTier
          ? `**${config.subscriptionDays}-day membership.**\n`
          : `Every tier includes everything below it. Each one is a **${config.subscriptionDays}-day membership**.\n`) +
        'Buy with `/vip buy` — you get a private code and the roles land automatically.',
    )
    .addFields(
      sellable.map((tier) => {
        const perks = tierPerks(tier, config.tiers);
        const price = formatMoney(config.tiers[tier].priceCents);
        return {
          name: `${tierHeading(tier, config.tiers, { onlyTier })} — ${lifetime ? price : `${price} / ${config.subscriptionDays} days`}`,
          value: perks,
        };
      }),
    )
    .setFooter({
      text: lifetime
        ? 'One payment, access for good — nothing to renew'
        : cardEnabled
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
/**
 * The pay-by-hand options, and which of them the bot can actually see.
 *
 * Zelle arrives as an email the bot reads, so those grant access on their own.
 * Venmo and Cash App send nothing it can watch — a mod confirms them. Both are
 * still offered, because a payment method somebody already has beats a better
 * one they have to sign up for — but the difference has to reach the buyer, or
 * they sit waiting for roles that were never coming without a human.
 */
export function manualMethods(config) {
  const methods = [];
  if (config.zelleRecipient && !config.zelleRecipient.startsWith('(set ')) {
    methods.push({
      emoji: '🏦',
      label: 'Zelle',
      handle: config.zelleRecipient,
      name: config.zelleRecipientName,
      automatic: true,
    });
  }
  if (config.venmoRecipient) {
    methods.push({
      emoji: '💸',
      label: 'Venmo',
      handle: config.venmoRecipient,
      name: config.venmoRecipientName,
      automatic: false,
    });
  }
  if (config.cashAppRecipient) {
    methods.push({
      emoji: '🟩',
      label: 'Cash App',
      handle: config.cashAppRecipient,
      name: config.cashAppRecipientName,
      automatic: false,
    });
  }
  return methods;
}

/** The instruction block shared by every manual method. */
export function manualSection(config, order) {
  const methods = manualMethods(config);
  if (methods.length === 0) return [];

  const named = methods.map((method) => `${method.emoji} ${method.label}`);
  const listed =
    named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} or ${named.at(-1)}`;
  const heading = `**${listed} — one payment**`;

  const anyAutomatic = methods.some((method) => method.automatic);
  const anyManual = methods.some((method) => !method.automatic);

  let step = 3;
  const closing = [];

  // Some banks forward the memo and some do not, and the buyer cannot tell
  // which theirs is. Saying the name is what identifies them keeps them from
  // assuming the code alone did the job when their bank quietly dropped it.
  if (order.payerName) {
    closing.push(
      `**${step++}.** Pay from the account under **${order.payerName}** — that is how you are recognised if the note does not come through.`,
    );
  }

  // Promising roles that "land by themselves" on a method nobody is watching
  // is how a paid member ends up waiting in silence. Each half says only what
  // is true of it.
  if (anyAutomatic && anyManual) {
    closing.push(
      `**${step++}.** **Zelle** lets you in on its own, usually within a minute. ` +
        '**Venmo and Cash App need a mod to check the payment** — you are let in as soon as one does. ' +
        'If it has been a while, hit **Payment problem** on the panel and a mod is pinged.',
    );
  } else if (anyManual) {
    closing.push(
      `**${step++}.** A mod checks the payment and lets you in. ` +
        'If it has been a while, hit **Payment problem** on the panel and a mod is pinged.',
    );
  } else {
    closing.push(`**${step++}.** Done — the roles land by themselves.`);
  }

  closing.push(`Covers **${config.subscriptionDays} days**, then you renew by hand.`);

  return [
    heading,
    `**1.** Send **${formatMoney(order.amountCents)}** to whichever you use:`,
    ...methods.map(
      (method) =>
        `> ${method.emoji} **${method.label}:** \`${method.handle}\`${method.name ? ` (${method.name})` : ''}` +
        (method.automatic ? '' : ' — checked by a mod'),
    ),
    '**2.** Put **exactly** this code in the memo / note:',
    `> # ${order.code}`,
    ...closing,
  ];
}

/**
 * Opens a card checkout for this order, if Stripe is configured.
 * Card failures must never block the Zelle instructions, so this returns null
 * instead of throwing.
 */
/** Discord's hard cap on a link button's URL. */
export const BUTTON_URL_MAX = 512;

async function cardCheckoutRow(stripe, config, order) {
  if (!stripe) return null;
  try {
    const session = await createSubscriptionCheckout(stripe, { config, order });

    // A Stripe Checkout URL carries its whole session in the fragment and runs
    // well past Discord's 512-character limit for a button. Discord rejects the
    // entire message for it, so the buyer got "Invalid Form Body" instead of
    // any way to pay at all — card *or* Zelle. A plain link has no such limit.
    if (session.url.length > BUTTON_URL_MAX) {
      return { row: null, url: session.url };
    }

    return {
      row: new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(`Pay by card — ${formatMoney(order.amountCents)} every ${config.subscriptionDays} days`)
          .setEmoji('💳')
          .setURL(session.url),
      ),
      url: session.url,
    };
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
/**
 * The placeholder is a guess, not a label. Discord's own display name is
 * often exactly what the bank has too — the buyer's actual name is a far
 * better hint than any fixed example, and it costs nothing to offer since the
 * modal already knows who is filling it in.
 */
export function payerNamePlaceholder(suggestedName) {
  return suggestedName
    ? `e.g. ${suggestedName} — or the exact name on your bank/Zelle if different`
    : 'Exactly as it appears on your bank or Zelle app';
}

export function payerNameModal(tier, config, { suggestedName = null } = {}) {
  return new ModalBuilder()
    .setCustomId(`${NAME_MODAL_PREFIX}${tier}`)
    .setTitle(`${config.tiers[tier]?.label ?? `Tier ${tier}`} — one quick thing`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(NAME_FIELD)
          .setLabel('Name on your Zelle / bank account')
          .setPlaceholder(payerNamePlaceholder(suggestedName))
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

  const checkout = await cardCheckoutRow(stripe, config, order);

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`${tierTitle(tier, config.tiers)} — ${formatMoney(order.amountCents)}`)
    .setDescription(
      [
        tierPerks(tier, config.tiers),
        '',
        ...cardSection(Boolean(checkout), config, order.amountCents),
        // Only when the button could not carry it. Shown right where the card
        // section promised one, so the instructions never point at nothing.
        ...(checkout && !checkout.row ? [`**[→ Pay by card](${checkout.url})**`, ''] : []),
        ...manualSection(config, order),
        ...comingSoonSection(config, Boolean(checkout)),
        '',
        `Includes: ${includedTiers(tier).map((level) => TIER_NAMES[level]).join(', ')}`,
        `This code expires ${time(Math.floor(order.expiresAt / 1000), 'R')}.`,
      ].join('\n'),
    )
    .setFooter({
      text: 'Without the code in the memo the payment cannot be matched automatically.',
    });

  return {
    embeds: [embed],
    components: checkout?.row ? [checkout.row] : [],
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
  const suggestedName = interaction.member?.displayName ?? interaction.user?.globalName ?? interaction.user?.username ?? null;
  await interaction.showModal(payerNameModal(tier, context.config, { suggestedName }));
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
    const lifetime = isLifetime(config.subscriptionDays);
    embed.setColor(!lifetime && left <= 3 ? COLORS.pending : COLORS.success).addFields({
      name: `✅ ${TIER_NAMES[subscription.tier]} — active`,
      value: lifetime
        ? 'Lifetime access — nothing to renew, ever.'
        : `Expires ${time(Math.floor(subscription.expiresAt / 1000), 'R')} (${time(Math.floor(subscription.expiresAt / 1000), 'f')})\n` +
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
    const suggestedName = interaction.member?.displayName ?? interaction.user?.globalName ?? interaction.user?.username ?? null;
    return interaction.showModal(payerNameModal(buyTier, context.config, { suggestedName }));
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

async function handleAdminPanel(interaction, { config }) {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.editReply('Run this inside the channel where the panel should live.');
    return;
  }

  const help = postPermissionHelp(channel, interaction.guild);
  if (help) {
    await interaction.editReply(help);
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

/**
 * "Did my fix actually ship?", answered from a phone.
 *
 * A push and a deploy are separate events, and from inside Discord they look
 * identical: a bug fixed an hour ago behaves exactly like a bug never fixed if
 * the container is still running last week's image. Answering that used to mean
 * opening a dashboard on a laptop, which is a strange dependency for a system
 * whose whole interface is a phone.
 */
async function handleAdminVersion(interaction) {
  // No deferReply here: the router already deferred, once, for every admin
  // subcommand. Deferring again throws "the reply to this interaction has
  // already been sent or deferred" and the member sees an error instead of
  // an answer.
  return interaction.editReply(buildMessage());
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

async function handleAdminWallet(interaction, { store, config }) {
  const wallet = walletBalances(store.data.payments, config.team);

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('💼 Team wallet')
    .setDescription(
      wallet.paidCount === 0
        ? 'No payments recorded yet.'
        : `Split evenly across **${config.team.length}** — ${wallet.paidCount} payment(s), ` +
            `**${formatMoney(wallet.totalCents)}** total.`,
    )
    .addFields(
      wallet.balances.map((member) => ({
        name: member.name ? `${member.name} (<@${member.id}>)` : `<@${member.id}>`,
        value: `**${formatMoney(member.cents)}**`,
        inline: true,
      })),
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Adopting one named member.
 *
 * The bulk sweep is the wrong tool for somebody verified by hand: it works off
 * a whole role, and it deliberately skips staff. Naming a person says the
 * checking already happened.
 */
async function adoptOne(interaction, { store, config, client }, { user, tier, days }) {
  const guild = await client.guilds.fetch(interaction.guildId);
  const member = await guild.members.fetch(user.id).catch(() => null);

  if (!member) {
    await interaction.editReply(`<@${user.id}> is not in this server.`);
    return;
  }

  const plan = planIndividualAdoption(
    { id: member.id, isBot: member.user.bot, roleIds: [...member.roles.cache.keys()] },
    {
      tiersConfig: config.tiers,
      tier,
      hasActiveSubscription: (userId) =>
        store.getSubscription(interaction.guildId, userId)?.status === SUBSCRIPTION_STATUS.ACTIVE,
    },
  );

  if (!plan.ok) {
    const said = {
      bot: 'That is a bot.',
      no_tier: `<@${user.id}> holds no tier role, so there is nothing to read. Pass **tier** to say which one they should get, or use \`/vip-admin grant\` to hand them the roles as well.`,
      unknown_tier: 'That tier is not configured.',
      already_tracked: `<@${user.id}> already has a tracked membership. \`/vip-admin members\` shows when it ends.`,
    }[plan.reason];
    await interaction.editReply(said ?? 'Nothing to do.');
    return;
  }

  const subscription = upsertSubscription(store, {
    guildId: interaction.guildId,
    userId: member.id,
    tier: plan.tier,
    code: null,
    days,
  });
  subscription.source = 'migration';
  subscription.autoRenew = false;
  subscription.grantReason = `adopted by hand by ${interaction.user.tag}`;
  store.putSubscription(subscription);

  const expiresAt = Math.floor(subscription.expiresAt / 1000);

  await sendLog(
    client,
    config,
    new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('Membership adopted by hand')
      .setDescription(
        `<@${interaction.user.id}> started tracking <@${member.id}> on **${tierTitle(plan.tier, config.tiers)}** ` +
          `for ${days} days${tier ? '' : ' (read from the role they already hold)'}.`,
      )
      .setTimestamp(),
  );

  await interaction.editReply(
    `<@${member.id}> is now tracked on **${tierTitle(plan.tier, config.tiers)}** until ${time(expiresAt, 'f')}` +
      `${tier ? '' : ' — read from the role they already hold'}. ` +
      'They get the usual reminders, and the roles come off if it is not renewed.',
  );
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
          text: isLifetime(config.subscriptionDays)
            ? 'Lifetime memberships · nothing to renew'
            : `${config.subscriptionDays}-day memberships · roles are removed automatically when they run out`,
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
            isLifetime(config.subscriptionDays)
              ? 'This is a **lifetime membership** — nothing to renew, ever.'
              : `Your **${config.subscriptionDays}-day** period is running and ends ${time(expiresAt, 'F')} — ${time(expiresAt, 'R')}.`,
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
  const user = interaction.options.getUser('user');

  if (user) return adoptOne(interaction, { store, config, client }, { user, tier, days });

  if (!tier) {
    await interaction.editReply(
      'Pick a **tier** to sweep, or a **user** to adopt on their own.',
    );
    return;
  }

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

/**
 * Whether card payments are genuinely live, checked rather than assumed.
 *
 * Stripe fails quietly in both directions: a key that is not set means no
 * button, and a webhook Stripe cannot reach means the money arrives and the
 * roles never do. Neither shows up in Discord, so this asks Stripe directly.
 */
/**
 * The paperwork for a card dispute, in the seven days the bank allows.
 *
 * Everything here was already recorded; it has just never been in one place,
 * and a mod digging through Discord history under a deadline will miss half of
 * it. Ephemeral by default — it carries payment references and the member's
 * whole history.
 */
async function handleAdminEvidence(interaction, { store, config }) {
  const user = interaction.options.getUser('user');
  const guildId = interaction.guildId ?? config.guildId;

  const evidence = buildEvidence(
    {
      subscription: store.getSubscription(guildId, user.id),
      payments: store.data.payments,
      picks: store.listPicks((pick) => pick.guildId === guildId),
      welcomes: store.listWelcomes(),
      votes: store.listVotes(),
      orders: store.listOrders(),
    },
    { userId: user.id },
  );

  const text = formatEvidence(evidence, {
    userTag: user.tag,
    productName: `${config.subscriptionDays}-day VIP membership`,
  });

  const embed = new EmbedBuilder()
    .setColor(evidence.weaknesses.length > 0 ? COLORS.warning : COLORS.success)
    .setTitle(`🧾 Dispute evidence — ${user.username}`)
    .setDescription(
      evidence.hasCase
        ? 'Paste the block below straight into Stripe → the disputed payment → **Submit evidence**.'
        : 'Nothing is on record for this member.',
    )
    .setTimestamp();

  if (evidence.hasCase) {
    embed.addFields(
      { name: 'Paid', value: money(evidence.totals.paidCents), inline: true },
      { name: 'Access', value: `${evidence.access.days} day(s)`, inline: true },
      { name: 'Signals delivered', value: String(evidence.delivery.calls), inline: true },
    );
  }

  // Weaknesses go in the Discord message and never in the text handed to the
  // bank. The mod needs to know the case is thin; the reviewer does not need
  // to be told where to push.
  if (evidence.weaknesses.length > 0) {
    embed.addFields({
      name: '⚠️ Where this is thin',
      value: evidence.weaknesses.map((line) => `• ${line}`).join('\n'),
    });
  }

  // Over Discord's limit the pack goes as a file rather than being cut off
  // halfway through the delivery record.
  const payload = { embeds: [embed] };
  if (evidence.hasCase) {
    if (text.length > 1900) {
      payload.files = [
        { attachment: Buffer.from(text, 'utf8'), name: `dispute-${user.id}.txt` },
      ];
    } else {
      payload.content = `\`\`\`\n${text}\n\`\`\``;
    }
  }

  await interaction.editReply(payload);
}

async function handleAdminStripe(interaction, { config, stripe }) {
  const lines = [];
  const settings = config.stripe;

  if (!settings.enabled) {
    lines.push('❌ `STRIPE_ENABLED` is not `true` — card payments are switched off.');
  }
  if (!settings.secretKey) {
    lines.push('❌ `STRIPE_SECRET_KEY` is not set.');
  }
  if (!settings.webhookSecret) {
    lines.push(
      '❌ `STRIPE_WEBHOOK_SECRET` is not set. Without it nothing can verify a payment, ' +
        'so the button stays off on purpose — a checkout nobody can verify takes money and grants nothing.',
    );
  }

  let account = null;
  if (stripe) {
    try {
      account = await stripe.accounts.retrieve();
      const live = !settings.secretKey.startsWith('sk_test');
      lines.push(
        `✅ Connected to **${account.business_profile?.name ?? account.id}** in ` +
          `**${live ? 'LIVE' : 'TEST'}** mode.`,
      );
      if (!account.charges_enabled) {
        lines.push(
          '⚠️ This account cannot take charges yet — Stripe still has it under review or needs more details.',
        );
      }
      if (!live) {
        lines.push('⚠️ Test mode: real cards will be declined. Swap to the `sk_live_` key when ready.');
      }
    } catch (error) {
      lines.push(`❌ Stripe refused the key: ${error.message}`);
    }
  } else if (settings.enabled && settings.secretKey && settings.webhookSecret) {
    lines.push('❌ The Stripe client failed to start. Check the boot logs.');
  }

  if (settings.webhookSecret) {
    lines.push(
      `ℹ️ Webhook endpoint: \`POST ${settings.webhookPath}\` on port \`${settings.port}\`. ` +
        'Stripe must be able to reach it over the public internet — on Railway that means the service ' +
        'needs a generated domain, and the endpoint URL in Stripe must end in that same path.',
    );
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(
          lines.some((line) => line.startsWith('❌'))
            ? COLORS.danger
            : lines.some((line) => line.startsWith('⚠️'))
              ? COLORS.warning
              : COLORS.success,
        )
        .setTitle('💳 Card payments')
        .setDescription(lines.join('\n\n'))
        .setTimestamp(),
    ],
  });
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
  if (interaction.isAutocomplete?.()) {
    return interaction.commandName === 'picks'
      ? handlePickAutocomplete(interaction, context)
      : undefined;
  }
  if (interaction.isButton() && interaction.customId?.startsWith(SETTLE_PREFIX)) {
    return handleSettleButton(interaction, context);
  }
  if (interaction.isButton() && interaction.customId?.startsWith(SIZE_PREFIX)) {
    return handleSizeButton(interaction, context);
  }
  // "This interaction failed" is Discord saying it got no answer within three
  // seconds — which looks identical whether the bot threw, stalled, or was not
  // running at all. One line per press tells those apart on the next restart
  // instead of on the next guess.
  if (interaction.isButton()) {
    commandLog.debug(`Button ${interaction.customId} from ${interaction.user?.tag}`);
  }

  // The signals panel. Every button is a shortcut to a command people would
  // otherwise type a hundred times a day, and each answers ephemerally so a
  // pinned panel does not become a thread.
  if (interaction.isButton() && signalPanelAction(interaction.customId)) {
    const action = signalPanelAction(interaction.customId);
    return handleSignalPanelButton(interaction, context, action);
  }

  if (interaction.isButton() && interaction.customId?.startsWith(FOLLOW_PREFIX)) {
    return handleFollowButton(interaction, context);
  }

  if (interaction.isButton() && interaction.customId?.startsWith(VOTE_PREFIX)) {
    return handleVoteButton(interaction, context);
  }
  if (interaction.isButton() && interaction.customId?.startsWith(PANEL_PREFIX)) {
    return handlePanelButton(interaction, context);
  }
  if (interaction.isButton()) return handleButton(interaction, context);
  if (interaction.isUserSelectMenu?.()) return handleAssignSelect(interaction, context);
  if (interaction.isModalSubmit?.() && interaction.customId?.startsWith(NAME_MODAL_PREFIX)) {
    return handleNameModal(interaction, context);
  }
  if (interaction.isModalSubmit?.() && interaction.customId?.startsWith(SIZE_MODAL)) {
    return handleSizeModal(interaction, context);
  }
  if (!interaction.isChatInputCommand()) return;

  // Routed before getSubcommand(), which throws on a command that has none.
  if (interaction.commandName === 'call') return handleCall(interaction, context);
  if (interaction.commandName === 'picks') return handlePicks(interaction, context);

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
    if (sub === 'stripe') return handleAdminStripe(interaction, context);
    if (sub === 'evidence') return handleAdminEvidence(interaction, context);
    if (sub === 'members') return handleAdminMembers(interaction, context);
    if (sub === 'stats') return handleAdminStats(interaction, context);
    if (sub === 'wallet') return handleAdminWallet(interaction, context);
    if (sub === 'version') return handleAdminVersion(interaction, context);
    if (sub === 'broadcast') return handleAdminBroadcast(interaction, context);
    if (sub === 'migrate') return handleAdminMigrate(interaction, context);
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

/**
 * One message to every active member, written by a person.
 *
 * The text is supplied rather than built here, and that is a deliberate
 * separation rather than laziness: whoever presses this owns what it says, and
 * a tool that composes claims on somebody's behalf makes it far too easy to
 * send something nobody read carefully. It is also the only version that is
 * useful twice — a server move, a price change, an outage.
 *
 * Previews by default. `send:True` is a second, deliberate act, because a
 * broadcast cannot be recalled: it is already in a thousand inboxes.
 *
 * Sent one at a time. Discord rate-limits direct messages hard, and a burst to
 * a whole membership is the fastest way to get a bot flagged — which would cost
 * the very access this message is probably about.
 */
async function handleAdminBroadcast(interaction, { store, config }) {
  // Discord's slash-command fields are single-line, so a message typed into one
  // arrives as a wall of text however it was composed. `\n` is accepted as an
  // escape and turned back into real breaks — the same trick the PEM key uses,
  // and for the same reason: the thing being pasted is multi-line and the box
  // is not.
  const message = (interaction.options.getString('message') ?? '').replace(/\\n/g, '\n');
  const send = interaction.options.getBoolean('send') ?? false;
  const rawTiers = interaction.options.getString('tiers');
  const tiers = rawTiers
    ? rawTiers.split(',').map((part) => Number(part.trim())).filter(Number.isFinite)
    : [1, 2, 3];

  // The ROLES are the truth of who is in the room.
  //
  // This used to read only the subscription store, and reached eleven people
  // out of hundreds — because the store knows about people who paid THROUGH
  // THIS BOT and nobody else. Everyone given a role by hand, or who paid before
  // the bot existed, or who paid the owner directly, has the role and no
  // record. From the store's point of view they were never members.
  const roleIds = tiers.map((tier) => config.tiers?.[tier]?.roleId).filter(Boolean);
  if (roleIds.length === 0) {
    return interaction.editReply(
      `❌ **No role is configured for tier ${tiers.join(', ')}.** Check \`ROLE_TIER_1/2/3\` on the host.`,
    );
  }

  const guild = await interaction.client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) return interaction.editReply('❌ Could not read this server.');

  // The full member list, not the cache. The cache holds whoever happened to
  // speak recently, which is a fraction of a paying room and is exactly how a
  // broadcast quietly reaches a handful of people.
  const members = await guild.members.fetch().catch(() => null);
  if (!members) {
    return interaction.editReply(
      '❌ **Could not read the member list.** The bot needs the **Server Members Intent** ' +
        'switched on in the Discord Developer Portal → your app → Bot → Privileged Gateway Intents.',
    );
  }

  const userIds = everyoneToNotify({
    members: [...members.values()],
    roleIds,
    subscriptions: store.listSubscriptions(),
    guildId: config.guildId,
  });

  if (userIds.length === 0) {
    return interaction.editReply('Nobody holds those roles. Nothing to send.');
  }

  if (!send) {
    return interaction.editReply(
      [
        `📣 **Preview — would DM ${userIds.length} member(s)** holding tier ${tiers.join(', ')}.`,
        '',
        '```',
        message.slice(0, 1500),
        '```',
        '',
        'Run it again with **`send:True`** to actually send.',
        '_A broadcast cannot be recalled. Read it once more first._',
      ].join('\n'),
    );
  }

  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      const user = await interaction.client.users.fetch(userId);
      await user.send(message);
      sent += 1;
    } catch {
      // A closed inbox is not an error worth stopping for — one member being
      // unreachable must not cost everybody else the message.
      failed += 1;
    }
  }

  commandLog.info(`Broadcast by ${interaction.user.tag}: ${sent} sent, ${failed} unreachable`);
  return interaction.editReply(
    `📣 **Sent to ${sent}** of **${userIds.length}** member(s).` +
      (failed > 0 ? ` **${failed}** could not be reached — closed DMs, most likely.` : ''),
  );
}

/**
 * Moving every membership to a new server.
 *
 * Previews by default, for the same reason as everything else that touches what
 * people paid for: a migration nobody inspected is a migration nobody should
 * run.
 */
async function handleAdminMigrate(interaction, { store, config }) {
  const toGuildId = interaction.options.getString('to');
  const confirm = interaction.options.getBoolean('confirm') ?? false;
  const now = Date.now();

  const plan = planMigration(store.listSubscriptions(), {
    fromGuildId: config.guildId,
    toGuildId,
    now,
  });
  if (!plan.ok) return interaction.editReply(`❌ ${plan.reason}`);

  if (!confirm) {
    return interaction.editReply(
      [
        `🚚 **Preview — would move ${plan.moving.length} membership(s)**`,
        `From \`${plan.fromGuildId}\` to \`${plan.toGuildId}\`.`,
        '',
        plan.leaving > 0 ? `**${plan.leaving}** expired or cancelled are left behind.` : null,
        plan.collisions.length > 0
          ? `**${plan.collisions.length}** already exist there — each keeps whichever membership has more time left.`
          : null,
        '',
        '**This is the step that is easy to forget.** Memberships are stored under',
        '`server:member`, so pointing the bot at a new server without this leaves every',
        'record attached to the old one. Nothing errors. Members just quietly lose the',
        'access they paid for, one at a time, as their roles fail to appear.',
        '',
        'Run again with **`confirm:True`** to move them.',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }

  const { subscriptions, ok, reason } = migratedSubscriptions(store.listSubscriptions(), {
    fromGuildId: config.guildId,
    toGuildId,
    now,
  });
  if (!ok) return interaction.editReply(`❌ ${reason}`);

  for (const subscription of subscriptions) store.putSubscription(subscription);

  commandLog.info(`Migrated ${subscriptions.length} membership(s) to ${toGuildId}`);
  return interaction.editReply(
    [
      `🚚 **Moved ${subscriptions.length} membership(s)** to \`${toGuildId}\`.`,
      '',
      'The old records are left where they were, so nothing is destroyed and this can be',
      'run again safely.',
      '',
      '**Still to do on the host:** set `VIP_GUILD_ID` to the new server, set the tier',
      '`VIP_TIER_*_ROLE_ID` values to the roles in the new server, and redeploy. The',
      'slash commands re-register themselves on start.',
    ].join('\n'),
  );
}
