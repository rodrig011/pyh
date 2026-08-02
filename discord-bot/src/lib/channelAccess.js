import { PermissionFlagsBits } from 'discord.js';

/** What the bot must hold in a channel before it can post a panel there. */
export const POST_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
  { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
  { flag: PermissionFlagsBits.EmbedLinks, name: 'Embed Links' },
];

/**
 * Which of those the bot is missing in this channel.
 *
 * The channels panels belong in are usually locked so members cannot type, and
 * that deny lands on the bot as well — the single most likely way posting
 * fails, and the one that otherwise surfaces as a generic error a mod cannot
 * act on. Shared so every panel reports it the same way instead of each one
 * rediscovering it.
 *
 * @returns {string[]} human names of the missing permissions, empty when fine
 */
export function missingPostPermissions(channel, guild) {
  const me = guild?.members?.me;
  if (!me || typeof channel?.permissionsFor !== 'function') return [];
  const mine = channel.permissionsFor(me);
  if (!mine) return [];
  return POST_PERMISSIONS.filter((permission) => !mine.has(permission.flag)).map(
    (permission) => permission.name,
  );
}

/** The sentence a mod can act on, or null when there is nothing to fix. */
export function postPermissionHelp(channel, guild) {
  const missing = missingPostPermissions(channel, guild);
  if (missing.length === 0) return null;
  return (
    `I cannot post in ${channel}. Missing: **${missing.join('**, **')}**.\n\n` +
    `Fix it in **${channel.name} → Edit Channel → Permissions → add the bot's role**, ` +
    'turn those on, then run this again.'
  );
}
