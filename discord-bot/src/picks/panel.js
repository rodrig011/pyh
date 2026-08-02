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
export const SIZE_PREFIX = 'pick:size:';
export const VOTE_PREFIX = 'pick:vote:';

/**
 * How much of the portfolio to put in when the call opens.
 *
 * This is the entry, not the exit — a distinction the first version of this
 * console got backwards. On Kalshi the size is part of the signal: "long BTC"
 * and "long BTC with a quarter of your book" are different instructions.
 */
export const ENTRY_SIZES = [
  { percent: 25, label: '25% of port' },
  { percent: 50, label: '50% of port' },
  { percent: 75, label: '75% of port' },
  { percent: 100, label: '💯 FULL PORT' },
];
export const PANEL_ACTIONS = {
  UP: 'up',
  DOWN: 'down',
  CASH_25: 'cash_25',
  CASH_50: 'cash_50',
  CASH_75: 'cash_75',
  ALL_OUT: 'all_out',
  CASH_PERCENT: 'cash_percent',
  CASH_PROFIT: 'cash_profit',
  CUT_LOSS: 'cut_loss',
  HOLD: 'hold',
};

/**
 * How much of the position each exit button takes off. 100 closes the call.
 * Separate from ENTRY_SIZES on purpose: one is how much you put in, the other
 * is how much you take out, and calling both "the percentage" is what made the
 * console unreadable.
 */
export const ACTION_PERCENT = {
  [PANEL_ACTIONS.CASH_25]: 25,
  [PANEL_ACTIONS.CASH_50]: 50,
  [PANEL_ACTIONS.CASH_75]: 75,
  [PANEL_ACTIONS.ALL_OUT]: 100,
};

/** Actions that end the call. Anything else leaves it running. */
export const CLOSING_ACTIONS = new Set([
  PANEL_ACTIONS.ALL_OUT,
  PANEL_ACTIONS.CASH_PROFIT,
  PANEL_ACTIONS.CUT_LOSS,
]);
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
'__Opening__',
        '🟢 **BUY UP** / 🔴 **BUY DOWN** — then pick **how much of the port** goes in.',
        '',
        '__Closing__',
        '💰 **CASH 25 / 50 / 75%** — take that much of the position off, the rest stays on',
        '💯 **ALL OUT** — everything out, the call closes and is scored',
        '✅ **CASH AT PROFIT** / ❌ **CUT LOSS** — close it and score it',
        '✋ **HOLD** — nothing has changed',
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
      // Sizing on its own row. In a 15-minute market the difference between
      // "take a quarter off" and "get everything out" is the whole message, and
      // it should not cost a modal to say it.
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_25}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('CASH 25%'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_50}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('CASH 50%'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_75}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('CASH 75%'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.ALL_OUT}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('ALL OUT — full port')
          .setEmoji('💯'),
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_PERCENT}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('Other %')
          .setEmoji('✏️'),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_PROFIT}`)
          .setStyle(ButtonStyle.Success)
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
    [PANEL_ACTIONS.ALL_OUT]: {
      colour: COLORS.gold,
      title: '💯 All out — full port',
      body: `<@${analystId}> is out of ${subject} entirely. Close the whole position.`,
    },
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
  }[ACTION_PERCENT[action] && action !== PANEL_ACTIONS.ALL_OUT ? PANEL_ACTIONS.CASH_PERCENT : action];

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

/**
 * The announcement pinned where members read it.
 *
 * The console is only useful if the room knows what a button means. "Take 50%
 * off" and "all out" are the same word — "cash" — to somebody who has not
 * traded before, and a member who reads them as the same thing sits in a
 * position the analyst has already left.
 */
export function guideMessage(config, settings) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('📖 How to read the calls')
    .setDescription(
      `Every signal in this channel comes from an analyst pressing one button. ` +
        `Here is exactly what each one means, and what you are meant to do.`,
    )
    .addFields(
      {
        name: '🟢 LONG / 🔴 SHORT — a call opens',
        value:
          `The analyst is betting **${settings.defaultAsset}** goes up (LONG) or down (SHORT) ` +
          `before the candle closes. The price they called it at is on the message. ` +
          `**Get in at that price or better — never chase it.**`,
      },
      {
        name: '📊 The % on an entry — how much of your book',
        value:
          'A call arrives with a size: **25 / 50 / 75% of port**, or **full port**. ' +
          'That is how much of your Kalshi balance the analyst is putting in — not a price, and not a target. ' +
          'Size down if that is more than you are comfortable losing.',
      },
      {
        name: '💰 CASH 25% / 50% / 75% — take some off',
        value:
          'Sell that share of the position and **keep the rest running**. ' +
          'This is locking in part of the move, not the exit. The call stays open and is not scored yet.',
      },
      {
        name: '💯 ALL OUT — everything',
        value:
          '**Close the whole position now.** Nothing is left on. ' +
          'The call ends here and goes on the record at this price.',
      },
      {
        name: '🗳️ After a call closes — you get a vote',
        value:
          'The bot asks whether **you** actually made money. It scores the direction from the price; ' +
          'only you know when you got in and out. Both answers are published together — ' +
          'a call the bot scored a win where the room lost money means it came too late to act on.',
      },
      {
        name: '✅ CASH AT PROFIT — take the win',
        value: 'The move played out. **Close it in profit.** The call is scored a win at this price.',
      },
      {
        name: '❌ CUT LOSS — get out',
        value:
          '**The call is wrong. Close it and take the loss.** ' +
          'This goes on the analyst\'s record as a loss — that is the point. Do not average down.',
      },
      {
        name: '✋ HOLD — do nothing',
        value: 'Stay where you are. Nothing has changed and the call is still running.',
      },
      {
        name: '⏱️ If nobody presses anything',
        value:
          `The call is scored automatically when the candle closes, using the real ` +
          `${settings.defaultAsset} price. Wins and losses both go on the board — ` +
          'check any analyst with `/picks record` or the whole room with `/picks board`.',
      },
    )
    .setFooter({
      text: `${settings.disclaimer} · You are responsible for your own money and your own size.`,
    });

  return { embeds: [embed] };
}

/** The size picker shown after a direction is chosen. Ephemeral, one tap. */
export function entrySizeRow(direction) {
  return new ActionRowBuilder().addComponents(
    ENTRY_SIZES.map((size) =>
      new ButtonBuilder()
        .setCustomId(`${SIZE_PREFIX}${direction}:${size.percent}`)
        .setStyle(size.percent === 100 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel(size.label),
    ),
  );
}

/** "pick:size:up:50" -> { direction: 'up', percent: 50 }. */
export function parseSize(customId) {
  if (!customId?.startsWith(SIZE_PREFIX)) return null;
  const [direction, raw] = customId.slice(SIZE_PREFIX.length).split(':');
  const percent = Number(raw);
  if (!Object.values(DIRECTIONS).includes(direction)) return null;
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  return { direction, percent };
}

/** Did you make money on this one? Asked of the room, not the price feed. */
export function voteRow(pickId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${VOTE_PREFIX}${pickId}:profit`)
      .setStyle(ButtonStyle.Success)
      .setLabel('I made profit')
      .setEmoji('🟢'),
    new ButtonBuilder()
      .setCustomId(`${VOTE_PREFIX}${pickId}:loss`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('I lost')
      .setEmoji('🔴'),
  );
}

