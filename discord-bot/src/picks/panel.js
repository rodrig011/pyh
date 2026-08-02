import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { DIRECTIONS } from './picks.js';

export const PANEL_PREFIX = 'pick:panel:';
export const PANEL_ACTIONS = {
  UP: 'up',
  DOWN: 'down',
  CASH_PERCENT: 'cash_percent',
  CASH_PROFIT: 'cash_profit',
  CUT_LOSS: 'cut_loss',
  HOLD: 'hold',
};
export const CASH_MODAL = 'pick:cash:';

/** "pick:panel:up" -> "up". */
export function panelAction(customId) {
  if (!customId?.startsWith(PANEL_PREFIX)) return null;
  const action = customId.slice(PANEL_PREFIX.length);
  return Object.values(PANEL_ACTIONS).includes(action) ? action : null;
}

/**
 * The analyst's console.
 *
 * Typing `/call direction:… minutes:… entry:…` is four decisions at the exact
 * moment there is no time to make them. On a 15-minute market the signal is
 * worth less the longer it takes to send, so the whole thing is one tap and the
 * bot fills in the price and the clock.
 */
export function analystPanel(config, settings) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('📟 Analyst console')
    .setDescription(
      [
        `One tap sends the call to the room. **${settings.defaultAsset}** on a **${settings.defaultMinutes}-minute** window,`,
        'with the live price stamped on it — so it grades itself when the window closes.',
        '',
        '🟢 **BUY UP** / 🔴 **BUY DOWN** — open a call',
        '💰 **CASH AT %** — tell the room to take a set percentage off',
        '✅ **CASH AT PROFIT** — close it out in profit',
        '❌ **CUT LOSS** — the call is wrong, get out',
        '✋ **HOLD** — stay in, nothing has changed',
      ].join('\n'),
    )
    .setFooter({ text: `Analysts only · ${settings.disclaimer}` });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.UP}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('BUY UP')
          .setEmoji('🟢'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.DOWN}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel('BUY DOWN')
          .setEmoji('🔴'),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_PERCENT}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('CASH AT %')
          .setEmoji('💰'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_PROFIT}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('CASH AT PROFIT')
          .setEmoji('✅'),
        // The counterpart to cashing out. A console that can only announce
        // wins teaches the room to sit through the losers.
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CUT_LOSS}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel('CUT LOSS')
          .setEmoji('❌'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.HOLD}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('HOLD')
          .setEmoji('✋'),
      ),
    ],
  };
}

/** Asks how much to take off, since "cash at a percent" needs the percent. */
export function cashPercentModal() {
  return new ModalBuilder()
    .setCustomId(`${CASH_MODAL}percent`)
    .setTitle('Cash out — how much?')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('percent')
          .setLabel('Percentage to take off')
          .setPlaceholder('e.g. 50')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(6)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Anything to add (optional)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(false),
      ),
    );
}

/**
 * The message the room gets for a management call — cash out or hold.
 *
 * These are attached to the analyst's open call rather than floating free: a
 * bare "cash out" in a busy channel is unreadable when three calls are running.
 */
export function managementMessage({ action, analystId, pick, percent = null, note = null, price = null, verdict = null }) {
  const subject = pick ? `**${pick.asset}** ${pick.minutes}m` : 'your open position';

  const copy = {
    [PANEL_ACTIONS.CASH_PERCENT]: {
      colour: COLORS.gold,
      title: `💰 Take ${percent}% off`,
      body: `<@${analystId}> says take **${percent}%** off ${subject}.`,
    },
    [PANEL_ACTIONS.CASH_PROFIT]: {
      colour: COLORS.success,
      title: '✅ Cash out in profit',
      body: `<@${analystId}> is closing ${subject} in profit. Take it.`,
    },
    [PANEL_ACTIONS.CUT_LOSS]: {
      colour: COLORS.danger,
      title: '❌ Cut the loss',
      body: `<@${analystId}> is getting out of ${subject}. The call is wrong — take the loss and move on.`,
    },
    [PANEL_ACTIONS.HOLD]: {
      colour: COLORS.warning,
      title: '✋ Hold',
      body: `<@${analystId}> says hold ${subject}. Nothing has changed yet.`,
    },
  }[action];

  const embed = new EmbedBuilder()
    .setColor(copy.colour)
    .setTitle(copy.title)
    .setDescription([copy.body, note ? `\n> ${note}` : ''].filter(Boolean).join('\n'))
    .setTimestamp();

  if (price !== null) embed.addFields({ name: 'Price now', value: price, inline: true });
  if (pick?.entryLabel) embed.addFields({ name: 'Called at', value: pick.entryLabel, inline: true });

  // Closing a call is the moment it is scored, so the verdict rides along
  // rather than turning up in a separate message minutes later.
  if (verdict) {
    embed.addFields({
      name: 'Scored',
      value: `${verdict.outcome === 'win' ? '✅ Win' : verdict.outcome === 'loss' ? '❌ Loss' : '➖ Break even'}` +
        (Number.isFinite(verdict.changePercent)
          ? ` · ${verdict.changePercent > 0 ? '+' : ''}${Math.round(verdict.changePercent * 1000) / 1000}%`
          : ''),
      inline: true,
    });
  }

  return { embeds: [embed] };
}

export const DIRECTION_FOR_ACTION = {
  [PANEL_ACTIONS.UP]: DIRECTIONS.UP,
  [PANEL_ACTIONS.DOWN]: DIRECTIONS.DOWN,
};
