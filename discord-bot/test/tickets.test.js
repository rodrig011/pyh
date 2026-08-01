import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { createOrder } from '../src/vip/orders.js';
import { upsertSubscription } from '../src/vip/subscriptions.js';
import { TICKET_CLOSE, TICKET_OPEN, memberContextEmbed, openTicket, panelMessage } from '../src/vip/tickets.js';

const config = {
  codePrefix: 'VIP',
  codeLength: 6,
  orderTtlHours: 48,
  subscriptionDays: 30,
  modRoleIds: ['mod1'],
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

function fakeInteraction({ existingThread = null } = {}) {
  const created = [];
  const posted = [];
  const thread = {
    id: 'thread1',
    archived: false,
    members: { add: async () => {} },
    send: async (payload) => posted.push(payload),
  };
  return {
    created,
    posted,
    thread,
    interaction: {
      guildId: 'g',
      user: { id: 'u1', username: 'buyer', tag: 'buyer#0001' },
      channel: {
        threads: {
          create: async (options) => {
            created.push(options);
            return thread;
          },
        },
      },
      guild: { channels: { fetch: async () => existingThread } },
    },
  };
}

test('the panel carries the button members click', () => {
  const panel = panelMessage(config);
  const button = panel.components[0].toJSON().components[0];
  assert.equal(button.custom_id, TICKET_OPEN);
  assert.match(panel.embeds[0].toJSON().description, /private thread/);
});

test('opening a ticket creates a private thread and pings the mods', async (t) => {
  const store = freshStore(t);
  const { interaction, created, posted } = fakeInteraction();

  const result = await openTicket(interaction, { store, config });

  assert.equal(result.status, 'opened');
  assert.equal(created[0].type, 12, 'private thread');
  assert.equal(created[0].invitable, false, 'members cannot invite others in');
  assert.match(posted[0].content, /<@&mod1>/);
  assert.deepEqual(posted[0].allowedMentions.roles, ['mod1']);
  assert.equal(store.data.tickets['g:u1'].status, 'open');
});

test('the thread carries a close button for the mods', async (t) => {
  const store = freshStore(t);
  const { interaction, posted } = fakeInteraction();
  await openTicket(interaction, { store, config });

  assert.equal(posted[0].components[0].toJSON().components[0].custom_id, TICKET_CLOSE);
});

test('clicking twice reuses the open thread instead of splitting the conversation', async (t) => {
  const store = freshStore(t);
  const first = fakeInteraction();
  await openTicket(first.interaction, { store, config });

  const second = fakeInteraction({ existingThread: { id: 'thread1', archived: false } });
  const result = await openTicket(second.interaction, { store, config });

  assert.equal(result.status, 'already_open');
  assert.equal(second.created.length, 0, 'no second thread');
});

test('a closed ticket does not block a new one later', async (t) => {
  const store = freshStore(t);
  const first = fakeInteraction();
  await openTicket(first.interaction, { store, config });
  store.data.tickets['g:u1'].status = 'closed';

  const second = fakeInteraction();
  const result = await openTicket(second.interaction, { store, config });

  assert.equal(result.status, 'opened');
  assert.equal(second.created.length, 1);
});

test('the mods get the payment context without having to go dig', async (t) => {
  const store = freshStore(t);
  const order = createOrder(store, { userId: 'u1', guildId: 'g', tier: 2, config });
  upsertSubscription(store, { guildId: 'g', userId: 'u1', tier: 1, days: 30 });

  const embed = memberContextEmbed(store, { guildId: 'g', userId: 'u1', config }).toJSON();
  const text = embed.fields.map((field) => `${field.name} ${field.value}`).join('\n');

  assert.match(text, new RegExp(order.code), 'their order code');
  assert.match(text, /VIP Tier 1/, 'what they hold today');
  assert.match(text, /vip-admin confirm/, 'the exact command to fix it');
  assert.match(embed.footer.text, /u1/);
});

test('a member with no orders is described as such, not left blank', async (t) => {
  const store = freshStore(t);
  const embed = memberContextEmbed(store, { guildId: 'g', userId: 'nobody', config }).toJSON();
  const text = embed.fields.map((field) => field.value).join('\n');

  assert.match(text, /no membership on record/);
  assert.match(text, /never ran/);
});
