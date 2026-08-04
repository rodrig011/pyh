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
export const FOLLOW_PREFIX = 'pick:in:';

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
 * do not sell a quarter of them. So there is no partial exit here: cashing out
 * and cutting a loss both take everything, and the only other thing an analyst
 * can say is that nothing has changed.
 */
export const PANEL_ACTIONS = {
  UP: 'up',
  DOWN: 'down',
  CASH_OUT: 'cash_out',
  CUT_LOSS: 'cut_loss',
  HOLD: 'hold',
};

/** Every exit closes the whole position. Only holding leaves it running. */
export const CLOSING_ACTIONS = new Set([PANEL_ACTIONS.CASH_OUT, PANEL_ACTIONS.CUT_LOSS]);

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
        '💸 **CASH OUT** — everything out with the profit. The call closes and is scored.',
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
          .setCustomId(`${PANEL_PREFIX}${PANEL_ACTIONS.CASH_OUT}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('CASH OUT')
          .setEmoji('💸'),
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

/**
 * The message the room gets for a management call — cash out or hold.
 *
 * These are attached to the analyst's open call rather than floating free: a
 * bare "cash out" in a busy channel is unreadable when three calls are running.
 */
export function managementMessage({ action, analystId, pick, note = null, price = null, verdict = null }) {
  const subject = pick ? `**${pick.asset}** ${pick.minutes}m` : 'your open position';

  const copy = {
    [PANEL_ACTIONS.CASH_OUT]: {
      colour: COLORS.success,
      title: '💸 Cash out',
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
          ? ` · ${verdict.changePercent > 0 ? '+' : ''}${verdict.changePercent.toFixed(1)}%`
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
        name: '⚠️ Two different percentages — do not mix them up',
        value:
          'A call shows **two** numbers with a % on them, and they mean opposite things.\n\n' +
          '**The entry — what the contract costs.** `@ 39%` means the contract is 39¢ and pays $1 ' +
          'if the call is right. It is also the odds: 39% is the market saying this is unlikely. ' +
          'Cheap entries pay more — in at 39, out at 50 is **+28%**. In at 95, being right pays ' +
          'about **5%**. When the entry is high, the room is late.\n\n' +
          '**The size — how much of your book.** `50% of port` is how much of your Kalshi balance ' +
          'the analyst is putting in. That one is on you: size down if it is more than you are ' +
          'comfortable losing.',
      },
      {
        name: '💸 CASH OUT — everything, in profit',
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
          'The call is scored automatically when the candle closes, on **the same contract ' +
          'it was opened on** — not on where the coin ended up. What is scored is what the ' +
          'trade actually returned. Wins and losses both go on the board — check any analyst ' +
          'with `/picks record` or the whole room with `/picks board`.',
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
export function simpleAnnouncement(pick, now = Date.now()) {
  const side = pick.direction === DIRECTIONS.UP ? '🟢 **UP**' : '🔴 **DOWN**';
  const size = ` · **${pick.sizePercent}% of port**`;
  const at = pick.entry != null ? ` @ ${pick.entryLabel ?? pick.entry}` : '';

  // How long the market itself has left, not how long the call runs. On a
  // 15-minute contract those are the same number only when the call is opened
  // exactly on the candle, which never happens — somebody reading this needs
  // to know they have four minutes, not fifteen.
  const left = Math.max(0, Math.round((pick.closesAt - now) / 60000));
  const clock =
    left <= 0
      ? '\n⏳ **market closing now**'
      : `\n⏳ **${left} min left** of this market`;

  return { content: `${side} **${pick.asset}** ${pick.minutes}m${size}${at}${clock}` };
}

/** The short version of an exit. */
/**
 * The closing line in the VIP chat.
 *
 * "Cash out" on its own tells a member nothing they can check. What they want
 * is the trade: who called it, what it cost to get in, what it was worth
 * getting out, and what that made — the same sentence an analyst says out loud.
 * Each part appears only when it is actually known, so a call with no live
 * price still posts a clean line instead of a row of dashes.
 */
export function simpleExit({ pick, outcome, entryLabel = null, exitLabel = null, room = null }) {
  const who = pick.analystTag ? `**${pick.analystTag}**` : 'The analyst';
  const parts = [exitHeadline({ ...pick, outcome })];

  if (entryLabel && exitLabel) {
    parts.push(`${who} went in at **${entryLabel}** and out at **${exitLabel}**`);
  } else if (entryLabel) {
    parts.push(`${who} went in at **${entryLabel}**`);
  }

  if (pick.sizePercent) parts.push(`💼 **${pick.sizePercent}%** of port was in`);

  // What the room got, beside what the analyst got. When the analyst wins and
  // the room does not, the number says so — which is uncomfortable exactly
  // once, and then it fixes how fast the calls get acted on.
  if (room && Number.isFinite(room.roomPercent)) {
    const move = `${room.roomPercent >= 0 ? '+' : ''}${room.roomPercent.toFixed(1)}%`;
    parts.push(
      `👥 **${room.followers}** took it · the room averaged **${move}** · ` +
        `${room.inProfit}/${room.followers} in profit`,
    );
  }

  return { content: parts.join('\n') };
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

/**
 * The one button that turns a broadcast into a record.
 *
 * Pressed at the moment a member takes the call, it stamps the price they
 * actually saw — which is the only way to ever tell them what they made rather
 * than what the analyst made.
 */
export function followRow(pickId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FOLLOW_PREFIX}${pickId}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel("I'm in")
      .setEmoji('🙋'),
  );
}

/** "pick:in:abc123" -> "abc123". */
export function parseFollow(customId) {
  if (!customId?.startsWith(FOLLOW_PREFIX)) return null;
  return customId.slice(FOLLOW_PREFIX.length) || null;
}

/**
 * The odds bar.
 *
 * A contract price is a probability, and a number alone does not land. Twenty
 * blocks make "61" feel like the market leaning, which is what the analyst is
 * betting against or with — and it reads the same on a phone, where most of
 * this is seen.
 */
export function oddsBar(cents, width = 20) {
  if (!Number.isFinite(cents)) return '';
  const filled = Math.max(0, Math.min(width, Math.round((cents / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/**
 * The line that becomes the push notification.
 *
 * On a phone, Discord shows the message content — and the content was three
 * role mentions, so the alert read "@VIP Tier 1 @Vip Tier 2 @VIP Tier 3" and
 * told nobody anything. This is the whole signal in one line, before anyone
 * has opened the app.
 */
export function callHeadline(pick, { verified = false } = {}) {
  const who = pick.analystTag ? pick.analystTag.replace(/#\d+$/, '').toUpperCase() : 'THE ANALYST';
  const side = pick.direction === DIRECTIONS.UP ? '🟢 UP' : '🔴 DOWN';
  const at = pick.entryLabel ? ` @ **${pick.entryLabel}**` : '';
  const size = pick.sizePercent ? ` · ${pick.sizePercent}% of port` : '';
  const left = Number.isFinite(pick.closesAt)
    ? Math.max(0, Math.round((pick.closesAt - Date.now()) / 60000))
    : null;
  const clock = left === null ? '' : left <= 0 ? ' · ⏳ closing' : ` · ⏳ ${left}m`;

  return `${verified ? '⚡' : '📢'} **${who} IS IN** — ${side} ${pick.asset}${at}${size}${clock}`;
}

/** The same, for the moment a position comes off. */
export function exitHeadline(pick) {
  const who = pick.analystTag ? pick.analystTag.replace(/#\d+$/, '').toUpperCase() : 'THE ANALYST';
  const move = Number.isFinite(pick.changePercent)
    ? ` — **${pick.changePercent >= 0 ? '+' : ''}${pick.changePercent.toFixed(1)}%**`
    : '';
  const verb = pick.outcome === 'loss' ? 'CUT THE LOSS' : 'IS OUT';
  return `${pick.outcome === 'loss' ? '❌' : '💸'} **${who} ${verb}** · ${pick.asset}${move}`;
}
