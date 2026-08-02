import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { availableTiers, formatMoney, tierPerks, tierTitle } from '../lib/tiers.js';
import { TICKET_OPEN } from './tickets.js';

export const BUY_PREFIX = 'vip:buy:';
export const STATUS_BUTTON = 'vip:status';

/** "vip:buy:2" -> 2, anything else -> null. */
export function tierFromButton(customId) {
  if (!customId?.startsWith(BUY_PREFIX)) return null;
  const tier = Number(customId.slice(BUY_PREFIX.length));
  return Number.isInteger(tier) ? tier : null;
}

/**
 * The storefront: everything a member needs without typing anything.
 *
 * Slash commands lose people — they have to know the command exists, then the
 * subcommand, then the tier option. A button is one tap, so this is what goes in
 * the public channel and in the welcome DM.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {boolean} [options.includeTicket] ticket button — needs a guild, so off in DMs
 * @param {boolean} [options.welcome] greet a new arrival instead of addressing the room
 */
export function storefrontMessage(config, { includeTicket = true, welcome = false } = {}) {
  const sellable = availableTiers(config.tiers);

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(welcome ? '👑 Welcome to KING T PARLAYS' : '👑 KING T PARLAYS — VIP access')
    .setDescription(
      [
        welcome
          ? 'Glad you made it. Here is what VIP gets you — tap a button below to join, no commands to remember.'
          : 'Tap the tier you want. You get a private code and payment instructions — nothing public, nobody sees what you picked.',
        '',
        `Every tier is a **${config.subscriptionDays}-day membership** and includes everything below it.`,
      ].join('\n'),
    )
    .addFields(
      [1, 2, 3].map((tier) => {
        const open = sellable.includes(tier);
        return {
          name: `${open ? '' : '🔒 '}${tierTitle(tier, config.tiers)} — ${formatMoney(config.tiers[tier].priceCents)}`,
          value: open
            ? tierPerks(tier, config.tiers)
            : `${tierPerks(tier, config.tiers)}\n\n*Coming soon.*`,
        };
      }),
    )
    .setFooter({
      text: 'Renew early and your days stack — you never lose time you paid for.',
    });

  const rows = [];

  if (sellable.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        sellable.map((tier) =>
          new ButtonBuilder()
            .setCustomId(`${BUY_PREFIX}${tier}`)
            .setStyle(tier === sellable.at(-1) ? ButtonStyle.Success : ButtonStyle.Primary)
            .setLabel(`${config.tiers[tier].label ?? `Tier ${tier}`} — ${formatMoney(config.tiers[tier].priceCents)}`),
        ),
      ),
    );
  }

  const secondRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(STATUS_BUTTON)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('My membership')
      .setEmoji('📋'),
  );

  if (includeTicket) {
    secondRow.addComponents(
      new ButtonBuilder()
        .setCustomId(TICKET_OPEN)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Payment problem')
        .setEmoji('🎫'),
    );
  } else {
    // A channel URL only resolves for somebody who is already a member, which
    // is exactly who this button is not for. The invite is what a stranger can
    // actually use, so it wins whenever one is configured.
    secondRow.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(config.serverInviteUrl ? 'Join the server' : 'Go to the server')
        .setURL(config.serverInviteUrl ?? `https://discord.com/channels/${config.guildId}`),
    );
  }

  rows.push(secondRow);

  return { embeds: [embed], components: rows };
}