/** "pick:vote:abc123:profit" -> { pickId: 'abc123', choice: 'profit' }. */
export function parseVote(customId) {
  if (!customId?.startsWith(VOTE_PREFIX)) return null;
  const [pickId, choice] = customId.slice(VOTE_PREFIX.length).split(':');
  if (!pickId || !['profit', 'loss'].includes(choice)) return null;
  return { pickId, choice };
}

/**
 * The short version, for the room that is chatting rather than trading.
 *
 * The full call embed has entry, window, invalidation and a footer. In a busy
 * chat that is a wall nobody reads on a phone, and the one thing that matters —
 * which way, how much, now — gets lost inside it.
 */
export function simpleAnnouncement(pick) {
  const side = pick.direction === DIRECTIONS.UP ? '🟢 **UP**' : '🔴 **DOWN**';
  const size = pick.sizePercent ? ` · **${pick.sizePercent}% of port**` : '';
  return {
    content: `${side} **${pick.asset}** ${pick.minutes}m${size}${pick.entry != null ? ` @ ${pick.entryLabel ?? pick.entry}` : ''}`,
  };
}

/** The short version of an exit. */
export function simpleExit({ pick, percent, closed, outcome }) {
  const what = closed
    ? outcome === 'win'
      ? '✅ **CLOSED — profit**'
      : outcome === 'loss'
        ? '❌ **CLOSED — loss**'
        : '➖ **CLOSED — flat**'
    : `💰 **TAKE ${percent}% OFF** — rest stays on`;
  return { content: `${what} · **${pick.asset}** ${pick.minutes}m` };
}

/**
 * What the room said, next to what the price said.
 *
 * Published together on purpose. The two disagreeing is the useful signal: a
 * call the feed scored a win where most people lost money was called too late
 * to act on, and that is worth knowing.
 */
export function voteResultMessage({ pick, tally, outcome, shareBarText, sharePercent }) {
  const side = pick.direction === DIRECTIONS.UP ? '🟢 LONG' : '🔴 SHORT';
  const scored = { win: '✅ Win', loss: '❌ Loss', break_even: '➖ Flat', void: '🚫 Void' }[outcome] ?? '—';

  const embed = new EmbedBuilder()
    .setColor(tally.profitShare === null ? COLORS.warning : tally.profitShare >= 0.5 ? COLORS.success : COLORS.danger)
    .setTitle(`📊 How the room did — ${side} ${pick.asset} ${pick.minutes}m`)
    .setDescription(
      tally.total === 0
        ? 'Nobody voted on this one.'
        : `${shareBarText}\n**${sharePercent}** of the room made money — ${tally.profit} up, ${tally.loss} down, ${tally.total} voted.`,
    )
    .addFields(
      { name: 'The bot scored it', value: scored, inline: true },
      {
        name: 'The room says',
        value: tally.total === 0 ? '—' : tally.profitShare >= 0.5 ? '🟢 Made money' : '🔴 Lost money',
        inline: true,
      },
    )
    .setTimestamp();

  return { embeds: [embed] };
}
