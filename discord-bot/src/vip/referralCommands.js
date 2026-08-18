import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import {
  REFERRAL_REWARD_DOLLARS,
  buildReferralClaim,
  markReferralPaid,
  outstandingPayouts,
  referralBalance,
} from './referrals.js';

/**
 * Same trust boundary as /vip-admin — deliberately not shared code with
 * vip/commands.js's own isMod, since importing from there would import this
 * file right back (buildCommands there registers /referral, which lives
 * here). Six lines duplicated is cheaper than a circular import.
 */
function isReferralMod(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if ((config.modRoleIds ?? []).length > 0) {
    return config.modRoleIds.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  }
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
}

export function buildReferralCommand() {
  const command = new SlashCommandBuilder()
    .setName('referral')
    .setDescription(`Bring a member who pays, earn $${REFERRAL_REWARD_DOLLARS}`)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('claim')
        .setDescription('Say who referred you here, before you buy')
        .addUserOption((option) => option.setName('referrer').setDescription('Who sent you').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('balance').setDescription('What you have earned so far'))
    .addSubcommand((sub) =>
      sub.setName('payouts').setDescription('Mods: everyone still owed a referral reward'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('markpaid')
        .setDescription('Mods: mark a referrer as paid out')
        .addUserOption((option) => option.setName('member').setDescription('Who got paid').setRequired(true)),
    );

  return [command.toJSON()];
}

const money = (n) => `$${n.toFixed(2)}`;

export async function handleReferralCommand(interaction, { store, config }) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId ?? config.guildId;

  if (sub === 'claim') {
    const referrer = interaction.options.getUser('referrer');
    const existing = store.getReferralClaim(interaction.user.id);
    if (existing) {
      return interaction.reply({
        content:
          existing.referrerId === referrer.id
            ? `You already said <@${existing.referrerId}> referred you — nothing to change.`
            : `You already claimed <@${existing.referrerId}> as your referrer. A referral can only be claimed once, so it cannot be changed.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let claim;
    try {
      claim = buildReferralClaim({ referredId: interaction.user.id, referrerId: referrer.id, guildId });
    } catch (error) {
      return interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
    }

    store.recordReferralClaim(claim);
    return interaction.reply({
      content:
        `Got it — <@${referrer.id}> is on record as who referred you. ` +
        `They earn $${REFERRAL_REWARD_DOLLARS} the moment your first payment clears.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'balance') {
    const balance = referralBalance(store.listReferralClaims((claim) => claim.guildId === guildId), interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('🤝 Your referrals')
      .addFields(
        { name: 'Referred', value: String(balance.referred), inline: true },
        { name: 'Converted', value: String(balance.converted), inline: true },
        { name: 'Pending', value: String(balance.pending), inline: true },
        { name: 'Earned', value: money(balance.earnedDollars), inline: true },
        { name: 'Paid out', value: money(balance.paidDollars), inline: true },
        { name: 'Still owed', value: `**${money(balance.owedDollars)}**`, inline: true },
      )
      .setFooter({ text: 'Referred = claimed you. Converted = they actually paid.' });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'payouts') {
    if (!isReferralMod(interaction, config)) {
      return interaction.reply({ content: 'Mods only.', flags: MessageFlags.Ephemeral });
    }

    const rows = outstandingPayouts(store.listReferralClaims((claim) => claim.guildId === guildId));
    if (rows.length === 0) {
      return interaction.reply({ content: 'Nobody is owed a referral payout right now.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('🤝 Referral payouts owed')
      .setDescription(
        rows.map((row) => `<@${row.referrerId}> — **${money(row.owedDollars)}** (${row.converted} converted)`).join('\n'),
      )
      .setFooter({ text: 'Pay by hand, then run /referral markpaid — same as every other payment in this bot.' });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'markpaid') {
    if (!isReferralMod(interaction, config)) {
      return interaction.reply({ content: 'Mods only.', flags: MessageFlags.Ephemeral });
    }

    const member = interaction.options.getUser('member');
    const owed = store.listReferralClaims(
      (claim) => claim.guildId === guildId && claim.referrerId === member.id && claim.creditedAt && !claim.paidAt,
    );

    if (owed.length === 0) {
      return interaction.reply({
        content: `<@${member.id}> has nothing outstanding to mark paid.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let total = 0;
    for (const claim of owed) {
      const paid = markReferralPaid(claim);
      store.putReferralClaim(paid);
      total += paid.rewardDollars;
    }

    return interaction.reply(
      `Marked ${owed.length} referral(s) from <@${member.id}> as paid — ${money(total)} total.`,
    );
  }

  return undefined;
}
