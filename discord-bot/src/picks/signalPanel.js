import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { FLIP_RISK, whaleLine } from './whales.js';

/**
 * The signals panel, and the alerts it sends without being asked.
 *
 * The gap: every signal in this system had to be PULLED. Somebody ran
 * `/picks read`, got an answer about that instant, and had to run it again
 * thirty seconds later to find out whether anything had changed. On a
 * fifteen-minute contract that is most of the trade spent typing.
 *
 * So the panel is posted once and stays. It carries the buttons for the things
 * people do repeatedly, and — the part that actually matters — the channel it
 * lives in becomes the place alerts arrive by themselves.
 *
 * The hard question this file has to answer is how often to speak. A channel
 * that posts every signal is a channel nobody reads by Wednesday, and an alert
 * that fires on a marginal edge trains people to ignore the ones that are not
 * marginal. So the bar to INTERRUPT a room is deliberately higher than the bar
 * to answer a question:
 *
 *   - only what the engine would actually trade, never what it merely leans on;
 *   - a real edge after the spread and both fees, not a rounding difference;
 *   - one alert per contract, ever — a market announced twice is a market
 *     somebody enters twice;
 *   - a floor between alerts, so a volatile hour cannot flood the room.
 *
 * On the success rate, which was asked for directly: it is REPORTED, never
 * promised. Raising the bar to speak is the only honest lever — it does not
 * make the model better, it makes the bot quieter about the cases where it is
 * least sure, and that is exactly what a high hit rate is made of. A panel
 * claiming a win rate is worth nothing. A panel showing the measured one,
 * including when it is bad, is the only version that survives a member who is
 * counting.
 */

export const SIGNAL_PANEL_PREFIX = 'signal:panel:';
export const SIGNAL_BUTTONS = {
  READ: `${SIGNAL_PANEL_PREFIX}read`,
  RECORD: `${SIGNAL_PANEL_PREFIX}record`,
  PAPER: `${SIGNAL_PANEL_PREFIX}paper`,
};

/** Which panel button was pressed, or null when it is not one of ours. */
export function signalPanelAction(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(SIGNAL_PANEL_PREFIX)) return null;
  return customId.slice(SIGNAL_PANEL_PREFIX.length);
}

/**
 * How much edge, after every cost, before a room gets interrupted.
 *
 * Four cents against the engine's own six-cent entry bar. That is not a second
 * threshold pulled out of the air: the engine's bar is gross edge against the
 * price, and this one is what survives the spread and BOTH fees, so a signal
 * clearing six gross can easily be under four net. Interrupting people for the
 * ones that barely clear is how a channel gets muted.
 */
export const ALERT_MINIMUM_NET_CENTS = 4;
/** Never two alerts closer together than this, whatever the market does. */
export const ALERT_FLOOR_MS = 3 * 60 * 1000;
/** Contracts of size before a whale is worth a post on its own. */
export const WHALE_ALERT_CONTRACTS = 1000;

/**
 * The panel itself.
 *
 * The record on it is whatever was actually measured — including "not enough
 * settled yet", which is the honest state for a long while and is written as
 * such rather than left blank or padded out.
 */
