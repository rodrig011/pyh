import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { handlePicks } from '../src/picks/commands.js';

// Every subcommand here was reachable only through Discord, so a name that was
// never imported got all the way to a mod running the command in front of the
// room — `/picks backfill` answered "sendLog is not defined". These drive the
// router directly, which is the cheapest place to catch that class of mistake.

function fakeInteraction(sub, options = {}, { admin = true } = {}) {
  const replies = [];
  return {
    replies,
    guildId: 'g',
    user: { id: 'mod', tag: 'mod#1', username: 'mod' },
    client: {},
    memberPermissions: { has: () => admin },
    member: { roles: { cache: { has: () => admin } } },
    options: {
      getSubcommand: () => sub,
      getUser: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

const freshStore = () => createStore(join(mkdtempSync(join(tmpdir(), 'picks-')), 'store.json'));
const config = { guildId: 'g', picks: { defaultAsset: 'BTC', defaultMinutes: 15 } };

test('/picks backfill writes the record and answers without throwing', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('backfill', {
    analyst: { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' },
    wins: 7,
    losses: 0,
  });

  await handlePicks(interaction, { store, config });

  assert.equal(store.listPicks().length, 7);
  assert.match(String(interaction.replies.at(-1)), /Restored \*\*7\*\*/);
});

test('/picks backfill refuses anyone who is not a mod', async () => {
  const store = freshStore();
  const interaction = fakeInteraction(
    'backfill',
    { analyst: { id: 'kingt', tag: 'k', username: 'k' }, wins: 7, losses: 0 },
    { admin: false },
  );

  await handlePicks(interaction, { store, config });

  assert.equal(store.listPicks().length, 0);
  assert.match(String(interaction.replies.at(-1)), /Only the mods/);
});

test('/picks backfill will not record nothing', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('backfill', {
    analyst: { id: 'kingt', tag: 'k', username: 'k' },
    wins: 0,
    losses: 0,
  });

  await handlePicks(interaction, { store, config });
  assert.match(String(interaction.replies.at(-1)), /at least one/);
});

test('/picks me answers a member who has taken nothing', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('me');

  await handlePicks(interaction, { store, config });
  assert.match(String(interaction.replies.at(-1)), /have not taken a call/);
});

test('/picks record, board and open all answer on an empty store', async () => {
  for (const sub of ['record', 'board', 'open']) {
    const interaction = fakeInteraction(sub);
    await handlePicks(interaction, { store: freshStore(), config });
    assert.ok(interaction.replies.length === 1, `${sub} replied exactly once`);
  }
});

test('backfill replaces its own previous entries instead of stacking them', async () => {
  const store = freshStore();
  const analyst = { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' };

  // The bug: running it four times while testing turned 7-0 into 28-0.
  for (let run = 0; run < 4; run += 1) {
    await handlePicks(fakeInteraction('backfill', { analyst, wins: 7, losses: 0 }), { store, config });
  }

  assert.equal(store.listPicks().length, 7);
});

test('a restore never touches calls the bot graded live', async () => {
  const store = freshStore();
  const analyst = { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' };

  store.recordPick({
    id: 'live-1',
    analystId: 'kingt',
    guildId: 'g',
    asset: 'BTC',
    outcome: 'win',
    createdAt: Date.now(),
  });

  await handlePicks(fakeInteraction('backfill', { analyst, wins: 7, losses: 0 }), { store, config });
  await handlePicks(fakeInteraction('backfill', { analyst, wins: 3, losses: 1 }), { store, config });

  const kept = store.listPicks();
  assert.equal(kept.filter((pick) => pick.backfilled).length, 4);
  assert.ok(kept.some((pick) => pick.id === 'live-1'), 'the live call survives every restore');
});

test('one analyst’s restore leaves another analyst alone', async () => {
  const store = freshStore();
  await handlePicks(
    fakeInteraction('backfill', { analyst: { id: 'a', tag: 'a', username: 'a' }, wins: 5, losses: 0 }),
    { store, config },
  );
  await handlePicks(
    fakeInteraction('backfill', { analyst: { id: 'b', tag: 'b', username: 'b' }, wins: 2, losses: 0 }),
    { store, config },
  );

  assert.equal(store.listPicks((pick) => pick.analystId === 'a').length, 5);
  assert.equal(store.listPicks((pick) => pick.analystId === 'b').length, 2);
});
