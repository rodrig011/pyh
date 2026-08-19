import { PermissionFlagsBits } from 'discord.js';

/** What the bot must hold in a channel to police it. */
export const WATCH_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
  { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
];

/**
 * Turns a resolved channel into a verdict about whether it can be policed.
 *
 * Split out from the fetching so the reporting can be checked without Discord.
 * `channel` is null when the id resolved to nothing — a wrong id, a channel in
 * a server the bot was never invited to, or one it cannot see. All three look
 * the same from the config file and none of them look like a problem.
 *
 * @returns {{id: string, ok: boolean, label: string}}
 */
export function describeChannel(id, channel, botMember, { warn = false } = {}) {
  if (!channel) {
    return {
      id,
      ok: false,
      label: `❌ ${id} — no such channel. Wrong id, or the bot is not in that server.`,
    };
  }

  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
    return { id, ok: false, label: `❌ ${id} — that is not a text channel.` };
  }

  const mine = botMember && channel.permissionsFor ? channel.permissionsFor(botMember) : null;
  const missing = mine
    ? WATCH_PERMISSIONS.filter((permission) => !mine.has(permission.flag)).map((p) => p.name)
    : [];

  const where = `#${channel.name}${channel.guild?.name ? ` in ${channel.guild.name}` : ''}`;
  if (missing.length > 0) {
    return { id, ok: false, label: `❌ ${where} — missing ${missing.join(', ')}.` };
  }

  // Deleting and speaking are separate permissions, and a locked channel
  // routinely grants the first without the second. Policing still works, so
  // this is a warning rather than a failure — but silently swallowed notices
  // look to the members like the server is eating their messages.
  const mute = warn && mine && !mine.has(PermissionFlagsBits.SendMessages);
  return {
    id,
    ok: true,
    label: mute
      ? `⚠️ ${where} — deleting works, but it cannot post the "photos only" notice: missing Send Messages. ` +
        'Grant it in the channel, or set PHOTO_ONLY_WARN=false to delete silently.'
      : `✅ ${where} — watching.`,
  };
}

/**
 * Checks every configured channel for real.
 *
 * "Watching 1 channel(s)" counted the entries in an environment variable and
 * proved nothing: a wrong id, a channel in another server and a channel the bot
 * cannot see all produced the same reassuring line while nothing was policed.
 */
export async function checkWatchedChannels(client, config) {
  const results = [];

  for (const id of config.channelIds) {
    const channel = await client.channels.fetch(id).catch(() => null);
    const botMember = channel?.guild?.members?.me ?? null;
    results.push(describeChannel(id, channel, botMember, { warn: config.warn }));
  }

  return results;
}

/**
 * Whether a command registration failure was Discord refusing for lack of the
 * applications.commands scope, which is by far the likeliest cause and is fixed
 * by re-inviting rather than by anything in the code.
 */
export function isMissingCommandScope(error) {
  const message = String(error?.message ?? '');
  return /Missing Access/i.test(message) || error?.code === 50001;
}
