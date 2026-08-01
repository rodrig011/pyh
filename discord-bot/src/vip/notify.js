import { createLogger } from '../lib/logger.js';

const log = createLogger('notify');

/** Posts an embed to the audit channel, if one is configured. */
export async function sendLog(client, config, embed) {
  if (!config.logChannelId) return false;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased()) return false;
    await channel.send({ embeds: [embed] });
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