export function signalPanelMessage({ asset = 'BTC', record = null, paper = null } = {}) {
  const lines = [
    '**The bot watches every strike in the window and speaks when one is worth taking.**',
    'It stays quiet the rest of the time, which is most of the time.',
    '',
    '🟢 **BUY** — the model beats the price by more than the spread and both fees',
    '🐋 **WHALE** — size crossed the spread: who leaned, which way, how much',
    '⚠️ **FLIP RISK** — the odds it comes back to the strike before the bell',
    '🚨 **CASH OUT** — in your DMs, only to you, when it is time to leave',
  ];

  if (record && record.settled > 0) {
    const rate = (record.wins / record.settled) * 100;
    lines.push(
      '',
      `**Measured record: ${record.wins}W ${record.settled - record.wins}L — ${rate.toFixed(0)}%** ` +
        `over ${record.settled} settled call(s).`,
      // The sample size travels with the number, always. A 100% record over
      // four calls is not a 100% record, and printing it without the count is
      // how a room ends up believing something nobody measured.
      record.settled < 30
        ? '_Under about thirty calls this is noise, not a track record._'
        : '_Every call is written down when it is made, and graded on the contract._',
    );
  } else {
    lines.push('', '_No settled calls yet. The record appears here as they grade._');
  }

  if (paper) {
    const change = ((paper.value - paper.start) / paper.start) * 100;
    lines.push(
      '',
      `**Paper account:** $${paper.value.toFixed(2)} ` +
        `_(from $${paper.start.toFixed(2)}, ${change >= 0 ? '+' : ''}${change.toFixed(1)}%)_`,
    );
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📈 ${asset} · 15-minute signals`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Alerts arrive in this channel. Cash-outs arrive in your DMs.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SIGNAL_BUTTONS.READ)
      .setLabel('Read the market now')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📊'),
    new ButtonBuilder()
      .setCustomId(SIGNAL_BUTTONS.RECORD)
      .setLabel('Record')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🧾'),
    new ButtonBuilder()
      .setCustomId(SIGNAL_BUTTONS.PAPER)
      .setLabel('Paper account')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📝'),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Whether this signal has earned an interruption.
 *
 * Separate from whether it is a good trade, and deliberately stricter. Every
 * condition here is about the ROOM, not about the market.
 */
export function shouldAlert(
  read,
  {
    ticker,
    alerts = {},
    now = Date.now(),
    minimumNetCents = ALERT_MINIMUM_NET_CENTS,
    floorMs = ALERT_FLOOR_MS,
  } = {},
) {
  if (!ticker) return { alert: false, reason: 'no ticker' };
  if (!read?.tradeable) return { alert: false, reason: 'the engine would not take it' };
  if (!((read.netEdgeCents ?? 0) >= minimumNetCents)) {
    return { alert: false, reason: 'edge too thin to interrupt anyone' };
  }
  if (alerts.seen?.[ticker]) return { alert: false, reason: 'already announced' };
  if (now - (alerts.lastAt ?? 0) < floorMs) return { alert: false, reason: 'too soon after the last' };

  return { alert: true, reason: 'worth saying' };
}

/** The alert itself. One screen, on a phone, at a glance. */
export function alertMessage({ read, asset = 'BTC', ticker = null, strike = null, whales = null, risk = null }) {
  const up = read.call === 'up';
  const entry = Math.round(read.entryCents);
  const target = read.exit ? Math.round(read.exit.targetCents) : null;
  const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—');

  const lines = [
    `${up ? '🟢' : '🔴'} **BUY ${up ? 'UP' : 'DOWN'} @ ${entry}%** · ${asset}`,
    target ? `🎯 **Target ${target}%**` : null,
    '',
    `**Model** ${pct(read.winProbability)} · **Market** ${pct(read.marketWinProbability)} · ` +
      `**+${(read.netEdgeCents ?? 0).toFixed(1)}¢** after the spread and both fees`,
    Number.isFinite(strike) ? `Strike **$${Math.round(strike).toLocaleString('en-US')}**` : null,
  ];

  const whale = whaleLine(whales);
  if (whale) lines.push('', whale);

  if (risk && risk.level !== FLIP_RISK.NONE) {
    lines.push(
      '',
      risk.level === FLIP_RISK.HIGH
        ? `⚠️ **HIGH FLIP RISK** — ${risk.reasons[0]}.`
        : `⚠️ **Flip risk** — ${risk.reasons[0]}.`,
      // Said plainly, because this number surprises everyone the first time and
      // the surprise is what makes people sell a winner in a wobble.
      '_On a 15-minute binary, the chance of coming back to the strike is roughly twice ' +
        'the chance of finishing on the wrong side. It is not a reason to skip the trade — ' +
        'it is a reason not to panic when it moves._',
    );
  }

  lines.push(
    '',
    `**Hold it.** \`/picks watch side:${up ? 'UP' : 'DOWN'} entry:${entry}\` and I will DM you when to leave.`,
    `_\`${ticker ?? '—'}\` · not financial advice._`,
  );

  return lines.filter((line) => line !== null).join('\n');
}

/**
 * A whale worth saying out loud on its own, with no trade attached.
 *
 * Size moving into a contract the engine is NOT calling is still the most
 * useful thing anybody will see that minute, and withholding it because the
 * arithmetic did not clear a threshold is a purity that loses a room. Held to a
 * much higher size bar than the whale line inside a signal, because here there
 * is nothing else carrying the post — and it says outright that it is not a
 * trade call, so it cannot be mistaken for one.
 */
export function shouldAlertWhale(
  whales,
  {
    ticker,
    alerts = {},
    now = Date.now(),
    minimumContracts = WHALE_ALERT_CONTRACTS,
    floorMs = ALERT_FLOOR_MS,
  } = {},
) {
  if (!ticker) return { alert: false, reason: 'no ticker' };
  if (!whales || whales.count === 0) return { alert: false, reason: 'no size' };
  if (whales.contracts < minimumContracts) return { alert: false, reason: 'not big enough to matter' };
  // Two whales disagreeing is not a signal, it is a market.
  if (Math.abs(whales.lean) < 0.6) return { alert: false, reason: 'the size cancels out' };
  if (alerts.whales?.[ticker]) return { alert: false, reason: 'already announced' };
  if (now - (alerts.lastAt ?? 0) < floorMs) return { alert: false, reason: 'too soon after the last' };
  return { alert: true, reason: 'size worth knowing about' };
}

export function whaleAlertMessage({ whales, asset = 'BTC', ticker = null, strike = null, risk = null }) {
  const side = whales.lean > 0 ? 'UP' : 'DOWN';
  return [
    `🐋 **WHALE — ${whales.contracts.toLocaleString('en-US')} contracts ${side}** · ${asset}`,
    '',
    `**$${Math.round(whales.notionalDollars).toLocaleString('en-US')}** crossed the spread in ` +
      `**${whales.count}** large print(s), leaning **${side}**.`,
    Number.isFinite(strike) ? `Strike **$${Math.round(strike).toLocaleString('en-US')}**` : null,
    risk && risk.level !== FLIP_RISK.NONE ? `⚠️ ${risk.reasons[0]}.` : null,
    '',
    '_Size crossing the spread is evidence about pressure, not about outcome._',
    '_The bot is **not** calling this a trade — it is telling you what moved._',
    `_\`${ticker ?? '—'}\`_`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Books an alert so it cannot be sent twice.
 *
 * Bounded on purpose: tickers roll every fifteen minutes, so these maps would
 * otherwise grow all day on the same store that holds the payments.
 */
export function rememberAlert(alerts, { ticker, kind = 'signal', now = Date.now() }) {
  const next = {
    lastAt: now,
    seen: { ...(alerts?.seen ?? {}) },
    whales: { ...(alerts?.whales ?? {}) },
  };
  if (kind === 'whale') next.whales[ticker] = now;
  else next.seen[ticker] = now;

  for (const key of ['seen', 'whales']) {
    const entries = Object.entries(next[key]);
    if (entries.length > 300) {
      next[key] = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 200));
    }
  }
  return next;
}
