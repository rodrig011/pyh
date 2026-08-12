import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { isParlayAnalyst, parlayCallerRoleIds, pickSettings } from './commands.js';
import { PARLAY_OUTCOMES, buildParlay, parlayLeaderboard, settleParlay } from './parlay.js';

export const PARLAY_PREFIX = 'parlay:settle:';

export function buildParlayCommand(config) {
  const command = new SlashCommandBuilder()
    .setName('parlay')
    .setDescription('Post and track sports parlays — a separate board from the Kalshi calls')
    .setDMPermission(false)
    // Discord can gate visibility on a permission bit but never on a role, so
    // the isParlayAnalyst() check inside is the real authority — this only
    // decides who sees the command at all.
    .setDefaultMemberPermissions(
      parlayCallerRoleIds(config).length > 0 ? null : PermissionFlagsBits.ManageMessages,
    )
    .addSubcommand((sub) =>
      sub
        .setName('post')
        .setDescription('Post a parlay to the sports channel')
        .addStringOption((option) =>
          option.setName('legs').setDescription('The legs, however you write them').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('odds').setDescription('e.g. +250, or 3.5x').setRequired(false),
        )
        .addNumberOption((option) =>
          option.setName('units').setDescription('How many units risked').setRequired(false),
        )
        .addStringOption((option) => option.setName('note').setDescription('Anything else').setRequired(false)),
    )
    .addSubcommand((sub) => sub.setName('board').setDescription('Win rate by whoever has posted parlays'));

  return [command.toJSON()];
}

function parlayEmbed(parlay, { verdict = null } = {}) {
  const colour =
    parlay.outcome === PARLAY_OUTCOMES.WIN
      ? COLORS.success
      : parlay.outcome === PARLAY_OUTCOMES.LOSS
        ? COLORS.danger
        : parlay.outcome === PARLAY_OUTCOMES.PUSH
          ? COLORS.warning
          : COLORS.gold;

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setTitle('🏀 Sports parlay')
    .setDescription(parlay.legs)
    .setFooter({ text: `Called by ${parlay.analystTag ?? 'an analyst'}` })
    .setTimestamp(parlay.createdAt);

  if (parlay.odds) embed.addFields({ name: 'Odds', value: parlay.odds, inline: true });
  if (parlay.units !== null) embed.addFields({ name: 'Units', value: String(parlay.units), inline: true });
  if (parlay.note) embed.addFields({ name: 'Note', value: parlay.note });

  if (parlay.outcome) {
    embed.addFields({
      name: 'Result',
      value:
        parlay.outcome === PARLAY_OUTCOMES.WIN
          ? '✅ WIN'
          : parlay.outcome === PARLAY_OUTCOMES.LOSS
            ? '❌ LOSS'
            : '➖ PUSH',
    });
  }

  if (verdict) embed.addFields({ name: 'Note', value: verdict });

  return embed;
}

function parlayRow(parlayId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PARLAY_PREFIX}${parlayId}:${PARLAY_OUTCOMES.WIN}`)
      .setStyle(ButtonStyle.Success)
      .setLabel('WIN')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PARLAY_PREFIX}${parlayId}:${PARLAY_OUTCOMES.LOSS}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('LOSS')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PARLAY_PREFIX}${parlayId}:${PARLAY_OUTCOMES.PUSH}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('PUSH')
      .setDisabled(disabled),
  );
}

export async function handleParlayCommand(interaction, { store, config }) {
  const sub = interaction.options.getSubcommand();
  const settings = pickSettings(config);

  if (sub === 'post') {
    if (!isParlayAnalyst(interaction, config)) {
      return interaction.reply({
        content: 'Only the analysts and mods can post a parlay.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let parlay;
    try {
      parlay = buildParlay({
        analystId: interaction.user.id,
        analystTag: interaction.user.tag,
        guildId: interaction.guildId ?? config.guildId,
        legs: interaction.options.getString('legs'),
        odds: interaction.options.getString('odds'),
        units: interaction.options.getNumber('units'),
        note: interaction.options.getString('note'),
      });
    } catch (error) {
      return interaction.editReply(error.message);
    }

    // The free parlay channel is its own room — posted to when the command
    // was run there, same as the picks console. Any other channel keeps the
    // old behaviour exactly: the configured PARLAY_CHANNEL_ID, or wherever
    // the command was run if that is unset.
    const inFreeRoom = Boolean(settings.parlayFreeChannelId) && interaction.channel?.id === settings.parlayFreeChannelId;
    const targetChannelId = inFreeRoom ? settings.parlayFreeChannelId : settings.parlayChannelId;
    const channel = targetChannelId
      ? await interaction.client.channels.fetch(targetChannelId).catch(() => null)
      : interaction.channel;

    if (!channel?.isTextBased()) {
      return interaction.editReply('I cannot post the parlay — check `PARLAY_CHANNEL_ID` and that I can write there.');
    }

    const posted = await channel.send({ embeds: [parlayEmbed(parlay)], components: [parlayRow(parlay.id)] });
    parlay.messageId = posted.id;
    parlay.channelId = channel.id;
    store.recordParlay(parlay);

    return interaction.editReply(`Parlay posted to ${channel}. Come back to the same message to grade it.`);
  }

  if (sub === 'board') {
    const board = parlayLeaderboard(store.listParlays((parlay) => parlay.guildId === (interaction.guildId ?? config.guildId)));

    if (board.length === 0) {
      return interaction.reply({
        content: 'No graded parlays yet — post one with `/parlay post` and settle it once the game ends.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('🏀 Parlay board')
      .setDescription(
        board
          .map(
            (row, index) =>
              `**${index + 1}.** <@${row.analystId}> — **${row.wins}-${row.losses}${row.pushes ? `-${row.pushes}` : ''}** ` +
              `(${Math.round(row.winRate * 100)}%)`,
          )
          .join('\n'),
      );

    return interaction.reply({ embeds: [embed] });
  }
}

export async function handleParlayButton(interaction, { store, config }) {
  const rest = interaction.customId.slice(PARLAY_PREFIX.length);
  const [parlayId, outcome] = rest.split(':');
  const parlay = store.getParlay(parlayId);
  if (!parlay) {
    return interaction.reply({ content: 'This parlay no longer exists.', flags: MessageFlags.Ephemeral });
  }

  // The caller, or a mod — same trust boundary as closing a trading call.
  const isOwner = interaction.user.id === parlay.analystId;
  const isMod =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    (config.modRoleIds ?? []).some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  if (!isOwner && !isMod) {
    return interaction.reply({ content: 'Only the analyst who called it, or a mod, can grade this.', flags: MessageFlags.Ephemeral });
  }

  const settled = settleParlay(parlay, outcome);
  store.putParlay(settled);

  await interaction.update({
    embeds: [parlayEmbed(settled)],
    components: [parlayRow(settled.id, { disabled: true })],
  });
}
