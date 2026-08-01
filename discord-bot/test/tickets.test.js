import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createStore } from '../src/lib/store.js';
import { createOrder } from '../src/vip/orders.js';
import { upsertSubscription } from '../src/vip/subscriptions.js';
import {
  TICKET_CLOSE,
  TICKET_OPEN,
  closeTicket,
  memberContextEmbed,
  openTicket,
  panelMessage,
  ticketPermissions,
} from '../src/vip/tickets.js';

const config = {
  codePrefix: 'VIP',
  codeLength: 6,
  orderTtlHours: 48,
  subscriptionDays: 30,
  modRoleIds: ['mod1'],
  ticketCategoryId: 'cat1',
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'r1' },
    2: { tier: 2, priceCents: 10000, roleId: 'r2' },
    3: { tier: 3, priceCents: 20000, roleId: 'r3' },
  },
};

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vipticket-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

function fakeInteraction({ existingChannel = null } = {}) {
  const created = [];
  const posted = [];
  const deleted = [];
  const channel = {
    id: 'chan1',
    send: async (payload) => posted.push(payload),
    delete: async (reason) => deleted.push(reason),
  };
  return {
    created,
    posted,
    deleted,
    channel,
    interaction: {
      guildId: 'g',
      user: { id: 'u1', username: 'buyer', tag: 'buyer#0001' },
      client: { user: { id: 'bot1' } },
      channel,
      guild: {
        roles: { everyone: { id: 'everyone' } },
        channels: {
          create: async (options) => {
            created.push(options);
            return channel;
          },
          fetch: async () => existingChannel,
        },
      },
    },
  };
}

test('the panel offers a private channel, not a thread', () => {
  const panel = panelMessage();
  assert.equal(panel.components[0].toJSON().components[0].custom_id, TICKET_OPEN);
  assert.match(panel.embeds[0].toJSON().description, /private channel/);
});

test('only the opener and the mods can see the ticket', () => {
  const guild = { roles: { everyone: { id: 'everyone' } } };
  const overwrites = ticketPermissions(guild, 'u1', ['mod1', 'mod2'], 'bot1');

  const everyone = overwrites.find((o) => o.id === 'everyone');
  assert.deepEqual(everyone.deny, [PermissionFlagsBits.ViewChannel], '@everyone is locked out');

  for (const id of ['u1', 'mod1', 'mod2', 'bot1']) {
    const entry = overwrites.find((o) => o.id === id);
    assert.ok(entry?.allow.includes(PermissionFlagsBits.ViewChannel), `${id} can see it`);
    assert.ok(entry.allow.includes(PermissionFlagsBits.SendMessages), `${id} can write`);
  }
  assert.equal(overwrites.length, 5, 'nobody else is added');
});

test('opening a ticket creates the channel and pings the mods', async (t) => {
  const store = freshStore(t);
  const { interaction, created, posted } = fakeInteraction();

  const result = await openTicket(interaction, { store, config });

  assert.equal(result.status, 'opened');
  assert.equal(created[0].type, 0, 'a normal text channel');
  assert.equal(created[0].name, 'ticket-buyer');
  assert.equal(created[0].parent, 'cat1', 'filed under the configured category');
  assert.match(posted[0].content, /<@&mod1>/);
  assert.deepEqual(posted[0].allowedMentions.roles, ['mod1']);
  assert.equal(store.data.tickets['g:u1'].status, 'open');
});

test('the channel carries the close button', async (t) => {
  const store = freshStore(t);
  const { interaction, posted } = fakeInteraction();
  await openTicket(interaction, { store, config });

  assert.equal(posted[0].components[0].toJSON().components[0].custom_id, TICKET_CLOSE);
});

test('clicking twice reuses the open channel instead of splitting the conversation', async (t) => {
  const store = freshStore(t);
  await openTicket(fakeInteraction().interaction, { store, config });

  const second = fakeInteraction({ existingChannel: { id: 'chan1' } });
  const result = await openTicket(second.interaction, { store, config });

  assert.equal(result.status, 'already_open');
  assert.equal(second.created.length, 0, 'no second channel');
});

test('a deleted channel does not leave the member locked out of opening another', async (t) => {
  const store = freshStore(t);
  await openTicket(fakeInteraction().interaction, { store, config });

  // The mods deleted it by hand: the record says open, the channel is gone.
  const second = fakeInteraction({ existingChannel: null });
  const result = await openTicket(second.interaction, { store, config });

  assert.equal(result.status, 'opened');
  assert.equal(second.created.length, 1);
});

test('closing deletes the channel and records who did it', async (t) => {
  const store = freshStore(t);
  const first = fakeInteraction();
  await openTicket(first.interaction, { store, config });

  const closer = fakeInteraction();
  closer.interaction.user = { id: 'mod-user', username: 'mod', tag: 'mod#0001' };
  await closeTicket(closer.interaction, { store, config }, { delayMs: 0 });

  assert.equal(closer.deleted.length, 1, 'the channel is gone');
  assert.equal(store.data.tickets['g:u1'].status, 'closed');
  assert.equal(store.data.tickets['g:u1'].closedBy, 'mod-user');
});

test('the mods get the payment context without having to go dig', async (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 2, config });
  upsertSubscription(store, { guildId: 'g', userId: 'u1', tier: 1, days: 30 });

  const embed = memberContextEmbed(store, { guildId: 'g', userId: 'u1' }).toJSON();
  const text = embed.fields.map((field) => `${field.name} ${field.value}`).join('\n');

  assert.match(text, new RegExp(order.code));
  assert.match(text, /VIP Tier 1/);
  assert.match(text, /vip-admin confirm/);
  assert.match(embed.footer.text, /u1/);
});

test('a member with no orders is described as such, not left blank', async (t) => {
  const store = freshStore(t);
  const embed = memberContextEmbed(store, { guildId: 'g', userId: 'nobody' }).toJSON();
  const text = embed.fields.map((field) => field.value).join('\n');

  assert.match(text, /no membership on record/);
  assert.match(text, /never ran/);
});

test('the bot only grants permissions it actually holds', () => {
  // Discord rejects the whole channel creation if a bot tries to grant a
  // permission it lacks — which surfaced as "Missing Permissions" even with
  // Manage Channels granted, and sent everyone chasing the wrong setting.
  const guild = { roles: { everyone: { id: 'everyone' } } };
  const limited = {
    has: (permission) =>
      permission === PermissionFlagsBits.ViewChannel || permission === PermissionFlagsBits.SendMessages,
  };

  const overwrites = ticketPermissions(guild, 'u1', ['mod1'], 'bot1', limited);
  const opener = overwrites.find((o) => o.id === 'u1');

  assert.deepEqual(opener.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  assert.ok(!opener.allow.includes(PermissionFlagsBits.AttachFiles), 'not granted, so not requested');
});

test('a bot with everything grants the full set', () => {
  const guild = { roles: { everyone: { id: 'everyone' } } };
  const overwrites = ticketPermissions(guild, 'u1', [], 'bot1', { has: () => true });
  const opener = overwrites.find((o) => o.id === 'u1');

  assert.ok(opener.allow.includes(PermissionFlagsBits.AttachFiles), 'screenshots are the point of a ticket');
  assert.ok(opener.allow.includes(PermissionFlagsBits.ReadMessageHistory));
});

test('a ticket is still openable even if the bot can grant nothing', () => {
  const guild = { roles: { everyone: { id: 'everyone' } } };
  const overwrites = ticketPermissions(guild, 'u1', [], 'bot1', { has: () => false });
  const opener = overwrites.find((o) => o.id === 'u1');

  assert.deepEqual(opener.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
});
