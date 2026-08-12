import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { handleParlayCommand } from '../src/picks/parlayCommands.js';

/**
 * The sports/parlay room, split the same way the picks room was: a second,
 * free channel, decided by wherever /parlay post was actually run. Grading a
 * parlay presses a button on the exact message that was posted, so there is
 * no shared "which one is open" state to keep the two rooms apart the way
 * the picks console needed — only where a new post lands.
 */

const VIP_PARLAY_CHANNEL = 'vip-parlay-chan';
const FREE_PARLAY_CHANNEL = 'free-parlay-chan';

const config = {
  guildId: 'g',
  picks: {
    analystRoleIds: [],
    defaultAsset: 'BTC',
    defaultMinutes: 15,
    parlayChannelId: VIP_PARLAY_CHANNEL,
    parlayFreeChannelId: FREE_PARLAY_CHANNEL,
  },
};

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'parlay-free-'));
  return createStore(join(dir, 'store.json'));
}

function fakeChannel(id, posts) {
  return {
    id,
    isTextBased: () => true,
    send: async (payload) => {
      posts.push({ channelId: id, payload });
      return { id: `msg-${posts.length}` };
    },
  };
}

function fakeClient(posts) {
  const byId = {
    [VIP_PARLAY_CHANNEL]: fakeChannel(VIP_PARLAY_CHANNEL, posts),
    [FREE_PARLAY_CHANNEL]: fakeChannel(FREE_PARLAY_CHANNEL, posts),
  };
  return { channels: { fetch: async (id) => byId[id] ?? null } };
}

function postInteraction({ client, channelId }) {
  const replies = [];
  return {
    replies,
    guildId: 'g',
    client,
    user: { id: 'analyst1', tag: 'analyst#1', username: 'analyst' },
    memberPermissions: { has: () => true },
    member: { roles: { cache: { has: () => false } } },
    channel: { id: channelId, isTextBased: () => true },
    options: {
      getSubcommand: () => 'post',
      getString: (key) => (key === 'legs' ? 'Lakers -4.5, Celtics ML' : null),
      getNumber: () => null,
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

test('/parlay post run in the free channel lands there, not the VIP parlay channel', async () => {
  const store = freshStore();
  const posts = [];
  const client = fakeClient(posts);

  const interaction = postInteraction({ client, channelId: FREE_PARLAY_CHANNEL });
  await handleParlayCommand(interaction, { store, config });

  const [parlay] = store.listParlays();
  assert.equal(parlay.channelId, FREE_PARLAY_CHANNEL);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channelId, FREE_PARLAY_CHANNEL);
});

test('/parlay post run anywhere else still lands in the configured VIP parlay channel', async () => {
  const store = freshStore();
  const posts = [];
  const client = fakeClient(posts);

  const interaction = postInteraction({ client, channelId: 'some-other-channel' });
  await handleParlayCommand(interaction, { store, config });

  const [parlay] = store.listParlays();
  assert.equal(parlay.channelId, VIP_PARLAY_CHANNEL);
});

test('with no free parlay channel configured, everything behaves exactly as before', async () => {
  const store = freshStore();
  const posts = [];
  const client = fakeClient(posts);
  const noFreeConfig = { ...config, picks: { ...config.picks, parlayFreeChannelId: null } };

  const interaction = postInteraction({ client, channelId: FREE_PARLAY_CHANNEL });
  await handleParlayCommand(interaction, { store, config: noFreeConfig });

  const [parlay] = store.listParlays();
  assert.equal(parlay.channelId, VIP_PARLAY_CHANNEL, 'no free channel configured means everything is the VIP room');
});
