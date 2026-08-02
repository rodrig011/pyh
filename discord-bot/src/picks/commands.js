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
  CASH_MODAL,
  DIRECTION_FOR_ACTION,
  PANEL_ACTIONS,
  PANEL_PREFIX,
  analystPanel,
  cashPercentModal,
  managementMessage,
  panelAction,
} from './panel.js';
import { fetchSpotPrice, formatChange, formatPrice, gradeByPrice } from './price.js';
import {
  DIRECTIONS,
  DIRECTION_LABEL,
  OUTCOMES,
  OUTCOME_LABEL,
  buildPick,
  computeRecord,
  dueForSettlement,
  formatStreak,
  formatWinRate,
  leaderboard,
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
    // Visibility is gated on a permission bit because Discord cannot gate on a
    // role; the analyst check in code is the real authority.
    .setDefaultMemberPermissions(
      settings.analystRoleIds.length > 0 ? null : PermissionFlagsBits.ManageMessages,
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
      sub.setName('panel').setDescription('Post the analyst console (analysts only can press it)'),
    )
    .addSubcommand((sub) =>
      sub.setName('price').setDescription('Check the live price feed the bot grades calls with'),
    );

  return [call.toJSON(), picks.toJSON()];
}

/** Only the analysts may call. Administrators always pass. */
export function isAnalyst(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = [...pickSettings(config).analystRoleIds, ...(config.modRoleIds ?? [])];
  if (allowed.length === 0) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));
  }
  const roles = interaction.member?.roles?.cache;
  return Boolean(roles && allowed.some((roleId) => roles.has(roleId)));
}

