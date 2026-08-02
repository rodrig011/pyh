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
export const SIZE_MODAL = 'pick:sizemodal:';

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
/**
 * On Kalshi a position is closed whole — you sell the contracts you hold, you
 * do not sell a quarter of them. So there is no partial exit here: crashing out
 * and cutting a loss both take everything, and the only other thing an analyst
 * can say is that nothing has changed.
 */
export const PANEL_ACTIONS = {
  UP: 'up',
  DOWN: 'down',
  CRASH_OUT: 'crash_out',
  CUT_LOSS: 'cut_loss',
  HOLD: 'hold',
};

/** Every exit closes the whole position. Only holding leaves it running. */
export const CLOSING_ACTIONS = new Set([PANEL_ACTIONS.CRASH_OUT, PANEL_ACTIONS.CUT_LOSS]);

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
        '🟢 **BUY UP** / 🔴 **BUY DOWN** — then say **how much of the port** goes in.',
        '_Every call carries a size. The room cannot act on a direction alone._',
        '',
        '__Closing__ — a position comes out whole, never in pieces',
        '💸 **CRASH OUT** — everything out with the profit. The call closes and is scored.',
        '❌ **CUT LOSS** — everything out at a loss.',
        '✋ **HOLD** — nothing has changed, stay in.',
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
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CRASH_OUT}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('CRASH OUT')
          .setEmoji('💸'),
        // The counterpart to crashing out. A console that can only announce
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

/**
 * The message the room gets for a management call — cash out or hold.
 *
 * These are attached to the analyst's open call rather than floating free: a
 * bare "cash out" in a busy channel is unreadable when three calls are running.
 */
export function managementMessage({ action, analystId, pick, note = null, price = null, verdict = null }) {
  const subject = pick ? `**${pick.asset}** ${pick.minutes}m` : 'your open position';

  const copy = {
    [PANEL_ACTIONS.CRASH_OUT]: {
      colour: COLORS.success,
      title: '💸 Crash out',
      body: `<@${analystId}> is out of ${subject} — **everything**, with the profit. Close your whole position.`,
    },
    [PANEL_ACTIONS.CUT_LOSS]: {
      colour: COLORS.danger,
      title: '❌ Cut the loss',
      body: `<@${analystId}> is out of ${subject} — **everything**. The call is wrong, take the loss and move on.`,
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
        name: '💸 CRASH OUT — everything, in profit',
        value:
          '**Sell your whole position now.** Your money comes out with the profit on it. ' +
          'There is no half-way here — a position on Kalshi comes out whole. ' +
          'The call ends and goes on the record at this price.',
      },
      {
        name: '🗳️ After a call closes — you get a vote',
        value:
          'The bot asks whether **you** actually made money. It scores the direction from the price; ' +
          'only you know when you got in and out. Both answers are published together — ' +
          'a call the bot scored a win where the room lost money means it came too late to act on.',
      },
      {
        name: '❌ CUT LOSS — get out',
        value:
          '**The call is wrong. Sell the whole position and take the loss.** ' +
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
    ...ENTRY_SIZES.map((size) =>
      new ButtonBuilder()
        .setCustomId(`${SIZE_PREFIX}${direction}:${size.percent}`)
        .setStyle(size.percent === 100 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel(size.label),
    ),
    // The four presets cover most calls and none of the interesting ones. An
    // analyst who wants 15% should not have to round to 25.
    new ButtonBuilder()
      .setCustomId(`${SIZE_PREFIX}${direction}:custom`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Other %')
      .setEmoji('✏️'),
  );
}

/** Asks for a size the presets do not cover. */
export function customSizeModal(direction) {
  return new ModalBuilder()
    .setCustomId(`${SIZE_MODAL}${direction}`)
    .setTitle(`${direction === DIRECTIONS.UP ? 'LONG' : 'SHORT'} — how much of the port?`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('percent')
          .setLabel('Percentage of your portfolio')
          .setPlaceholder('e.g. 15')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(6)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Why (optional)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(false),
      ),
    );
}

/** "pick:sizemodal:up" -> "up". */
export function parseSizeModal(customId) {
  if (!customId?.startsWith(SIZE_MODAL)) return null;
  const direction = customId.slice(SIZE_MODAL.length);
  return Object.values(DIRECTIONS).includes(direction) ? direction : null;
}

/** "pick:size:up:50" -> { direction: 'up', percent: 50 }. */
export function parseSize(customId) {
  if (!customId?.startsWith(SIZE_PREFIX)) return null;
  const [direction, raw] = customId.slice(SIZE_PREFIX.length).split(':');
  if (!Object.values(DIRECTIONS).includes(direction)) return null;
  if (raw === 'custom') return { direction, percent: null, custom: true };

  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  return { direction, percent, custom: false };
}

/** A typed percentage, or null when it is not one. */
export function readPercent(raw) {
  const percent = Number.parseFloat(String(raw ?? '').replace('%', '').trim());
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  return Math.round(percent * 10) / 10;
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
  const size = ` · **${pick.sizePercent}% of port**`;
  return {
    content: `${side} **${pick.asset}** ${pick.minutes}m${size}${pick.entry != null ? ` @ ${pick.entryLabel ?? pick.entry}` : ''}`,
  };
}

/** The short version of an exit. */
export function simpleExit({ pick, outcome }) {
  const what =
    outcome === 'win'
      ? '💸 **CRASH OUT — everything out, in profit**'
      : outcome === 'loss'
        ? '❌ **CUT LOSS — everything out**'
        : '➖ **CLOSED — flat**';
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
