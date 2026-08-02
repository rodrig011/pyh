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
  ACTION_PERCENT,
  CASH_MODAL,
  CLOSING_ACTIONS,
  DIRECTION_FOR_ACTION,
  PANEL_ACTIONS,
  PANEL_PREFIX,
  analystPanel,
  cashPercentModal,
  guideMessage,
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
  repostPanel: true,
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
    );

  return [call.toJSON(), picks.toJSON()];
}

/** Only the analysts may call. Administrators always pass. */
export function isAnalyst(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = [...pickSettings(config).analystRoleIds, ...(config.modRoleIds ?? [])];
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
    fields.push({ name: 'Entry', value: formatPrice(pick.entry), inline: true });
  }
  if (pick.target != null) fields.push({ name: 'Target', value: formatPrice(pick.target), inline: true });
  if (pick.stop != null) {
    fields.push({ name: 'Invalidation', value: formatPrice(pick.stop), inline: true });
  }

  if (settled) {
    fields.push({
      name: 'Result',
      value:
        `${OUTCOME_LABEL[pick.outcome]}` +
        (pick.exit != null ? ` at ${formatPrice(pick.exit)}` : '') +
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

  if (sub === 'guide') {
    if (!isAnalyst(interaction, config)) {
      return interaction.editReply('Only the analysts and mods can post the guide.');
    }
    const help = postPermissionHelp(interaction.channel, interaction.guild);
    if (help) return interaction.editReply(help);

    await interaction.channel.send(guideMessage(config, pickSettings(config)));
    return interaction.editReply('Guide posted. **Pin it** — the buttons only work if the room reads them the same way.');
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

  return postManagement(interaction, { store, config }, {
    action,
    percent: ACTION_PERCENT[action] ?? null,
  });
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

/**
 * Cash out, cut the loss, or hold.
 *
 * Cashing out and cutting a loss END the call: the exit is the moment the
 * analyst says get out, not fifteen minutes later. Grading on the window while
 * ignoring the exit marks a call the analyst took profit on as a loss because
 * price kept going — which is what happened, and it is the whole complaint.
 *
 * Holding changes nothing, so it leaves the call running.
 */
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

  if (!open && action !== PANEL_ACTIONS.HOLD) {
    return interaction.editReply(
      'You have no open call to close. Open one with 🟢 BUY UP or 🔴 BUY DOWN first — ' +
        'otherwise there is nothing for the room to act on and nothing to score.',
    );
  }

  const quote = await fetchSpotPrice(open?.asset ?? settings.defaultAsset);

  // A partial take leaves the position on; only a full exit closes the call.
  const closes = CLOSING_ACTIONS.has(action);
  let verdict = null;

  if (closes && open) {
    verdict =
      quote.price !== null && open.entry !== null
        ? gradeByPrice(open.direction, open.entry, quote.price)
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
      percent,
      note,
      price: quote.price === null ? null : formatPrice(quote.price),
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

  await repostPanel(interaction.client, config, channel.id);

  const record = computeRecord(store.listPicks(), { analystId: interaction.user.id });
  return interaction.editReply(
    `Closed your **${open.asset}** call as **${OUTCOME_LABEL[verdict.outcome]}**` +
      (quote.price === null ? ' (no price available).' : ` at ${formatPrice(quote.price)}.`) +
      ` You are now **${formatWinRate(record.winRate)}** (${record.wins}W ${record.losses}L).`,
  );
}

/**
 * Puts the console back at the bottom of the channel after a call ends.
 *
 * A pinned panel is fifty messages up by the time a call closes, and the next
 * signal is the one nobody wants to go hunting for. Posted fresh rather than
 * moved, because Discord cannot move a message.
 */
export async function repostPanel(client, config, channelId) {
  const settings = pickSettings(config);
  if (!settings.repostPanel) return false;

  const channel = await client.channels.fetch(channelId ?? settings.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  await channel.send(analystPanel(config, settings)).catch(() => null);
  return true;
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