export function pickEmbed(pick, config) {
  const closes = Math.floor(pick.closesAt / 1000);
  const fields = [
    { name: 'Direction', value: DIRECTION_LABEL[pick.direction], inline: true },
    { name: 'Window', value: `${pick.minutes} min — closes ${time(closes, 'R')}`, inline: true },
  ];

  if (pick.entry !== null) fields.push({ name: 'Entry', value: `\`${pick.entry}\``, inline: true });
  if (pick.target !== null) fields.push({ name: 'Target', value: `\`${pick.target}\``, inline: true });
  if (pick.stop !== null) fields.push({ name: 'Invalidation', value: `\`${pick.stop}\``, inline: true });

  if (pick.outcome) {
    fields.push({
      name: 'Result',
      value: `${OUTCOME_LABEL[pick.outcome]}${pick.exit !== null ? ` at \`${pick.exit}\`` : ''}`,
    });
  }

  const colour = pick.outcome
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
 * Opens a call and posts it. Shared by `/call` and the console buttons, so the
 * two can never drift into recording different things.
 */
export async function openCall(interaction, { store, config }, overrides = {}) {
  const settings = pickSettings(config);
  const asset = overrides.asset ?? settings.defaultAsset;

  // The price at the moment of the call is what makes it gradeable later. A
  // feed that is down must not block the call — it only costs automatic
  // grading, and the analyst can still settle it by hand.
  let entry = overrides.entry ?? null;
  let priceSource = null;
  if (entry === null) {
    const quote = await fetchSpotPrice(asset);
    entry = quote.price;
    priceSource = quote.source;
  }

  const pick = buildPick({
    analystId: interaction.user.id,
    analystTag: interaction.user.tag,
    guildId: interaction.guildId ?? config.guildId,
    direction: overrides.direction,
    asset,
    minutes: overrides.minutes ?? settings.defaultMinutes,
    entry,
    target: overrides.target ?? null,
    stop: overrides.stop ?? null,
    note: overrides.note ?? null,
  });
  pick.entrySource = priceSource;

  const channel = settings.channelId
    ? await interaction.client.channels.fetch(settings.channelId).catch(() => null)
    : interaction.channel;

  if (!channel?.isTextBased()) return { pick: null, channel: null };

  const posted = await channel.send({
    ...pingFor(settings),
    embeds: [pickEmbed(pick, config)],
  });
  pick.messageId = posted.id;
  pick.channelId = channel.id;
  store.recordPick(pick);

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

  const { pick, channel } = await openCall(interaction, { store, config }, {
    direction: interaction.options.getString('direction'),
    asset: interaction.options.getString('asset'),
    minutes: interaction.options.getInteger('minutes'),
    entry: interaction.options.getNumber('entry'),
    target: interaction.options.getNumber('target'),
    stop: interaction.options.getNumber('stop'),
    note: interaction.options.getString('note'),
  });

  if (!pick) {
    return interaction.editReply(
      'I cannot post the call — check `PICKS_CHANNEL_ID` and that I can write there.',
    );
  }

  return interaction.editReply(
    `Call posted in ${channel}. ` +
      (pick.entry === null
        ? 'No live price was available, so you will be asked to grade it by hand.'
        : `Stamped at **${formatPrice(pick.entry)}** — it grades itself when the window closes.`),
  );
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

  // "Cash at a percent" needs the percent, and a modal must be the first reply
  // to the interaction — so it cannot be deferred first.
  if (action === PANEL_ACTIONS.CASH_PERCENT) {
    return interaction.showModal(cashPercentModal());
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (action === PANEL_ACTIONS.UP || action === PANEL_ACTIONS.DOWN) {
    const { pick, channel } = await openCall(interaction, { store, config }, {
      direction: DIRECTION_FOR_ACTION[action],
    });
    if (!pick) return interaction.editReply('I could not post that — check where calls go.');
    return interaction.editReply(
      `${DIRECTION_LABEL[pick.direction]} **${pick.asset}** sent to ${channel}` +
        (pick.entry === null ? ' (no live price — you will grade it by hand).' : ` at **${formatPrice(pick.entry)}**.`),
    );
  }

  return postManagement(interaction, { store, config }, { action });
}

export async function handleCashModal(interaction, { store, config }) {
  if (!isAnalyst(interaction, config)) {
    return interaction.reply({ content: 'Only the analysts can send calls.', flags: MessageFlags.Ephemeral });
  }

  const raw = interaction.fields.getTextInputValue('percent');
  const percent = Number.parseFloat(String(raw).replace('%', '').trim());
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return interaction.reply({
      content: `**${raw}** is not a percentage between 0 and 100.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return postManagement(interaction, { store, config }, {
    action: PANEL_ACTIONS.CASH_PERCENT,
    percent,
    note: interaction.fields.getTextInputValue('note')?.trim() || null,
  });
}

/** Posts a cash-out or hold against the analyst's most recent open call. */
async function postManagement(interaction, { store, config }, { action, percent = null, note = null }) {
  const settings = pickSettings(config);

  const open = store
    .listPicks((pick) => pick.analystId === interaction.user.id && !pick.outcome)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const channel = open?.channelId
    ? await interaction.client.channels.fetch(open.channelId).catch(() => null)
    : settings.channelId
      ? await interaction.client.channels.fetch(settings.channelId).catch(() => null)
      : interaction.channel;

  if (!channel?.isTextBased()) return interaction.editReply('I could not find where to post that.');

  const quote = await fetchSpotPrice(open?.asset ?? settings.defaultAsset);

  await channel.send({
    ...pingFor(settings),
    ...managementMessage({
      action,
      analystId: interaction.user.id,
      pick: open ?? null,
      percent,
      note,
      price: quote.price === null ? null : formatPrice(quote.price),
    }),
    allowedMentions: { roles: pickSettings(config).pingRoleIds ?? [] },
    reply: open?.messageId ? { messageReference: open.messageId, failIfNotExists: false } : undefined,
  });

  return interaction.editReply(
    open
      ? `Sent to ${channel}, attached to your open **${open.asset}** call.`
      : `Sent to ${channel}. You have no open call, so it went out on its own.`,
  );
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

    const quote = pick.entry === null ? { price: null } : await fetchSpotPrice(pick.asset);
    const verdict =
      quote.price === null ? null : gradeByPrice(pick.direction, pick.entry, quote.price);

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
            `**${formatPrice(quote.price)}** (${formatChange(verdict.changePercent)} from ${formatPrice(pick.entry)}). ` +
            `Now **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).`,
          embeds: [pickEmbed(pick, config)],
          allowedMentions: { users: [] },
        })
        .catch(() => null);

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
