import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createStore } from '../src/lib/store.js';
import { handleInteraction } from '../src/vip/commands.js';
import { PARLAY_PREFIX } from '../src/picks/parlayCommands.js';

const config = {
  guildId: 'g',
  modRoleIds: [],
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'r1', label: 'Signals', perks: ['x'] },
  },
  picks: { analystRoleIds: [], defaultMinutes: 15, defaultAsset: 'BTC', minimumForBoard: 5, disclaimer: 'nfa' },
};

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

function commandInteraction(options, { subcommand, isAdmin = true, userId = 'analyst1' } = {}) {
  const replies = [];
  const posted = [];
  return {
    replies,
    posted,
    interaction: {
      commandName: 'parlay',
      guildId: 'g',
      user: { id: userId, tag: `${userId}#0001`, username: userId },
      member: { roles: { cache: { has: () => false } } },
      memberPermissions: { has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator },
      isButton: () => false,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      client: { channels: { fetch: async () => null } },
      channel: {
        isTextBased: () => true,
        send: async (p) => {
          posted.push(p);
          return { id: 'msg1' };
        },
      },
      options: {
        getSubcommand: () => subcommand,
        getString: (key) => options[key] ?? null,
        getNumber: (key) => options[key] ?? null,
      },
      deferReply: async function () {
        this.deferred = true;
      },
      reply: async (payload) => replies.push(payload),
      editReply: async (payload) => replies.push(payload),
    },
  };
}

function buttonInteraction(customId, { userId = 'analyst1', isAdmin = false } = {}) {
  const updates = [];
  const replies = [];
  return {
    updates,
    replies,
    interaction: {
      customId,
      guildId: 'g',
      user: { id: userId, tag: `${userId}#0001` },
      member: { roles: { cache: { has: () => false } } },
      memberPermissions: { has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator },
      isButton: () => true,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      update: async (payload) => updates.push(payload),
      reply: async (payload) => replies.push(payload),
    },
  };
}

test('an analyst posts a parlay, and it lands in the channel', async (t) => {
  const store = tempStore(t);
  const { interaction, replies, posted } = commandInteraction(
    { legs: 'Lakers -4.5, Over 220', odds: '+250' },
    { subcommand: 'post' },
  );

  await handleInteraction(interaction, { store, config, client: interaction.client });

  assert.equal(posted.length, 1);
  assert.match(posted[0].embeds[0].toJSON().description, /Lakers/);
  assert.match(replies[0], /Parlay posted/);
  assert.equal(store.listParlays().length, 1);
});

test('nobody without the analyst role can post one', async (t) => {
  const store = tempStore(t);
  const { interaction, replies, posted } = commandInteraction(
    { legs: 'Lakers -4.5' },
    { subcommand: 'post', isAdmin: false },
  );

  await handleInteraction(interaction, {
    store,
    config: { ...config, picks: { ...config.picks, analystRoleIds: ['analyst-role'] } },
    client: interaction.client,
  });

  assert.equal(posted.length, 0);
  assert.match(replies[0].content, /Only the analysts/);
});

test('a mod grades the parlay by pressing WIN, and it locks', async (t) => {
  const store = tempStore(t);
  const post = commandInteraction({ legs: 'Lakers -4.5' }, { subcommand: 'post' });
  await handleInteraction(post.interaction, { store, config, client: post.interaction.client });
  const parlayId = store.listParlays()[0].id;

  const { interaction, updates } = buttonInteraction(`${PARLAY_PREFIX}${parlayId}:win`, { isAdmin: true });
  await handleInteraction(interaction, { store, config, client: {} });

  assert.equal(updates.length, 1);
  const embed = updates[0].embeds[0].toJSON();
  assert.match(embed.fields.find((f) => f.name === 'Result').value, /WIN/);
  assert.ok(updates[0].components[0].toJSON().components.every((c) => c.disabled));
  assert.equal(store.getParlay(parlayId).outcome, 'win');
});

test('somebody who is neither the caller nor a mod cannot grade it', async (t) => {
  const store = tempStore(t);
  const post = commandInteraction({ legs: 'Lakers -4.5' }, { subcommand: 'post', userId: 'analyst1' });
  await handleInteraction(post.interaction, { store, config, client: post.interaction.client });
  const parlayId = store.listParlays()[0].id;

  const { interaction, updates, replies } = buttonInteraction(`${PARLAY_PREFIX}${parlayId}:win`, {
    userId: 'somebody-else',
    isAdmin: false,
  });
  await handleInteraction(interaction, { store, config, client: {} });

  assert.equal(updates.length, 0);
  assert.match(replies[0].content, /Only the analyst who called it/);
  assert.equal(store.getParlay(parlayId).outcome, null);
});

test('/parlay board reports nothing gracefully before anything is graded', async (t) => {
  const store = tempStore(t);
  const { interaction, replies } = commandInteraction({}, { subcommand: 'board' });

  await handleInteraction(interaction, { store, config, client: interaction.client });

  assert.match(replies[0].content, /No graded parlays yet/);
});
