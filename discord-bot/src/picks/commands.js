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
import { COLORS } from '../lib/brand.js';
import { postPermissionHelp } from '../lib/channelAccess.js';
import {
  CLOSING_ACTIONS,
  DIRECTION_FOR_ACTION,
  PANEL_ACTIONS,
  PANEL_PREFIX,
  SIZE_MODAL,
  SIZE_PREFIX,
  VOTE_PREFIX,
  FOLLOW_PREFIX,
  followRow,
  parseFollow,
  analystPanel,
  customSizeModal,
  entrySizeRow,
  guideMessage,
  managementMessage,
  panelAction,
  parseSize,
  parseSizeModal,
  parseVote,
  readPercent,
  simpleAnnouncement,
  simpleExit,
  voteResultMessage,
  voteRow,
} from './panel.js';
import { castVote, emptyVote, formatShare, shareBar, tallyVote, votesDue } from './vote.js';
import {
  followerCount,
  formatLag,
  formatPercent,
  memberRecord,
  recordFollow,
  roomVersusAnalyst,
} from './following.js';
import {
  currentContract,
  fetchMarkets,
  formatCents,
  gradeByContract,
  openMarkets,
  readMarketPrice,
} from './kalshi.js';
import {
  fetchBalance,
  fetchFills,
  foldFills,
  hasCredentials,
  planPublication,
  sizePercentOf,
} from './kalshiAccount.js';
import { sendLog } from '../vip/notify.js';
import { fetchSpotPrice, formatChange, formatPrice, gradeByPrice } from './price.js';
import {
  DIRECTIONS,
  DIRECTION_LABEL,
  OUTCOMES,
  OUTCOME_LABEL,
  buildBackfill,
  buildPick,
  computeRecord,
  describePick,
  editPickOutcome,
  dueForSettlement,
  formatStreak,
  formatWinRate,
  leaderboard,
  nextCandleClose,
  settlePick,
} from './picks.js';

export const SETTLE_PREFIX = 'pick:settle:';

export const PICK_DEFAULTS = {
  channelId: null,
  analystRoleIds: [],
  defaultMinutes: 15,
  defaultAsset: 'BTC',
  minimumForBoard: 5,
  disclaimer: 'Not financial advice',
  pingRoleIds: [],
  repostPanel: true,
  announceChannelId: null,
  resultChannelId: null,
  voteMinutes: 20,
  votePingRoleIds: [],
  kalshi: { enabled: false },
};

/**
 * The roles told about a call, as a mention line plus the allowedMentions that
 * permits exactly those and nothing else.
 *
 * Set explicitly rather than left to Discord: whatever ends up inside an embed,
 * the bot must never be able to reach @everyone.
 */
export function pingFor(settings) {
  const roleIds = settings.pingRoleIds ?? [];
  return {
    content: roleIds.map((roleId) => `<@&${roleId}>`).join(' ') || undefined,
    allowedMentions: { roles: roleIds },
  };
}

/**
 * Pick settings with defaults filled in.
 *
 * Every slash command in the bot is registered in one call, so a missing key
 * here would throw and leave the server with no commands at all — a blast
 * radius far out of proportion to an unset variable.
 */
export function pickSettings(config) {
  return { ...PICK_DEFAULTS, ...(config.picks ?? {}) };
}

