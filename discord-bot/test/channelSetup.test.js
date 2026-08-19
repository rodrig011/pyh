import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPicksChannelSetup } from '../src/picks/channelSetup.js';

/**
 * The startup check for the exact class of bug that already cost real
 * debugging time live: PICKS_FREE_CHANNEL_ID unset, mistyped, or the same as
 * PICKS_CHANNEL_ID. Nothing here blocks startup — every problem is a warning
 * a mod can act on, surfaced the moment the bot comes up instead of the
 * moment somebody notices a call landed in the wrong channel.
 */

function fakeGuild({ channels = [], roles = [] } = {}) {
  const channelIds = new Set(channels);
  const roleIds = new Set(roles);
  return {
    channels: { fetch: async (id) => (channelIds.has(id) ? { id } : null) },
    roles: { fetch: async (id) => (roleIds.has(id) ? { id } : null) },
  };
}

const baseConfig = {
  picks: {
    channelId: 'vip-picks',
    parlayChannelId: 'vip-parlay',
    analystRoleIds: [],
    parlayAnalystRoleIds: [],
    free: { channelId: null },
  },
};

test('a fully valid setup reports nothing', async () => {
  const guild = fakeGuild({ channels: ['vip-picks', 'vip-parlay', 'free-picks', 'free-parlay'] });
  const config = {
    picks: {
      ...baseConfig.picks,
      free: { channelId: 'free-picks' },
      parlayFreeChannelId: 'free-parlay',
    },
  };

  const problems = await checkPicksChannelSetup(guild, config);
  assert.deepEqual(problems, []);
});

test('a channel id the bot cannot see is reported by name', async () => {
  const guild = fakeGuild({ channels: [] });
  const config = { picks: { ...baseConfig.picks, free: { channelId: 'ghost-channel' } } };

  const problems = await checkPicksChannelSetup(guild, config);
  assert.ok(problems.some((p) => p.includes('PICKS_FREE_CHANNEL_ID') && p.includes('ghost-channel')));
});

test('the free channel matching the VIP channel is caught, not silently merged', async () => {
  const guild = fakeGuild({ channels: ['vip-picks'] });
  const config = { picks: { ...baseConfig.picks, free: { channelId: 'vip-picks' } } };

  const problems = await checkPicksChannelSetup(guild, config);
  assert.ok(problems.some((p) => p.includes('PICKS_FREE_CHANNEL_ID') && p.includes('same as PICKS_CHANNEL_ID')));
});

test('the free parlay channel matching the VIP parlay channel is caught the same way', async () => {
  const guild = fakeGuild({ channels: ['vip-parlay'] });
  const config = { picks: { ...baseConfig.picks, parlayFreeChannelId: 'vip-parlay' } };

  const problems = await checkPicksChannelSetup(guild, config);
  assert.ok(problems.some((p) => p.includes('PARLAY_FREE_CHANNEL_ID')));
});

test('an analyst role id that does not exist in the guild is reported', async () => {
  const guild = fakeGuild({ channels: ['vip-picks', 'vip-parlay'], roles: ['real-role'] });
  const config = {
    picks: { ...baseConfig.picks, analystRoleIds: ['real-role', 'typo-role'], parlayAnalystRoleIds: ['sports-role'] },
  };

  const problems = await checkPicksChannelSetup(guild, config);
  assert.ok(problems.some((p) => p.includes('PICKS_ANALYST_ROLE_IDS') && p.includes('typo-role')));
  assert.ok(problems.some((p) => p.includes('PARLAY_ANALYST_ROLE_IDS') && p.includes('sports-role')));
  assert.ok(!problems.some((p) => p.includes('real-role')), 'the role that does exist is not flagged');
});

test('no free channels configured at all reports nothing about them', async () => {
  const guild = fakeGuild({ channels: ['vip-picks', 'vip-parlay'] });

  const problems = await checkPicksChannelSetup(guild, baseConfig);
  assert.deepEqual(problems, []);
});
