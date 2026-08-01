import { createLogger } from '../lib/logger.js';

const log = createLogger('notify');

/**
 * Posts an embed to the audit channel, if one is configured.
 *
 * `ping: true` mentions the mod roles — used for money events, where the point
 * is that somebody looks now rather than whenever they next scroll the channel.
 * allowedMentions is set explicitly so the bot can only ever ping those roles,
 * never @everyone, whatever ends up inside an embed.
 */
export async function sendLog(client, config, embed, { ping = false } = {}) {
  if (!config.logChannelId) return false;

  const roleIds = ping && config.pingModsOnPayment !== false ? config.modRoleIds ?? [] : [];

  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased()) return false;
    await channel.send({
      content: roleIds.map((roleId) => `<@&${roleId}>`).join(' ') || undefined,
      embeds: [embed],
      allowedMentions: { roles: roleIds },
    });
    return true;
  } catch (error) {
    log.warn(`Could not write to the log channel: ${error.message}`);
    return false;
  }
}

/** DMs a user. Fails softly: closed DMs must never break the flow that called this. */
export async function sendDm(client, userId, embed) {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    log.warn(`Could not DM ${userId}: ${error.message}`);
    return false;
  }
}
