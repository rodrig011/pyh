import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { handleCall, handlePanelButton, pickSettingsForChannel } from '../src/picks/commands.js';

/**
 * The free room: a second, independent picks channel, built so non-VIP
 * members get real calls to trade — bait that has to actually pay out to
 * work. Same console, same mechanics, decided entirely by which channel the
 * interaction happened in (see pickSettingsForChannel in commands.js). The
 * one thing that must never happen: a button pressed in one room reaching
 * across and touching the other room's open call.
 */

const VIP_CHANNEL = 'vip-chan';
const FREE_CHANNEL = 'free-chan';

const config = {
  guildId: 'g',
  picks: {
    channelId: VIP_CHANNEL,
    defaultAsset: 'BTC',
    defaultMinutes: 15,
    pingRoleIds: ['role-tier-1'],
    free: { channelId: FREE_CHANNEL },
  },
};

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'picks-free-'));
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
    messages: { fetch: async () => ({ edit: async () => {} }) },
  };
}

function fakeClient(posts) {
  const byId = {
    [VIP_CHANNEL]: fakeChannel(VIP_CHANNEL, posts),
    [FREE_CHANNEL]: fakeChannel(FREE_CHANNEL, posts),
  };
  return {
    channels: { fetch: async (id) => byId[id] ?? null },
    users: { fetch: async () => ({ send: async () => {} }) },
  };
}

function fakeCallInteraction({ client, channelId, direction, entry = 60, userId = 'analyst1' }) {
  const replies = [];
  return {
    replies,
    guildId: 'g',
    client,
    user: { id: userId, tag: 'analyst#1', username: 'analyst' },
    memberPermissions: { has: () => true },
    member: { roles: { cache: { has: () => false } } },
    channel: { id: channelId, isTextBased: () => true },
    options: {
      getString: (name) => (name === 'direction' ? direction : null),
      getInteger: (name) => (name === 'size' ? 50 : null),
      getNumber: (name) => (name === 'entry' ? entry : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

function fakePanelInteraction({ client, channelId, action, userId = 'analyst1' }) {
  const replies = [];
  return {
    replies,
    customId: `pick:panel:${action}`,
    guildId: 'g',
    client,
    user: { id: userId, tag: 'analyst#1', username: 'analyst' },
    memberPermissions: { has: () => true },
    member: { roles: { cache: { has: () => false } } },
    channel: { id: channelId, isTextBased: () => true },
    deferReply: async () => {},
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

test('pickSettingsForChannel routes the free channel to free settings, everything else to VIP', () => {
  const free = pickSettingsForChannel(config, FREE_CHANNEL);
  assert.equal(free.channelId, FREE_CHANNEL);
  assert.deepEqual(free.pingRoleIds, []);

  const vip = pickSettingsForChannel(config, VIP_CHANNEL);
  assert.equal(vip.channelId, VIP_CHANNEL);
  assert.deepEqual(vip.pingRoleIds, ['role-tier-1']);

  const somewhereElse = pickSettingsForChannel(config, 'some-other-channel');
  assert.equal(somewhereElse.channelId, VIP_CHANNEL, 'anything that is not the free channel is the VIP room');
});

test('a call opened from the free channel posts there, not the VIP channel', async () => {
  const store = freshStore();
  const posts = [];
  const client = fakeClient(posts);

  const interaction = fakeCallInteraction({ client, channelId: FREE_CHANNEL, direction: 'up' });
  await handleCall(interaction, { store, config });

  const [pick] = store.listPicks();
  assert.equal(pick.channelId, FREE_CHANNEL);
  // The full embed AND its one-line announce mirror -- both default to the
  // free channel itself, since no separate free announce channel is set.
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.channelId === FREE_CHANNEL));
});

test('a call opened from the VIP channel posts there, unchanged from before free rooms existed', async () => {
  const store = freshStore();
  const posts = [];
  const client = fakeClient(posts);

  const interaction = fakeCallInteraction({ client, channelId: VIP_CHANNEL, direction: 'up' });
  await handleCall(interaction, { store, config });

  const [pick] = store.listPicks();
  assert.equal(pick.channelId, VIP_CHANNEL);
});

test('the same analyst can run opposite directions in the two rooms at once', async () => {
  const store = freshStore();
  const client = fakeClient([]);

  const vipCall = fakeCallInteraction({ client, channelId: VIP_CHANNEL, direction: 'up' });
  await handleCall(vipCall, { store, config });
  assert.doesNotMatch(String(vipCall.replies.at(-1)), /still have a/);

  // A DOWN call in the free room while an UP call is open in VIP -- these are
  // different books, so this must NOT trip the "opposite call already open"
  // guard the way it would if both were pressed in the same room.
  const freeCall = fakeCallInteraction({ client, channelId: FREE_CHANNEL, direction: 'down' });
  await handleCall(freeCall, { store, config });
  assert.doesNotMatch(String(freeCall.replies.at(-1)), /still have a/);

  assert.equal(store.listPicks((p) => !p.outcome).length, 2);
});

test('a second call in the SAME room and the opposite direction is still refused', async () => {
  const store = freshStore();
  const client = fakeClient([]);

  const first = fakeCallInteraction({ client, channelId: FREE_CHANNEL, direction: 'up' });
  await handleCall(first, { store, config });

  const second = fakeCallInteraction({ client, channelId: FREE_CHANNEL, direction: 'down' });
  await handleCall(second, { store, config });

  assert.match(String(second.replies.at(-1)), /still have a/);
  assert.equal(store.listPicks((p) => !p.outcome).length, 1);
});

test('cash out pressed in the free room closes only the free room\'s call, leaving VIP open', async (t) => {
  const store = freshStore();
  const client = fakeClient([]);

  // The exit price isn't asserted on here, only which call closed -- stubbed
  // so the test does not wait on a real network fetch to time out.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: '60000' } }) });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleCall(fakeCallInteraction({ client, channelId: VIP_CHANNEL, direction: 'up' }), { store, config });
  await handleCall(fakeCallInteraction({ client, channelId: FREE_CHANNEL, direction: 'down' }), { store, config });

  const cashOut = fakePanelInteraction({ client, channelId: FREE_CHANNEL, action: 'cash_out' });
  await handlePanelButton(cashOut, { store, config });

  const open = store.listPicks((p) => !p.outcome);
  assert.equal(open.length, 1, 'the VIP call is still open');
  assert.equal(open[0].channelId, VIP_CHANNEL);

  const closed = store.listPicks((p) => p.outcome);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].channelId, FREE_CHANNEL);
});
