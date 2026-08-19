import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { sendLog } from '../src/vip/notify.js';

function fakeClient() {
  const sent = [];
  return {
    sent,
    client: {
      channels: {
        fetch: async () => ({ isTextBased: () => true, send: async (payload) => sent.push(payload) }),
      },
    },
  };
}

const config = { logChannelId: 'log', modRoleIds: ['mod1', 'mod2'] };
const embed = () => new EmbedBuilder().setTitle('Payment');

test('money events mention the mod roles so somebody looks now', async () => {
  const { client, sent } = fakeClient();
  await sendLog(client, config, embed(), { ping: true });

  assert.equal(sent[0].content, '<@&mod1> <@&mod2>');
  assert.deepEqual(sent[0].allowedMentions, { roles: ['mod1', 'mod2'] });
});

test('routine entries do not ping anyone', async () => {
  const { client, sent } = fakeClient();
  await sendLog(client, config, embed());

  assert.equal(sent[0].content, undefined);
  assert.deepEqual(sent[0].allowedMentions, { roles: [] });
});

test('the ping can be turned off without losing the log entry', async () => {
  const { client, sent } = fakeClient();
  await sendLog(client, { ...config, pingModsOnPayment: false }, embed(), { ping: true });

  assert.equal(sent[0].content, undefined);
  assert.ok(sent[0].embeds[0], 'the entry is still posted');
});

test('with no mod roles configured it posts without pinging', async () => {
  const { client, sent } = fakeClient();
  await sendLog(client, { logChannelId: 'log', modRoleIds: [] }, embed(), { ping: true });

  assert.equal(sent[0].content, undefined);
  assert.deepEqual(sent[0].allowedMentions, { roles: [] }, 'never @everyone by accident');
});

test('with no log channel nothing is sent and nothing throws', async () => {
  const { client, sent } = fakeClient();
  assert.equal(await sendLog(client, { modRoleIds: ['mod1'] }, embed(), { ping: true }), false);
  assert.equal(sent.length, 0);
});
