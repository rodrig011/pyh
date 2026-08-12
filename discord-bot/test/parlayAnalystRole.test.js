import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { handleParlayCommand } from '../src/picks/parlayCommands.js';
import { isAnalyst, isParlayAnalyst, parlayCallerRoleIds } from '../src/picks/commands.js';

/**
 * "Sports" people only do sports parlays and were never meant to get the
 * Kalshi picks console. parlayAnalystRoleIds is a narrower door: it must let
 * a Sports-role member through /parlay post while isAnalyst (the picks
 * console gate) still refuses them, and it must never take away a regular
 * analyst's existing ability to post parlays too.
 */

const SPORTS_ROLE = 'sports-role';
const CALLS_ROLE = 'calls-role';

const config = {
  guildId: 'g',
  modRoleIds: [],
  picks: {
    analystRoleIds: [CALLS_ROLE],
    parlayAnalystRoleIds: [SPORTS_ROLE],
    parlayChannelId: 'parlay-chan',
  },
};

function freshStore() {
  return createStore(join(mkdtempSync(join(tmpdir(), 'parlay-role-')), 'store.json'));
}

function memberWithRole(roleId) {
  return { roles: { cache: { has: (id) => id === roleId } } };
}

function fakeInteraction({ member, admin = false }) {
  const replies = [];
  const parlayChannel = { id: 'parlay-chan', isTextBased: () => true, send: async () => ({ id: 'm1' }) };
  return {
    replies,
    guildId: 'g',
    user: { id: 'u1', tag: 'u1#1', username: 'u1' },
    memberPermissions: { has: () => admin },
    member,
    client: { channels: { fetch: async (id) => (id === 'parlay-chan' ? parlayChannel : null) } },
    channel: { id: 'somewhere', isTextBased: () => true, send: async () => ({ id: 'm1' }) },
    options: {
      getSubcommand: () => 'post',
      getString: (key) => (key === 'legs' ? 'Lakers -4.5' : null),
      getNumber: () => null,
    },
    deferReply: async () => {},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

test('parlayCallerRoleIds includes both the Sports role and the regular analyst roles', () => {
  const ids = parlayCallerRoleIds(config);
  assert.ok(ids.includes(SPORTS_ROLE));
  assert.ok(ids.includes(CALLS_ROLE));
});

test('a Sports-role member can post a parlay', () => {
  const interaction = { member: memberWithRole(SPORTS_ROLE), memberPermissions: { has: () => false } };
  assert.equal(isParlayAnalyst(interaction, config), true);
});

test('a Sports-role member is NOT an analyst for the Kalshi picks console', () => {
  const interaction = { member: memberWithRole(SPORTS_ROLE), memberPermissions: { has: () => false } };
  assert.equal(isAnalyst(interaction, config), false);
});

test('a Calls-role (regular analyst) member can still post a parlay too', () => {
  const interaction = { member: memberWithRole(CALLS_ROLE), memberPermissions: { has: () => false } };
  assert.equal(isParlayAnalyst(interaction, config), true);
});

test('a Sports-role member successfully posting /parlay post is not turned away', async () => {
  const store = freshStore();
  const interaction = fakeInteraction({ member: memberWithRole(SPORTS_ROLE) });

  await handleParlayCommand(interaction, { store, config });

  assert.equal(store.listParlays().length, 1);
  assert.doesNotMatch(String(interaction.replies.at(-1)), /Only the analysts/);
});

test('somebody with neither role, nor admin, nor mod cannot post a parlay', async () => {
  const store = freshStore();
  const interaction = fakeInteraction({ member: memberWithRole('unrelated-role') });

  await handleParlayCommand(interaction, { store, config });

  assert.equal(store.listParlays().length, 0);
});
