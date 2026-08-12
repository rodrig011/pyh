import { pickSettings } from './commands.js';

/**
 * On startup, catch the exact class of bug that has already cost real
 * debugging time live: a channel id that is unset, mistyped, or — the one
 * that actually happened — accidentally the same as another room's, which
 * silently merges two rooms that were supposed to stay apart. Nothing here
 * is fatal; every problem is reported so it shows up on the first restart
 * rather than the first time a call lands in the wrong channel.
 */
export async function checkPicksChannelSetup(guild, config) {
  const problems = [];
  const settings = pickSettings(config);

  const checkChannel = async (id, label) => {
    if (!id) return;
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel) {
      problems.push(`${label}: channel ${id} does not exist in this server, or the bot cannot see it.`);
    }
  };

  await checkChannel(settings.channelId, 'PICKS_CHANNEL_ID');
  await checkChannel(settings.free?.channelId, 'PICKS_FREE_CHANNEL_ID');
  await checkChannel(settings.parlayChannelId, 'PARLAY_CHANNEL_ID');
  await checkChannel(settings.parlayFreeChannelId, 'PARLAY_FREE_CHANNEL_ID');

  if (settings.free?.channelId && settings.free.channelId === settings.channelId) {
    problems.push(
      'PICKS_FREE_CHANNEL_ID is the same as PICKS_CHANNEL_ID — the free room and the VIP room would be ' +
        'the same channel, silently merging both. Every call would land in the one room.',
    );
  }
  if (settings.parlayFreeChannelId && settings.parlayFreeChannelId === settings.parlayChannelId) {
    problems.push(
      'PARLAY_FREE_CHANNEL_ID is the same as PARLAY_CHANNEL_ID — same problem, for sports parlays.',
    );
  }

  const checkRole = async (id, label) => {
    if (!id) return;
    const role = await guild.roles.fetch(id).catch(() => null);
    if (!role) problems.push(`${label}: role ${id} does not exist in this server.`);
  };

  for (const id of settings.analystRoleIds ?? []) await checkRole(id, 'PICKS_ANALYST_ROLE_IDS');
  for (const id of settings.parlayAnalystRoleIds ?? []) await checkRole(id, 'PARLAY_ANALYST_ROLE_IDS');

  return problems;
}