export function buildPickCommands(config) {
  const settings = pickSettings(config);
  const call = new SlashCommandBuilder()
    .setName('call')
    .setDescription('Post a trading call the room can be held to')
    .setDMPermission(false)
    // Discord can gate visibility on a permission bit but never on a role, so
    // the code check is the real authority. This has to read the same list that
    // check does — reading only the analyst roles hid the command from a mod
    // who was allowed to use it, whenever the analysts were configured as mods.
    .setDefaultMemberPermissions(
      callerRoleIds(config).length > 0 ? null : PermissionFlagsBits.ManageMessages,
    )
    .addStringOption((option) =>
      option
        .setName('direction')
        .setDescription('Which way')
        .setRequired(true)
        .addChoices(
          { name: '🟢 UP / LONG', value: DIRECTIONS.UP },
          { name: '🔴 DOWN / SHORT', value: DIRECTIONS.DOWN },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('size')
        .setDescription('How much of the portfolio goes in, as a percentage')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addIntegerOption((option) =>
      option
        .setName('minutes')
        .setDescription(`How long the call runs (default ${settings.defaultMinutes})`)
        .setMinValue(1)
        .setMaxValue(1440)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('asset')
        .setDescription(`What is being called (default ${settings.defaultAsset})`)
        .setRequired(false),
    )
    .addNumberOption((option) =>
      option.setName('entry').setDescription('Entry price').setRequired(false),
    )
    .addNumberOption((option) =>
      option.setName('target').setDescription('Target price').setRequired(false),
    )
    .addNumberOption((option) =>
      option.setName('stop').setDescription('Invalidation / stop').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('note').setDescription('The reasoning, in one line').setRequired(false),
    );

  const picks = new SlashCommandBuilder()
    .setName('picks')
    .setDescription('Track records for the calls made in this server')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('record')
        .setDescription("An analyst's record")
        .addUserOption((option) =>
          option.setName('analyst').setDescription('Whose record (default: yours)').setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('days').setDescription('Only the last N days').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('board')
        .setDescription('Leaderboard by win rate')
        .addIntegerOption((option) =>
          option.setName('days').setDescription('Only the last N days').setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('open').setDescription('Calls still running'))
    .addSubcommand((sub) =>
      sub
        .setName('me')
        .setDescription('What YOU made on the calls you took')
        .addIntegerOption((option) =>
          option.setName('days').setDescription('Only the last N days').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('panel').setDescription('Post the analyst console (analysts only can press it)'),
    )
    .addSubcommand((sub) =>
      sub.setName('price').setDescription('Check the live price feed the bot grades calls with'),
    )
    .addSubcommand((sub) =>
      sub.setName('guide').setDescription('Post the announcement explaining what each signal means'),
    )
    .addSubcommand((sub) =>
      sub.setName('kalshi').setDescription('Check the Kalshi contract feed and show what it returned'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('account')
        .setDescription('Check the connection to the analyst’s Kalshi account (mods only)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Change the result of a call (mods only)')
        .addStringOption((option) =>
          option
            .setName('call')
            .setDescription('Which call — start typing to search')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName('outcome')
            .setDescription('What it should say')
            .setRequired(true)
            .addChoices(
              { name: '✅ Win', value: OUTCOMES.WIN },
              { name: '❌ Loss', value: OUTCOMES.LOSS },
              { name: '➖ Break even', value: OUTCOMES.BREAK_EVEN },
              { name: '🚫 Void — does not count', value: OUTCOMES.VOID },
            ),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('Why (shown with the correction)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Wipe a record the bot got wrong (mods only)')
        .addUserOption((option) =>
          option.setName('analyst').setDescription('Whose record to wipe').setRequired(true),
        )
        .addBooleanOption((option) =>
          option.setName('confirm').setDescription('Required — this cannot be undone').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('backfill')
        .setDescription('Restore calls the bot failed to record (mods only)')
        .addUserOption((option) =>
          option.setName('analyst').setDescription('Whose record').setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('wins').setDescription('Wins to record').setRequired(true).setMinValue(0),
        )
        .addIntegerOption((option) =>
          option.setName('losses').setDescription('Losses to record').setRequired(true).setMinValue(0),
        )
        .addIntegerOption((option) =>
          option
            .setName('break_even')
            .setDescription('Break-evens to record (default: 0)')
            .setRequired(false)
            .setMinValue(0),
        )
        .addStringOption((option) =>
          option.setName('asset').setDescription('Asset these were on (default: BTC)').setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName('days')
            .setDescription('Spread them over the last N days (default: 30)')
            .setRequired(false)
            .setMinValue(1),
        ),
    );

  return [call.toJSON(), picks.toJSON()];
}

/**
 * Every role allowed to send calls.
 *
 * Mods count: in most rooms the analysts *are* the mods, and keeping two lists
 * that mean the same thing invites them to disagree. One source, used by both
 * the permission check and the command's visibility.
 */
export function callerRoleIds(config) {
  return [...pickSettings(config).analystRoleIds, ...(config.modRoleIds ?? [])];
}

/** Only the analysts may call. Administrators always pass. */
export function isAnalyst(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = callerRoleIds(config);
  // With no analyst roles set, only administrators may call. Manage Messages is
  // held by every moderator in most servers, and a member pressing BUY UP by
  // accident sends a real signal to everyone paying for one.
  if (allowed.length === 0) return false;
  const roles = interaction.member?.roles?.cache;
  return Boolean(roles && allowed.some((roleId) => roles.has(roleId)));
}

export function pickEmbed(pick, config) {
  const settled = Boolean(pick.outcome);
  const fields = [{ name: 'Direction', value: DIRECTION_LABEL[pick.direction], inline: true }];

  // A closed call counting down to a deadline two hours gone reads as broken.
  // Once it is settled the window is history, so it says how it ended instead.
  fields.push(
    settled
      ? {
          name: 'Closed',
          value:
            pick.closedBy === 'exit'
              ? `${pick.minutes}m call — **the analyst closed it** ${time(Math.floor((pick.settledAt ?? pick.closesAt) / 1000), 'R')}`
              : `${pick.minutes}m window ran out ${time(Math.floor((pick.settledAt ?? pick.closesAt) / 1000), 'R')}`,
          inline: true,
        }
      : {
          name: 'Window',
          value: `${pick.minutes} min — closes ${time(Math.floor(pick.closesAt / 1000), 'R')}`,
          inline: true,
        },
  );

  // Every price goes through one formatter. Raw floats put `63297.575` next to
  // `$63,281.84` in the same embed, which reads as two different numbers.
  if (pick.entry != null) {
    fields.push({
      name: pick.priceUnit === 'cents' ? 'Contract in' : 'Entry',
      value: priceLabel(pick, pick.entry),
      inline: true,
    });
  }
  fields.push({
    name: 'Size',
    value: pick.sizePercent ? `**${pick.sizePercent}% of port**` : '—',
    inline: true,
  });

  // Which market this is. A member checking they are in the right play was
  // comparing timestamps to work it out; the strike is the number the contract
  // actually settles against, and the ticker is the market by name.
  if (Number.isFinite(pick.strike)) {
    fields.push({
      name: 'Kalshi market',
      value:
        `${DIRECTION_LABEL[pick.direction]} **${formatPrice(pick.strike)}**` +
        (pick.marketTicker ? `\n\`${pick.marketTicker}\`` : ''),
    });
  } else if (pick.marketTicker) {
    fields.push({ name: 'Kalshi market', value: `\`${pick.marketTicker}\`` });
  }
  if (pick.target != null) fields.push({ name: 'Target', value: priceLabel(pick, pick.target), inline: true });
  if (pick.stop != null) {
    fields.push({ name: 'Invalidation', value: priceLabel(pick, pick.stop), inline: true });
  }

  if (settled) {
    fields.push({
      name: 'Result',
      value:
        `${OUTCOME_LABEL[pick.outcome]}` +
        (pick.exit != null ? ` at ${priceLabel(pick, pick.exit)}` : '') +
        (Number.isFinite(pick.changePercent) ? ` · ${formatChange(pick.changePercent)}` : ''),
    });
  }

  const colour = settled
    ? { win: COLORS.success, loss: COLORS.danger }[pick.outcome] ?? COLORS.warning
    : pick.direction === DIRECTIONS.UP
      ? COLORS.success
      : COLORS.danger;

  return new EmbedBuilder()
    .setColor(colour)
    .setTitle(`${DIRECTION_LABEL[pick.direction]} ${pick.asset} · ${pick.minutes}m`)
    .setDescription(pick.note ?? null)
    .addFields(fields)
    .setFooter({ text: `Call by ${pick.analystTag ?? 'an analyst'} · ${pickSettings(config).disclaimer}` })
    .setTimestamp(pick.createdAt);
}

/** The buttons an analyst grades their own call with once the window closes. */
export function settleRow(pickId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SETTLE_PREFIX}${pickId}:${OUTCOMES.WIN}`)
      .setStyle(ButtonStyle.Success)
      .setLabel('Win'),
    new ButtonBuilder()
      .setCustomId(`${SETTLE_PREFIX}${pickId}:${OUTCOMES.LOSS}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Loss'),
    new ButtonBuilder()
      .setCustomId(`${SETTLE_PREFIX}${pickId}:${OUTCOMES.BREAK_EVEN}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Break even'),
    new ButtonBuilder()
      .setCustomId(`${SETTLE_PREFIX}${pickId}:${OUTCOMES.VOID}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Void'),
  );
}

/**
 * What the call is priced against right now.
 *
 * The Kalshi contract when it is switched on, BTC spot otherwise. A scalp is a
 * contract trade — bought at 47¢, sold at 61¢ — so grading it on where spot
 * ended answers a question nobody asked. Spot stays as the fallback because a
 * feed that is down must cost automatic grading, not the call itself.
 */
export async function quoteFor(config, asset, { direction = null, ticker = null, closesAt = null } = {}) {
  const settings = pickSettings(config);

  if (settings.kalshi?.enabled) {
    // The BTC 15-minute market is one contract with two sides: YES pays if the
    // candle closes up, NO if it closes down. An analyst calling DOWN buys NO,
    // so pricing their call off the YES side would report the exact opposite
    // of what they paid — a 39¢ entry read as 61¢, and every result inverted.
    const side =
      direction === DIRECTIONS.DOWN ? 'no' : direction === DIRECTIONS.UP ? 'yes' : settings.kalshi.side;
    const contract = await currentContract({ ...settings.kalshi, side }, { ticker, closesAt });
    if (contract.price !== null) {
      const market = contract.market ?? {};
      return {
        price: contract.price,
        unit: 'cents',
        source: `kalshi:${market.ticker ?? 'market'}`,
        ticker: market.ticker ?? null,
        // The level the contract settles against — "will BTC be above this".
        // A member checking they are in the right play is checking this number,
        // and until now the only way to tell was to compare timestamps.
        strike: Number.isFinite(Number(market.floor_strike))
          ? Number(market.floor_strike)
          : Number.isFinite(Number(market.cap_strike))
            ? Number(market.cap_strike)
            : null,
        marketClosesAt: Date.parse(market.close_time ?? '') || null,
        label: formatCents(contract.price),
      };
    }
  }

  const spot = await fetchSpotPrice(asset);
  return spot.price === null
    ? { price: null, unit: null, source: null, ticker: null, strike: null, marketClosesAt: null, label: '—' }
    : {
        price: spot.price,
        unit: 'usd',
        source: spot.source,
        ticker: null,
        strike: null,
        marketClosesAt: null,
        label: formatPrice(spot.price),
      };
}

/** Formats a price in whatever unit the call was opened in. */
export function priceLabel(pick, value) {
  if (value == null) return '—';
  return pick.priceUnit === 'cents' ? formatCents(value) : formatPrice(value);
}

/** Grades a call the same way it was priced. */
export function gradeQuote(pick, exitPrice) {
  if (pick.entry == null || exitPrice == null) return null;
  return pick.priceUnit === 'cents'
    ? gradeByContract(pick.entry, exitPrice)
    : gradeByPrice(pick.direction, pick.entry, exitPrice);
}

/**
 * Rewrites the call's own message with its result.
 *
 * The result was posted as a new message, so the original went on saying
 * "closes 6 minutes ago" forever. Anyone scrolling back read a live call that
 * had been settled an hour earlier, which makes the whole channel look broken.
 * Best effort: a deleted message must not undo a settlement already saved.
 */
export async function refreshCallMessage(client, config, pick) {
  if (!pick?.messageId || !pick.channelId) return false;

  const channel = await client.channels.fetch(pick.channelId).catch(() => null);
  if (!channel?.messages?.fetch) return false;

  return channel.messages
    .fetch(pick.messageId)
    .then((message) => message.edit({ embeds: [pickEmbed(pick, config)] }))
    .then(() => true)
    .catch(() => false);
}

/** Mirrors a one-line version into the chat channel, when one is configured. */
async function announce(client, config, payload) {
  const settings = pickSettings(config);
  if (!settings.announceChannelId) return false;

  const channel = await client.channels.fetch(settings.announceChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  await channel
    .send({ ...pingFor(settings), ...payload, allowedMentions: { roles: settings.pingRoleIds ?? [] } })
    .catch(() => null);
  return true;
}

/**
 * Opens a call and posts it. Shared by `/call` and the console buttons, so the
 * two can never drift into recording different things.
 */
export async function openCall(interaction, { store, config }, overrides = {}) {
  const settings = pickSettings(config);
  const asset = overrides.asset ?? settings.defaultAsset;

  // A call without a size is half an instruction. The room can act on "long
  // BTC with a quarter of your book"; it cannot act on "long BTC", and left
  // optional this is the field that quietly goes missing under time pressure.
  const sizePercent = overrides.sizePercent ?? null;
  if (!Number.isFinite(sizePercent) || sizePercent <= 0 || sizePercent > 100) {
    return { pick: null, channel: null, reason: 'no_size' };
  }

  // Telling the room to buy UP while a DOWN is still open is telling them to
  // hold both sides of the same contract. On Kalshi that is not a hedge, it is
  // paying two spreads to be flat — and whichever exit is pressed next would be
  // applied to whichever call happens to be newest.
  const conflicting = store
    .listPicks(
      (pick) =>
        !pick.outcome &&
        pick.asset === asset &&
        pick.analystId === interaction.user.id &&
        pick.direction !== overrides.direction,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (conflicting) {
    return { pick: null, channel: null, reason: 'opposite_open', conflicting };
  }

  // The price at the moment of the call is what makes it gradeable later. A
  // feed that is down must not block the call — it only costs automatic
  // grading, and the analyst can still settle it by hand.
  // Worked out before the quote so both ends agree on which 15-minute market
  // this call belongs to, and frozen so buildPick cannot land on the next
  // candle a few milliseconds later.
  const now = Date.now();
  const minutes = overrides.minutes ?? settings.defaultMinutes;
  const closesAt = nextCandleClose(now, minutes);

  let entry = overrides.entry ?? null;
  let priceSource = null;
  let priceUnit = 'usd';
  let marketTicker = null;
  let strike = null;
  let marketClosesAt = null;
  if (entry === null) {
    const quote = await quoteFor(config, asset, {
      direction: overrides.direction ?? null,
      closesAt,
    });
    entry = quote.price;
    priceSource = quote.source;
    priceUnit = quote.unit ?? 'usd';
    marketTicker = quote.ticker ?? null;
    strike = quote.strike ?? null;
    marketClosesAt = quote.marketClosesAt ?? null;
  }

  const pick = buildPick({
    analystId: interaction.user.id,
    analystTag: interaction.user.tag,
    guildId: interaction.guildId ?? config.guildId,
    direction: overrides.direction,
    asset,
    minutes,
    sizePercent,
    entry,
    target: overrides.target ?? null,
    stop: overrides.stop ?? null,
    note: overrides.note ?? null,
    now,
  });
  pick.entrySource = priceSource;
  pick.priceUnit = priceUnit;
  // The exact contract the analyst bought. By the time they press CASH OUT the
  // market may have rolled over, and "the current market" would be a different
  // trade — so the exit is priced against this ticker, not against whatever is
  // open at that second.
  pick.marketTicker = marketTicker;
  pick.strike = strike;
  pick.marketClosesAt = marketClosesAt;

  const channel = settings.channelId
    ? await interaction.client.channels.fetch(settings.channelId).catch(() => null)
    : interaction.channel;

  if (!channel?.isTextBased()) return { pick: null, channel: null, reason: 'no_channel' };

  const posted = await channel.send({
    ...pingFor(settings),
    embeds: [pickEmbed(pick, config)],
    components: [followRow(pick.id)],
  });
  pick.messageId = posted.id;
  pick.channelId = channel.id;
  store.recordPick(pick);

  await announce(interaction.client, config, simpleAnnouncement({
    ...pick,
    entryLabel: pick.entry == null ? null : priceLabel(pick, pick.entry),
  }));

  return { pick, channel };
}

export async function handleCall(interaction, { store, config }) {
  if (!isAnalyst(interaction, config)) {
    return interaction.reply({
      content: 'Only the analysts can post calls.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { pick, channel, reason, conflicting } = await openCall(interaction, { store, config }, {
    direction: interaction.options.getString('direction'),
    sizePercent: interaction.options.getInteger('size'),
    asset: interaction.options.getString('asset'),
    minutes: interaction.options.getInteger('minutes'),
    entry: interaction.options.getNumber('entry'),
    target: interaction.options.getNumber('target'),
    stop: interaction.options.getNumber('stop'),
    note: interaction.options.getString('note'),
  });

  if (!pick) return interaction.editReply(whyNotPosted(reason, conflicting));

  return interaction.editReply(
    `Call posted in ${channel}. ` +
      (pick.entry === null
        ? 'No live price was available, so you will be asked to grade it by hand.'
        : `Stamped at **${formatPrice(pick.entry)}** — it grades itself when the window closes.`),
  );
}

/**
 * Why a call could not go out, in words the analyst can act on mid-candle.
 *
 * A bare "I could not post that" at the moment a signal is worth sending is
 * the least useful sentence in the bot.
 */
function whyNotPosted(reason, conflicting) {
  if (reason === 'no_size') {
    return 'Every call needs a size — say what percentage of the portfolio goes in.';
  }
  if (reason === 'opposite_open' && conflicting) {
    return (
      `You still have a **${DIRECTION_LABEL[conflicting.direction]} ${conflicting.asset}** call open` +
      (Number.isFinite(conflicting.entry) ? ` from ${priceLabel(conflicting, conflicting.entry)}` : '') +
      '. Close it with 💸 **CASH OUT** or ❌ **CUT LOSS** first — the room cannot hold both sides of the same contract, ' +
      'and an exit pressed now would land on whichever call is newest.'
    );
  }
  return 'I cannot post the call — check `PICKS_CHANNEL_ID` and that I can write there.';
}

export async function handlePicks(interaction, { store, config }) {
  const sub = interaction.options.getSubcommand();
  const picks = store.listPicks((pick) => pick.guildId === (interaction.guildId ?? config.guildId));
  await interaction.deferReply();

  if (sub === 'record') {
    const user = interaction.options.getUser('analyst') ?? interaction.user;
    const days = interaction.options.getInteger('days');
    const record = computeRecord(picks, { analystId: user.id, sinceDays: days });

    if (record.settled === 0 && record.open === 0) {
      return interaction.editReply(`<@${user.id}> has not posted a call yet.`);
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.gold)
          .setTitle(`📈 Record — ${user.username}${days ? ` · last ${days} days` : ''}`)
          .addFields(
            { name: 'Win rate', value: `**${formatWinRate(record.winRate)}**`, inline: true },
            { name: 'Record', value: `${record.wins}W — ${record.losses}L`, inline: true },
            { name: 'Streak', value: formatStreak(record.streak), inline: true },
            {
              name: 'Everything else',
              value:
                `${record.decided} decided · ${record.breakEven} flat · ${record.open} still running`,
            },
          )
          .setTimestamp(),
      ],
    });
  }

  if (sub === 'board') {
    const days = interaction.options.getInteger('days');
    const board = leaderboard(picks, { sinceDays: days, minimum: pickSettings(config).minimumForBoard });

    const medal = ['🥇', '🥈', '🥉'];
    const lines = board.ranked
      .slice(0, 10)
      .map(
        (row, index) =>
          `${medal[index] ?? `**${index + 1}.**`} <@${row.analystId}> — **${formatWinRate(row.winRate)}** ` +
          `(${row.wins}W ${row.losses}L) ${formatStreak(row.streak)}`,
      );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.gold)
          .setTitle(`🏆 Leaderboard${days ? ` — last ${days} days` : ''}`)
          .setDescription(
            lines.length > 0
              ? lines.join('\n')
              : `Nobody has ${board.minimum} graded calls yet. The board fills itself in.`,
          )
          .addFields(
            board.provisional.length > 0
              ? [
                  {
                    name: `Still warming up (under ${board.minimum} calls)`,
                    value: board.provisional
                      .slice(0, 10)
                      .map(
                        (row) =>
                          `<@${row.analystId}> — ${row.wins}W ${row.losses}L`,
                      )
                      .join('\n'),
                  },
                ]
              : [],
          )
          .setFooter({
            text: `Ranked on graded calls only. ${board.minimum} minimum, so one lucky call cannot top the board.`,
          })
          .setTimestamp(),
      ],
    });
  }

  if (sub === 'panel') {
    if (!isAnalyst(interaction, config)) {
      return interaction.editReply('Only the analysts can post the console.');
    }

    const help = postPermissionHelp(interaction.channel, interaction.guild);
    if (help) return interaction.editReply(help);

    try {
      await interaction.channel.send(analystPanel(config, pickSettings(config)));
    } catch (error) {
      return interaction.editReply(`Discord refused the post: **${error.message}**`);
    }
    return interaction.editReply('Console posted. Pin it — only analysts can press the buttons.');
  }

  if (sub === 'edit') {
    const isMod =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      (config.modRoleIds ?? []).some((roleId) => interaction.member?.roles?.cache?.has(roleId));
    if (!isMod) return interaction.editReply('Only the mods can change a result.');

    const pick = store.getPick(interaction.options.getString('call'));
    if (!pick) return interaction.editReply('I cannot find that call. Pick one from the list.');

    const outcome = interaction.options.getString('outcome');
    const reason = interaction.options.getString('reason');
    const result = editPickOutcome(pick, { outcome, editedBy: interaction.user.id, note: reason });

    if (!result.changed) {
      return interaction.editReply(`That call already says **${OUTCOME_LABEL[outcome]}**.`);
    }
    store.putPick(pick);

    // Corrections are announced where the call was, not just to whoever made
    // them. A public number quietly rewritten is not a correction.
    const channel = pick.channelId
      ? await interaction.client.channels.fetch(pick.channelId).catch(() => null)
      : null;

    if (channel?.isTextBased()) {
      await channel
        .send({
          content:
            `📝 **Correction** — <@${interaction.user.id}> changed <@${pick.analystId}>'s ` +
            `**${pick.asset}** ${pick.minutes}m call from ${OUTCOME_LABEL[result.from]} to ` +
            `${OUTCOME_LABEL[outcome]}.${reason ? `\n> ${reason}` : ''}`,
          embeds: [pickEmbed(pick, config)],
          allowedMentions: { users: [] },
        })
        .catch(() => null);

      // The original message is what people scroll back to, so it is corrected
      // too — best effort. A missing or deleted message must not throw after the
      // edit is already saved, or the record and the channel disagree forever.
      if (pick.messageId && channel.messages?.fetch) {
        await channel.messages
          .fetch(pick.messageId)
          .then((message) => message.edit({ embeds: [pickEmbed(pick, config)] }))
          .catch(() => null);
      }
    }

    const record = computeRecord(store.listPicks(), { analystId: pick.analystId });
    return interaction.editReply(
      `Changed from ${OUTCOME_LABEL[result.from]} to ${OUTCOME_LABEL[outcome]}. ` +
        `<@${pick.analystId}> is now **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L). ` +
        'The correction was posted in the channel — a public number cannot be changed quietly.',
    );
  }

  if (sub === 'guide') {
    if (!isAnalyst(interaction, config)) {
      return interaction.editReply('Only the analysts and mods can post the guide.');
    }
    const help = postPermissionHelp(interaction.channel, interaction.guild);
    if (help) return interaction.editReply(help);

    await interaction.channel.send(guideMessage(config, pickSettings(config)));
    return interaction.editReply('Guide posted. **Pin it** — the buttons only work if the room reads them the same way.');
  }

  // The response shape was never verified against a live account, so this
  // prints what came back rather than only whether it worked. That raw body is
  // what turns a guess into a fix.
  if (sub === 'kalshi') {
    const settings = pickSettings(config);
    if (!settings.kalshi?.enabled) {
      return interaction.editReply(
        '❌ **Kalshi scoring is off** (`KALSHI_ENABLED` is not `true`). Calls are graded on BTC spot instead.',
      );
    }

    const { markets, error, url } = await fetchMarkets(settings.kalshi);
    if (error) {
      return interaction.editReply(
        [
          `❌ **Could not read Kalshi:** ${error}`,
          `\`${url}\``,
          '',
          'A 401 means the endpoint needs a key. A 404 usually means `KALSHI_SERIES_TICKER` is wrong.',
        ].join('\n'),
      );
    }

    const open = openMarkets(markets);
    if (open.length === 0) {
      return interaction.editReply(
        `Reached Kalshi but no open markets came back for \`${settings.kalshi.seriesTicker ?? '(no series set)'}\`.\n` +
          `\`${url}\`\nSet \`KALSHI_SERIES_TICKER\` to the BTC series you trade.`,
      );
    }

    const market = open[0];
    const price = readMarketPrice(market, settings.kalshi.side ?? 'yes');
    const body = JSON.stringify(market, null, 1).slice(0, 900);

    return interaction.editReply(
      [
        price
          ? `✅ **${market.ticker}** — **${formatCents(price.cents)}** (from \`${price.source}\`)`
          : `⚠️ **${market.ticker}** came back with no usable price.`,
        `${open.length} open market(s). Closes ${market.close_time ?? 'unknown'}.`,
        '',
        'What the API returned for that market:',
        `\`\`\`json\n${body}\n\`\`\``,
        price ? '' : 'Send this to whoever maintains the bot — the field names are what the parser needs.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (sub === 'price') {
    const settings = pickSettings(config);
    const quote = await fetchSpotPrice(settings.defaultAsset);
    return interaction.editReply(
      quote.price === null
        ? [
            `❌ **No live price for ${settings.defaultAsset}.** Calls will have to be graded by hand.`,
            ...quote.problems.map((problem) => `• ${problem}`),
          ].join('\n')
        : `✅ **${settings.defaultAsset} ${formatPrice(quote.price)}** via \`${quote.source}\`.` +
          (quote.problems.length > 0 ? `\n_Fell back after: ${quote.problems.join('; ')}_` : ''),
    );
  }

  // A record the bot itself got wrong has to be fixable, or the board lies
  // permanently about someone. Mods only, and it says what it will destroy
  // before it does it.
  if (sub === 'reset') {
    const isMod =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      (config.modRoleIds ?? []).some((roleId) => interaction.member?.roles?.cache?.has(roleId));
    if (!isMod) return interaction.editReply('Only the mods can wipe a record.');

    const user = interaction.options.getUser('analyst');
    const theirs = picks.filter((pick) => pick.analystId === user.id);

    if (theirs.length === 0) return interaction.editReply(`<@${user.id}> has no calls on record.`);

    if (!interaction.options.getBoolean('confirm')) {
      const record = computeRecord(picks, { analystId: user.id });
      return interaction.editReply(
        `This would delete **${theirs.length}** call(s) for <@${user.id}> — currently ` +
          `**${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).\n` +
          'Run it again with `confirm:True`. **This cannot be undone.**',
      );
    }

    store.removePicks((pick) => pick.analystId === user.id);
    return interaction.editReply(
      `Wiped **${theirs.length}** call(s) for <@${user.id}>. Their record starts from zero.`,
    );
  }

  // These are results the bot lost, not results somebody invented: for weeks
  // it graded calls into a store that was destroyed on the next deploy. An
  // analyst who was 7-0 showed 0-0 next to somebody who started yesterday.
  if (sub === 'backfill') {
    const isMod =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      (config.modRoleIds ?? []).some((roleId) => interaction.member?.roles?.cache?.has(roleId));
    if (!isMod) return interaction.editReply('Only the mods can enter past results.');

    const user = interaction.options.getUser('analyst');
    const wins = interaction.options.getInteger('wins');
    const losses = interaction.options.getInteger('losses');
    const breakEven = interaction.options.getInteger('break_even') ?? 0;

    let entries;
    try {
      entries = buildBackfill({
        analystId: user.id,
        analystTag: user.tag,
        guildId: interaction.guildId,
        wins,
        losses,
        breakEven,
        asset: interaction.options.getString('asset') ?? 'BTC',
        by: interaction.user.tag,
        spreadDays: interaction.options.getInteger('days') ?? 30,
      });
    } catch (error) {
      return interaction.editReply(error.message);
    }

    // Replace, never append. Adding on every run turned "their record is 7-0",
    // repeated a few times while testing, into 83-18 — the bot recording
    // exactly what it was told, over and over. A restore states what the record
    // IS, so running it twice has to leave the same answer as running it once.
    const replaced = store.removePicks((pick) => pick.backfilled && pick.analystId === user.id);

    for (const entry of entries) store.putPick(entry);

    const record = computeRecord(store.listPicks(), { analystId: user.id });
    await sendLog(
      interaction.client,
      config,
      new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle('Record restored')
        .setDescription(
          `<@${interaction.user.id}> restored **${wins}W ${losses}L**` +
            `${breakEven > 0 ? ` ${breakEven}BE` : ''} for <@${user.id}>.`,
        )
        .setTimestamp(),
    );

    return interaction.editReply(
      `Restored **${entries.length}** call(s) for <@${user.id}>. ` +
        `They now show **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).` +
        (replaced > 0
          ? `\n_Replaced ${replaced} previously restored call(s). Calls the bot graded live were left alone._`
          : ''),
    );
  }

  if (sub === 'me') {
    const days = interaction.options.getInteger('days');
    const record = memberRecord(store.listFollows(), picks, interaction.user.id, { sinceDays: days });

    if (record.followed === 0) {
      return interaction.editReply(
        'You have not taken a call yet. Press **🙋 I\'m in** on one and the bot starts keeping *your* record — ' +
          'what you made on your own entry, not what the analyst made.',
      );
    }

    const embed = new EmbedBuilder()
      .setColor(record.returnPercent === null || record.returnPercent >= 0 ? COLORS.success : COLORS.danger)
      .setTitle(`📊 Your record${days ? ` — last ${days} days` : ''}`)
      .setDescription(
        record.graded === 0
          ? `You are in **${record.stillOpen}** call(s) that have not closed yet.`
          : `On your own entries, across **${record.graded}** closed call(s).`,
      )
      .addFields(
        { name: 'Your return', value: `**${formatPercent(record.returnPercent)}**`, inline: true },
        { name: 'Record', value: `${record.wins}W — ${record.losses}L`, inline: true },
        {
          name: 'You enter',
          value: record.averageLagSeconds === null ? '—' : `${formatLag(record.averageLagSeconds)} after the call`,
          inline: true,
        },
      )
      .setTimestamp();

    if (record.best) {
      embed.addFields({
        name: 'Best / worst',
        value: `${record.best.asset} **${formatPercent(record.best.percent)}** · ${record.worst.asset} **${formatPercent(record.worst.percent)}**`,
      });
    }

    // The other half of the truth. A member who only ever sees their wins is
    // being flattered, not informed — and the calls they skipped are usually
    // the most useful thing this can tell them.
    if (record.missed > 0) {
      embed.addFields({
        name: `The ${record.missed} you sat out`,
        value:
          `Taken at the analyst's entry they would have been **${formatPercent(record.missedReturnPercent)}**.` +
          (record.averageLagSeconds !== null && record.averageLagSeconds > 120
            ? `\n_You also enter ${formatLag(record.averageLagSeconds)} after the call goes out. Getting there sooner is worth more than picking better._`
            : ''),
      });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // Reading the account is how a record stops being self-reported. This proves
  // the connection before anything is published from it.
  if (sub === 'account') {
    const isMod =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      (config.modRoleIds ?? []).some((roleId) => interaction.member?.roles?.cache?.has(roleId));
    if (!isMod) return interaction.editReply('Only the mods can check the account connection.');

    const account = pickSettings(config).kalshi?.account ?? {};
    if (!hasCredentials(account)) {
      return interaction.editReply(
        [
          '❌ No Kalshi account is connected.',
          '',
          'Set **KALSHI_API_KEY_ID** and **KALSHI_PRIVATE_KEY** to read the analyst’s own fills.',
          'The bot only ever signs `/portfolio/fills`, `/portfolio/positions` and `/portfolio/balance` — ' +
            'it cannot place, change or cancel an order.',
        ].join('\n'),
      );
    }

    const [fillsResult, balanceResult] = await Promise.all([
      fetchFills(account, { limit: 20 }),
      fetchBalance(account),
    ]);

    if (fillsResult.error) {
      return interaction.editReply(
        `❌ Kalshi refused the account request: \`${fillsResult.error}\`\n` +
          '_A 401 usually means the private key does not match the key id, or the PEM lost its line breaks._',
      );
    }

    const positions = foldFills(fillsResult.fills, { seriesTicker: account.seriesTicker });
    const open = positions.filter((position) => position.isOpen);

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🔐 Kalshi account — connected')
      .setDescription(
        [
          `Read **${fillsResult.fills.length}** recent fill(s), folded into **${positions.length}** position(s).`,
          open.length > 0 ? `**${open.length}** still open.` : 'Nothing open right now.',
          balanceResult.balanceCents === null
            ? ''
            : `Balance: **$${(balanceResult.balanceCents / 100).toFixed(2)}**`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .setTimestamp();

    if (positions.length > 0) {
      embed.addFields({
        name: 'Most recent',
        value: positions
          .slice(-5)
          .map(
            (position) =>
              `${position.direction === 'up' ? '🟢' : '🔴'} \`${position.ticker}\` — ` +
              `in **${formatCents(position.entryCents)}**` +
              (position.isOpen
                ? ' · **still open**'
                : ` out **${formatCents(position.exitCents)}** · **${formatChange(position.returnPercent)}**`),
          )
          .join('\n'),
      });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === 'open') {
    const open = picks
      .filter((pick) => !pick.outcome)
      .sort((a, b) => a.closesAt - b.closesAt)
      .slice(0, 15);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.gold)
          .setTitle('⏱️ Calls still running')
          .setDescription(
            open.length === 0
              ? 'Nothing open right now.'
              : open
                  .map(
                    (pick) =>
                      `${DIRECTION_LABEL[pick.direction]} **${pick.asset}** · <@${pick.analystId}> · ` +
                      `${pick.closesAt <= Date.now() ? '**awaiting grading**' : `closes ${time(Math.floor(pick.closesAt / 1000), 'R')}`}`,
                  )
                  .join('\n'),
          )
          .setTimestamp(),
      ],
    });
  }

  return interaction.editReply('Unknown subcommand.');
}

/**
 * A member says they took the call, and the bot stamps the price they saw.
 *
 * This is the whole feature: without a per-member entry there is no way to
 * ever answer "did *I* make money", only "was the analyst right". Anyone in
 * the channel may press it — it is not a claim on the room's money, it is the
 * member's own diary.
 */
export async function handleFollowButton(interaction, { store, config }) {
  const pickId = parseFollow(interaction.customId);
  if (!pickId) return undefined;

  const pick = store.getPick(pickId);
  if (!pick) {
    return interaction.reply({ content: 'That call is gone.', flags: MessageFlags.Ephemeral });
  }
  if (pick.outcome) {
    return interaction.reply({
      content: 'That call has already closed, so there is no entry price to record.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const already = store.listFollows(
    (follow) => follow.pickId === pickId && follow.userId === interaction.user.id,
  )[0];
  if (already) {
    return interaction.reply({
      content:
        `You are already in this one at **${already.unit === 'cents' ? formatCents(already.price) : formatPrice(already.price)}**. ` +
        'Pressing again does not open a second position.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Their price, not the analyst's. The gap between the two is the number this
  // whole feature exists to expose.
  const quote = await quoteFor(config, pick.asset, {
    direction: pick.direction,
    ticker: pick.marketTicker ?? null,
    closesAt: pick.closesAt,
  });

  const { follow } = recordFollow(store.listFollows(), {
    pickId,
    userId: interaction.user.id,
    price: quote.price,
    unit: quote.unit,
    at: Date.now(),
  });
  store.addFollow(follow);

  const lag = Math.max(0, Math.round((follow.at - pick.createdAt) / 1000));
  const behind =
    Number.isFinite(pick.entry) && Number.isFinite(quote.price) && pick.entry > 0
      ? ((quote.price - pick.entry) / pick.entry) * 100
      : null;

  return interaction.editReply(
    [
      `✅ You are in at **${quote.label}** — ${formatLag(lag)} after the call.`,
      behind === null
        ? ''
        : Math.abs(behind) < 0.5
          ? '_Same price the analyst got._'
          : behind > 0
            ? `_You paid **${formatPercent(behind)}** more than the analyst._`
            : `_You got in **${formatPercent(Math.abs(behind))}** cheaper than the analyst._`,
      '',
      'Your own result gets recorded when this closes. `/picks me` any time.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** The analyst console. Every button is gated on the analyst check. */
export async function handlePanelButton(interaction, { store, config }) {
  const action = panelAction(interaction.customId);
  if (!action) return undefined;

  if (!isAnalyst(interaction, config)) {
    return interaction.reply({
      content: 'Only the analysts can send calls.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (action === PANEL_ACTIONS.UP || action === PANEL_ACTIONS.DOWN) {
    // Size is part of the signal, so it is asked before the call goes out
    // rather than left for the room to guess.
    return interaction.editReply({
      content: `${DIRECTION_LABEL[DIRECTION_FOR_ACTION[action]]} — how much of the port?`,
      components: [entrySizeRow(DIRECTION_FOR_ACTION[action])],
    });
  }

  return postManagement(interaction, { store, config }, { action });
}

/** The second tap: the size, which is what actually sends the call. */
export async function handleSizeButton(interaction, { store, config }) {
  const chosen = parseSize(interaction.customId);
  if (!chosen) return undefined;

  if (!isAnalyst(interaction, config)) {
    return interaction.reply({
      content: 'Only the analysts can send calls.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // A modal has to be the first reply, so it cannot come after a deferral.
  if (chosen.custom) return interaction.showModal(customSizeModal(chosen.direction));

  await interaction.deferUpdate();

  const { pick, channel, reason, conflicting } = await openCall(interaction, { store, config }, {
    direction: chosen.direction,
    sizePercent: chosen.percent,
  });

  if (!pick) {
    return interaction.editReply({ content: whyNotPosted(reason, conflicting), components: [] });
  }

  return interaction.editReply({
    content:
      `${DIRECTION_LABEL[pick.direction]} **${pick.asset}** at **${chosen.percent}% of port** sent to ${channel}` +
      (pick.entry === null
        ? ' (no live price — you will grade it by hand).'
        : ` at **${formatPrice(pick.entry)}**.`),
    components: [],
  });
}

/** The size an analyst typed because the presets did not cover it. */
export async function handleSizeModal(interaction, { store, config }) {
  const direction = parseSizeModal(interaction.customId);
  if (!direction) return undefined;

  if (!isAnalyst(interaction, config)) {
    return interaction.reply({ content: 'Only the analysts can send calls.', flags: MessageFlags.Ephemeral });
  }

  const percent = readPercent(interaction.fields.getTextInputValue('percent'));
  if (percent === null) {
    return interaction.reply({
      content: `**${interaction.fields.getTextInputValue('percent')}** is not a percentage between 0 and 100.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { pick, channel, reason, conflicting } = await openCall(interaction, { store, config }, {
    direction,
    sizePercent: percent,
    note: interaction.fields.getTextInputValue('note')?.trim() || null,
  });

  if (!pick) return interaction.editReply(whyNotPosted(reason, conflicting));

  return interaction.editReply(
    `${DIRECTION_LABEL[pick.direction]} **${pick.asset}** at **${percent}% of port** sent to ${channel}` +
      (pick.entry === null ? ' (no live price).' : ` at ${priceLabel(pick, pick.entry)}.`),
  );
}

/** A member saying whether they actually made money on a closed call. */
export async function handleVoteButton(interaction, { store }) {
  const parsed = parseVote(interaction.customId);
  if (!parsed) return undefined;

  const vote = store.getVote(parsed.pickId);
  if (!vote) {
    return interaction.reply({ content: 'That vote is closed.', flags: MessageFlags.Ephemeral });
  }
  if (vote.resultPostedAt) {
    return interaction.reply({
      content: 'The result is already out — this one is settled.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const { changed, previous } = castVote(vote, interaction.user.id, parsed.choice);
  store.putVote(vote);

  const tally = tallyVote(vote);
  return interaction.reply({
    content:
      (changed && previous
        ? `Changed to **${parsed.choice === 'profit' ? 'profit' : 'loss'}**.`
        : `Counted — **${parsed.choice === 'profit' ? 'profit' : 'loss'}**.`) +
      ` ${tally.total} vote(s) so far.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Cashing out, cutting a loss, or holding.
 *
 * Both exits END the call, and both take the whole position — on Kalshi you
 * sell the contracts you hold, not a quarter of them. The exit is the moment
 * the analyst says get out, not fifteen minutes later: grading on the window
 * while ignoring the exit marks a call somebody took profit on as a loss
 * because price kept going, which is exactly what went wrong before.
 *
 * Holding changes nothing, so it leaves the call running.
 */
async function postManagement(interaction, { store, config }, { action, note = null }) {
  const settings = pickSettings(config);

  // Your own open call first — if you have one running, that is the one you
  // mean. Failing that, the room's: the console is shared, one call runs at a
  // time, and whoever is at the desk when it needs closing is not always the
  // one who opened it. Refusing there left a live call with nobody able to
  // close it but its author.
  const guildId = interaction.guildId ?? config.guildId;
  const openCalls = store
    .listPicks((pick) => pick.guildId === guildId && !pick.outcome)
    .sort((a, b) => b.createdAt - a.createdAt);

  const open = openCalls.find((pick) => pick.analystId === interaction.user.id) ?? openCalls[0];
  const someoneElses = Boolean(open) && open.analystId !== interaction.user.id;

  const channel = open?.channelId
    ? await interaction.client.channels.fetch(open.channelId).catch(() => null)
    : settings.channelId
      ? await interaction.client.channels.fetch(settings.channelId).catch(() => null)
      : interaction.channel;

  if (!channel?.isTextBased()) return interaction.editReply('I could not find where to post that.');

  if (!open && action !== PANEL_ACTIONS.HOLD) {
    // A dead end is not an answer. The usual reason a call is missing is that
    // it already closed — either an exit or the window running out — and saying
    // which turns "the button is broken" into "that one is already done".
    const last = store
      .listPicks((pick) => pick.guildId === guildId && pick.outcome)
      .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))[0];

    await repostPanel(interaction.client, config, channel.id);

    return interaction.editReply(
      last
        ? `There is no open call. The last one — ${DIRECTION_LABEL[last.direction]} **${last.asset}** ` +
          `${last.minutes}m by <@${last.analystId}> — closed ${time(Math.floor((last.settledAt ?? Date.now()) / 1000), 'R')} ` +
          `as **${OUTCOME_LABEL[last.outcome]}**` +
          `${last.closedBy === 'window' ? ' (the window ran out)' : ''}. Open a new one to trade again.`
        : 'No call has been opened yet. Start one with 🟢 BUY UP or 🔴 BUY DOWN.',
    );
  }

  // Priced on the same side the call was opened on, or the exit is measured
  // against a contract the analyst never held.
  const quote = await quoteFor(config, open?.asset ?? settings.defaultAsset, {
    direction: open?.direction ?? null,
    ticker: open?.marketTicker ?? null,
    closesAt: open?.closesAt ?? null,
  });

  const closes = CLOSING_ACTIONS.has(action);
  let verdict = null;

  if (closes && open) {
    verdict =
      quote.price !== null && open.entry !== null
        ? gradeQuote(open, quote.price)
        : {
            outcome: action === PANEL_ACTIONS.CUT_LOSS ? OUTCOMES.LOSS : OUTCOMES.WIN,
            changePercent: null,
          };

    settlePick(open, {
      outcome: verdict.outcome,
      settledBy: interaction.user.id,
      exit: quote.price,
      closedBy: 'exit',
    });
    open.changePercent = verdict.changePercent;
    store.putPick(open);
  }

  await channel.send({
    ...pingFor(settings),
    ...managementMessage({
      action,
      analystId: interaction.user.id,
      pick: open ? { ...open, entryLabel: open.entry == null ? null : formatPrice(open.entry) } : null,
      note,
      price: quote.price === null ? null : quote.label,
      verdict,
    }),
    allowedMentions: { roles: settings.pingRoleIds ?? [] },
    reply: open?.messageId ? { messageReference: open.messageId, failIfNotExists: false } : undefined,
  });

  if (!closes) {
    return interaction.editReply(
      open ? `Sent to ${channel}, on your open **${open.asset}** call.` : `Sent to ${channel}.`,
    );
  }

  await refreshCallMessage(interaction.client, config, open);
  const room = roomVersusAnalyst(store.listFollows(), open);
  await announce(
    interaction.client,
    config,
    simpleExit({
      pick: open,
      outcome: verdict.outcome,
      entryLabel: open.entry == null ? null : priceLabel(open, open.entry),
      exitLabel: open.exit == null ? null : priceLabel(open, open.exit),
      room,
    }),
  );
  await openVote(interaction.client, store, config, open);
  await repostPanel(interaction.client, config, channel.id);

  // The record follows the analyst who made the call, not whoever closed it.
  const record = computeRecord(store.listPicks(), { analystId: open.analystId });
  return interaction.editReply(
    `Closed ${someoneElses ? `<@${open.analystId}>'s` : 'your'} **${open.asset}** call as ` +
      `**${OUTCOME_LABEL[verdict.outcome]}**` +
      (quote.price === null ? ' (no price available).' : ` at ${quote.label}.`) +
      ` <@${open.analystId}> is now **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).`,
  );
}

/**
 * Puts the console back at the bottom of the channel after a call ends.
 *
 * A pinned panel is fifty messages up by the time a call closes, and the next
 * signal is the one nobody wants to go hunting for. Posted fresh rather than
 * moved, because Discord cannot move a message.
 */
/**
 * Opens the room's vote on a call that just closed.
 *
 * Asked where the members are talking rather than where the levels are posted:
 * a question nobody sees is a question nobody answers.
 */
export async function openVote(client, store, config, pick) {
  const settings = pickSettings(config);
  if (store.getVote(pick.id)) return null;

  const channelId = settings.announceChannelId ?? pick.channelId ?? settings.channelId;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const vote = emptyVote(pick.id, { closesAt: Date.now() + settings.voteMinutes * 60 * 1000 });
  vote.channelId = channel.id;

  const roleIds = settings.votePingRoleIds ?? [];
  const posted = await channel
    .send({
      content:
        `${roleIds.map((roleId) => `<@&${roleId}>`).join(' ')}\n`.trimStart() +
        `Did you make money on the **${pick.asset}** ${pick.minutes}m call?`,
      components: [voteRow(pick.id)],
      allowedMentions: { roles: roleIds },
    })
    .catch(() => null);

  vote.messageId = posted?.id ?? null;
  store.recordVote(vote);
  return vote;
}

/**
 * Publishes what the room said once the voting window has run out.
 *
 * The room's answer and the price feed's answer go out together: the two
 * disagreeing means the call was right but came too late to act on, and that is
 * the single most useful thing this whole feature can surface.
 */
export async function publishVoteResults(client, store, config, now = Date.now()) {
  const settings = pickSettings(config);
  const due = votesDue(store.listVotes(), now);
  let published = 0;

  for (const vote of due) {
    const pick = store.getPick(vote.pickId);
    if (!pick) {
      vote.resultPostedAt = now;
      store.putVote(vote);
      continue;
    }

    const channelId = settings.resultChannelId ?? pick.channelId ?? settings.channelId;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const tally = tallyVote(vote);
    await channel
      .send(
        voteResultMessage({
          pick,
          tally,
          outcome: pick.outcome,
          shareBarText: shareBar(tally.profitShare),
          sharePercent: formatShare(tally.profitShare),
        }),
      )
      .catch(() => null);

    // Closing the buttons stops a vote drifting on after its own result.
    if (vote.messageId && vote.channelId) {
      const voteChannel = await client.channels.fetch(vote.channelId).catch(() => null);
      await voteChannel?.messages
        ?.fetch(vote.messageId)
        .then((message) => message.edit({ components: [] }))
        .catch(() => null);
    }

    vote.resultPostedAt = now;
    store.putVote(vote);
    published += 1;
  }

  return published;
}

const lastPanelAt = new Map();

export async function repostPanel(client, config, channelId, { debounceMs = 30000 } = {}) {
  const settings = pickSettings(config);
  if (!settings.repostPanel) return false;

  const channel = await client.channels.fetch(channelId ?? settings.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  // The console comes back after every press of a closing button, including the
  // ones that found nothing to close — that is exactly the moment an analyst
  // wants to open a new call. Debounced so three impatient presses do not
  // produce three consoles.
  const now = Date.now();
  const last = lastPanelAt.get(channel.id) ?? 0;
  if (now - last < debounceMs) return false;
  lastPanelAt.set(channel.id, now);

  await channel.send(analystPanel(config, settings)).catch(() => null);
  return true;
}

/**
 * The call picker. Nobody knows a call's id, so the search runs over what a mod
 * would recognise instead: when it was, which way, and how it was scored.
 */
export async function handlePickAutocomplete(interaction, { store, config }) {
  const typed = (interaction.options.getFocused() ?? '').toLowerCase();

  const matches = store
    .listPicks((pick) => pick.guildId === (interaction.guildId ?? config.guildId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((pick) => ({ pick, label: describePick(pick) }))
    .filter(({ label }) => label.toLowerCase().includes(typed))
    .slice(0, 25)
    .map(({ pick, label }) => ({ name: label.slice(0, 100), value: pick.id }));

  return interaction.respond(matches).catch(() => {});
}

export async function handleSettleButton(interaction, { store, config }) {
  const [, , pickId, outcome] = interaction.customId.split(':');
  const pick = store.getPick(pickId);

  if (!pick) {
    return interaction.reply({ content: 'That call is no longer on record.', flags: MessageFlags.Ephemeral });
  }

  // The analyst grades their own calls; mods can step in when someone is away,
  // because an ungraded call sits in "open" forever and quietly flatters them.
  const isOwner = interaction.user.id === pick.analystId;
  const isMod =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    (config.modRoleIds ?? []).some((roleId) => interaction.member?.roles?.cache?.has(roleId));

  if (!isOwner && !isMod) {
    return interaction.reply({
      content: 'Only the analyst who made this call — or a mod — can grade it.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (pick.outcome) {
    return interaction.reply({
      content: `Already graded as **${OUTCOME_LABEL[pick.outcome]}**. A record cannot be edited after the fact.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  settlePick(pick, { outcome, settledBy: interaction.user.id });
  store.putPick(pick);

  const record = computeRecord(store.listPicks(), { analystId: pick.analystId });

  await refreshCallMessage(interaction.client, config, pick);
  await repostPanel(interaction.client, config, pick.channelId);

  await interaction.update({
    embeds: [pickEmbed(pick, config)],
    components: [],
    content: `${OUTCOME_LABEL[outcome]} — <@${pick.analystId}> is now **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).`,
  });

  return undefined;
}

/**
 * Asks for a grade on every call whose window has closed. Run on a timer.
 * Prompting once and recording that is deliberate: a bot that re-asks every
 * minute gets muted, and a muted bot collects no record at all.
 */
/**
 * Closes out every call whose window has run out.
 *
 * A call stamped with a live entry price grades itself: the price is what
 * settles a 15-minute "up or down", and asking a human to confirm what the tape
 * already says is how records end up half-finished and flattering. Only calls
 * with no usable price fall back to the buttons.
 */
/**
 * Publishes the analyst's real trades as calls, from the exchange's own record.
 *
 * Off unless KALSHI_AUTO_PUBLISH says otherwise, because this posts somebody's
 * money to a paying room without anyone pressing anything. When it is on, an
 * entry becomes a call at the price actually filled and the size actually
 * risked, and the exit closes it at the price actually received.
 *
 * Never throws: a feed that is down costs automation, not the room.
 */
export async function syncKalshiAccount(client, store, config, { fetchImpl } = {}) {
  const settings = pickSettings(config);
  const account = settings.kalshi?.account ?? {};
  if (!account.autoPublish || !hasCredentials(account)) return { published: 0, closed: 0 };

  const analystId = account.analystId ?? settings.autoAnalystId ?? null;

  const [fillsResult, balanceResult] = await Promise.all([
    fetchFills(account, { limit: 100, ...(fetchImpl ? { fetchImpl } : {}) }),
    fetchBalance(account, fetchImpl ? { fetchImpl } : {}),
  ]);
  if (fillsResult.error) {
    commandLog.warn(`Kalshi account: ${fillsResult.error}`);
    return { published: 0, closed: 0, error: fillsResult.error };
  }

  const positions = foldFills(fillsResult.fills, { seriesTicker: account.seriesTicker });
  const guildId = config.guildId;
  const mine = store.listPicks((pick) => pick.guildId === guildId);
  const plan = planPublication(positions, mine);

  let published = 0;
  let closed = 0;

  const channel = settings.channelId
    ? await client.channels.fetch(settings.channelId).catch(() => null)
    : null;

  for (const position of plan.open) {
    if (!channel?.isTextBased()) break;

    const now = position.openedAt ?? Date.now();
    const pick = buildPick({
      analystId,
      analystTag: account.analystTag ?? null,
      guildId,
      direction: position.direction,
      asset: settings.defaultAsset,
      minutes: settings.defaultMinutes,
      sizePercent: sizePercentOf(position, balanceResult.balanceCents) ?? 100,
      entry: position.entryCents,
      now,
    });
    pick.priceUnit = 'cents';
    pick.entrySource = `kalshi-fill:${position.ticker}`;
    pick.marketTicker = position.ticker;
    // Says out loud where this came from. A call nobody pressed a button for
    // should not be indistinguishable from one somebody did.
    pick.fromAccount = true;

    const posted = await channel
      .send({ ...pingFor(settings), embeds: [pickEmbed(pick, config)], components: [followRow(pick.id)] })
      .catch(() => null);
    if (!posted) continue;

    pick.messageId = posted.id;
    pick.channelId = channel.id;
    store.recordPick(pick);
    published += 1;

    await announce(client, config, simpleAnnouncement({
      ...pick,
      entryLabel: priceLabel(pick, pick.entry),
    }));
  }

  for (const { pick, position } of plan.close) {
    const verdict = gradeByContract(pick.entry, position.exitCents);
    settlePick(pick, {
      outcome: verdict?.outcome ?? OUTCOMES.BREAK_EVEN,
      settledBy: 'kalshi-fill',
      exit: position.exitCents,
      closedBy: 'exit',
      now: position.closedAt ?? Date.now(),
    });
    pick.changePercent = verdict?.changePercent ?? null;
    store.putPick(pick);
    closed += 1;

    await refreshCallMessage(client, config, pick);
    await announce(client, config, simpleExit({
      pick,
      outcome: pick.outcome,
      entryLabel: priceLabel(pick, pick.entry),
      exitLabel: priceLabel(pick, pick.exit),
      room: roomVersusAnalyst(store.listFollows(), pick),
    }));
    await openVote(client, store, config, pick);
  }

  if (published || closed) {
    commandLog.info(`Kalshi account: ${published} call(s) opened, ${closed} closed from real fills`);
  }
  return { published, closed };
}

export async function promptDueSettlements(client, store, config, now = Date.now()) {
  const due = dueForSettlement(store.listPicks(), now).filter((pick) => !pick.promptedAt);
  const settings = pickSettings(config);
  let graded = 0;
  let asked = 0;

  for (const pick of due) {
    const channel = await client.channels
      .fetch(pick.channelId ?? settings.channelId)
      .catch(() => null);
    if (!channel?.isTextBased()) continue;

    const quote =
      pick.entry === null
        ? { price: null, label: '—' }
        : await quoteFor(config, pick.asset, {
            direction: pick.direction,
            ticker: pick.marketTicker ?? null,
            closesAt: pick.closesAt,
          });
    const verdict = quote.price === null ? null : gradeQuote(pick, quote.price);

    if (verdict) {
      settlePick(pick, { outcome: verdict.outcome, settledBy: 'price-feed', exit: quote.price, now });
      pick.promptedAt = now;
      pick.changePercent = verdict.changePercent;
      store.putPick(pick);

      const record = computeRecord(store.listPicks(), { analystId: pick.analystId });
      await channel
        .send({
          content:
            `${OUTCOME_LABEL[verdict.outcome]} — <@${pick.analystId}>'s **${pick.asset}** ${pick.minutes}m call closed at ` +
            `**${quote.label}** (${formatChange(verdict.changePercent)} from ${priceLabel(pick, pick.entry)}). ` +
            `Now **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).`,
          embeds: [pickEmbed(pick, config)],
          allowedMentions: { users: [] },
        })
        .catch(() => null);

      await refreshCallMessage(client, config, pick);
      await announce(
        client,
        config,
        simpleExit({
          pick,
          outcome: verdict.outcome,
          entryLabel: pick.entry == null ? null : priceLabel(pick, pick.entry),
          exitLabel: pick.exit == null ? null : priceLabel(pick, pick.exit),
          room: roomVersusAnalyst(store.listFollows(), pick),
        }),
      );
      await openVote(client, store, config, pick);
      await repostPanel(client, config, channel.id);
      graded += 1;
      continue;
    }

    // No price to settle it with, so the analyst has to say.
    await channel
      .send({
        content: `<@${pick.analystId}> your **${pick.asset}** ${pick.minutes}m call is up, and I could not read a price. How did it go?`,
        embeds: [pickEmbed(pick, config)],
        components: [settleRow(pick.id)],
        allowedMentions: { users: [pick.analystId] },
      })
      .catch(() => null);

    pick.promptedAt = now;
    store.putPick(pick);
    asked += 1;
  }

  return { graded, asked, prompted: graded + asked };
}
