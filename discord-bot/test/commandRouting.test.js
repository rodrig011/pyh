import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createStore } from '../src/lib/store.js';
import { handleInteraction } from '../src/vip/commands.js';
import { createOrder } from '../src/vip/orders.js';
import { upsertSubscription } from '../src/vip/subscriptions.js';

// A missing import or a renamed helper is invisible to a syntax check: the file
// parses fine and only explodes when a mod runs the command in production.
// These drive each subcommand through the real router with stubs, so that class
// of breakage fails here instead of in the server.

const config = {
  codePrefix: 'VIP',
  codeLength: 6,
  orderTtlHours: 48,
  subscriptionDays: 30,
  amountToleranceCents: 0,
  upgradeOnOverpay: true,
  modRoleIds: [],
  logChannelId: null,
  zelleRecipient: 'pay@example.com',
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'role-1', label: 'Signals', perks: ['signals'] },
    2: { tier: 2, priceCents: 10000, roleId: 'role-2', label: 'VIP', perks: ['vip room'] },
    3: { tier: 3, priceCents: 20000, roleId: 'role-3', label: 'Elite', perks: ['calls'] },
  },
};

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipcmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

function fakeInteraction(commandName, subcommand, options = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      commandName,
      guildId: 'g',
      user: { id: 'mod1', tag: 'mod#0001' },
      deferred: false,
      replied: false,
      isButton: () => false,
      isChatInputCommand: () => true,
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => options[name] ?? null,
        getInteger: (name) => options[name] ?? null,
        getNumber: (name) => options[name] ?? null,
        getBoolean: (name) => options[name] ?? null,
        getUser: (name) => options[name] ?? null,
      },
      deferReply: async function () {
        this.deferred = true;
      },
      reply: async (payload) => replies.push(payload),
      editReply: async (payload) => replies.push(payload),
    },
  };
}

const fakeClient = {
  guilds: { fetch: async () => ({ id: 'g', members: { fetch: async () => new Map() } }) },
  users: { fetch: async () => ({ send: async () => {} }) },
  channels: { fetch: async () => null },
};

test('/vip-admin stats runs and answers with an embed', async (t) => {
  const store = freshStore(t);
  upsertSubscription(store, { guildId: 'g', userId: 'u1', tier: 2, days: 30 });

  const { interaction, replies } = fakeInteraction('vip-admin', 'stats');
  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].embeds?.[0], 'answered with an embed');
  const embed = replies[0].embeds[0].toJSON();
  assert.match(embed.title, /VIP overview/);
  assert.ok(embed.fields.some((field) => field.name.includes('Active members')));
});

test('/vip-admin members lists the active memberships', async (t) => {
  const store = freshStore(t);
  upsertSubscription(store, { guildId: 'g', userId: 'u1', tier: 1, days: 30 });

  const { interaction, replies } = fakeInteraction('vip-admin', 'members');
  await handleInteraction(interaction, { store, config, client: fakeClient });

  const embed = replies[0].embeds[0].toJSON();
  assert.match(embed.title, /Active memberships/);
  assert.match(embed.description, /u1/);
});

test('/vip-admin pending lists unpaid orders', async (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 1, config });

  const { interaction, replies } = fakeInteraction('vip-admin', 'pending');
  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.match(replies[0].embeds[0].toJSON().description, new RegExp(order.code));
});

test('/vip-admin lookup finds an order by code', async (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 3, config });

  const { interaction, replies } = fakeInteraction('vip-admin', 'lookup', { code: order.code });
  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.match(replies[0].embeds[0].toJSON().title, new RegExp(order.code));
});

test('/vip prices answers without needing any data', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = fakeInteraction('vip', 'prices');
  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.match(replies[0].embeds[0].toJSON().title, /VIP access/);
});

test('/vip status answers for someone with no membership', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = fakeInteraction('vip', 'status');
  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.match(replies[0].content, /no membership yet/);
});

test('a non-mod is turned away from /vip-admin', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = fakeInteraction('vip-admin', 'stats');
  interaction.memberPermissions = { has: () => false };
  interaction.member = { roles: { cache: { has: () => false } } };

  await handleInteraction(interaction, { store, config: { ...config, modRoleIds: ['mod-role'] }, client: fakeClient });

  assert.match(replies[0].content, /Only the mod team/);
});

function fakeButton(customId, { guildId = 'g' } = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      customId,
      guildId,
      user: { id: 'u1', tag: 'buyer#0001', username: 'buyer' },
      deferred: false,
      replied: false,
      isButton: () => true,
      isChatInputCommand: () => false,
      memberPermissions: { has: () => false },
      deferReply: async function () {
        this.deferred = true;
      },
      reply: async (payload) => replies.push(payload),
      editReply: async (payload) => replies.push(payload),
    },
  };
}

test('the buy button produces the same instructions as the command', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = fakeButton('vip:buy:1');

  await handleInteraction(interaction, { store, config, client: fakeClient });

  const embed = replies[0].embeds[0].toJSON();
  assert.match(embed.title, /Signals/);
  assert.match(embed.description, /pay@example\.com/, 'the payment instructions');
  assert.equal(store.listOrders().length, 1, 'an order was created');
});

test('the buy button works from a DM, where there is no guild', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = fakeButton('vip:buy:1', { guildId: null });

  await handleInteraction(interaction, { store, config: { ...config, guildId: 'g' }, client: fakeClient });

  assert.ok(replies[0].embeds?.[0], 'answered');
  assert.equal(store.listOrders()[0].guildId, 'g', 'filed under the bot\'s guild');
});

test('a locked tier button says coming soon instead of taking an order', async (t) => {
  const store = freshStore(t);
  const locked = { ...config, tiers: { ...config.tiers, 3: { ...config.tiers[3], roleId: undefined } } };
  const { interaction, replies } = fakeButton('vip:buy:3');

  await handleInteraction(interaction, { store, config: locked, client: fakeClient });

  assert.match(replies[0].content, /not on sale yet/);
  assert.equal(store.listOrders().length, 0);
});

test('the status button answers without a command', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = fakeButton('vip:status');

  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.match(replies[0].content, /no membership yet/);
});

// The panel posts into whatever channel the mod ran it in, and a "how to buy"
// channel is usually locked so members cannot type. That deny applies to the
// bot too, which is exactly how this failed in production with nothing but
// "Something went wrong" to go on.
function panelInteraction({ allowed = true, sendThrows = null } = {}) {
  const { interaction, replies } = fakeInteraction('vip-admin', 'panel');
  const sent = [];
  const channel = {
    name: 'how-to-buy-vip',
    toString: () => '#how-to-buy-vip',
    permissionsFor: () => ({ has: () => allowed }),
    send: async (payload) => {
      if (sendThrows) throw new Error(sendThrows);
      sent.push(payload);
    },
  };
  interaction.channel = channel;
  interaction.guild = { members: { me: { id: 'bot' } } };
  return { interaction, replies, sent };
}

test('/vip-admin panel posts the storefront when the bot may speak', async (t) => {
  const store = freshStore(t);
  const { interaction, replies, sent } = panelInteraction();

  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.equal(sent.length, 1, 'the panel was posted');
  assert.ok(sent[0].embeds?.[0], 'it carries the storefront embed');
  assert.ok(sent[0].components.length >= 1, 'it carries the buy buttons');
  assert.match(replies[0], /Panel posted/);
});

test('/vip-admin panel names the missing permission instead of failing blankly', async (t) => {
  const store = freshStore(t);
  const { interaction, replies, sent } = panelInteraction({ allowed: false });

  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.equal(sent.length, 0, 'nothing was posted');
  assert.match(replies[0], /Send Messages/);
  assert.match(replies[0], /how-to-buy-vip/, 'it says which channel to fix');
});

test('/vip-admin panel quotes Discord when the post is refused anyway', async (t) => {
  const store = freshStore(t);
  const { interaction, replies } = panelInteraction({ sendThrows: 'Missing Permissions' });

  await handleInteraction(interaction, { store, config, client: fakeClient });

  assert.match(replies[0], /Missing Permissions/);
});
