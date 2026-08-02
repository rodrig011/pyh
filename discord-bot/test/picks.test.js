import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTIONS,
  OUTCOMES,
  buildPick,
  computeRecord,
  dueForSettlement,
  formatStreak,
  formatWinRate,
  leaderboard,
  settlePick,
} from '../src/picks/picks.js';

const now = Date.now();
const minute = 60000;

function pick(analystId, outcome, { ago = 0, direction = DIRECTIONS.UP } = {}) {
  const made = buildPick({
    analystId,
    guildId: 'g',
    direction,
    asset: 'btc',
    minutes: 15,
    now: now - ago,
  });
  if (outcome) settlePick(made, { outcome, settledBy: 'mod', now: now - ago + 15 * minute });
  return made;
}

test('a call records its own deadline and normalises the asset', () => {
  const made = buildPick({ analystId: 'a', guildId: 'g', direction: 'up', asset: 'btc', minutes: 15, now });

  assert.equal(made.asset, 'BTC');
  assert.equal(made.closesAt, now + 15 * minute);
  assert.equal(made.outcome, null);
});

test('a call with no direction or no duration is refused', () => {
  assert.throws(() => buildPick({ analystId: 'a', direction: 'sideways', asset: 'BTC', minutes: 15 }));
  assert.throws(() => buildPick({ analystId: 'a', direction: 'up', asset: 'BTC', minutes: 0 }));
});

test('only closed and ungraded calls come due', () => {
  const open = buildPick({ analystId: 'a', guildId: 'g', direction: 'up', asset: 'BTC', minutes: 15, now });
  const closed = pick('a', null, { ago: 20 * minute });
  const graded = pick('a', OUTCOMES.WIN, { ago: 60 * minute });

  const due = dueForSettlement([open, closed, graded], now);
  assert.deepEqual(due.map((p) => p.id), [closed.id]);
});

test('the win rate counts only calls that actually resolved', () => {
  const record = computeRecord([
    pick('a', OUTCOMES.WIN),
    pick('a', OUTCOMES.WIN),
    pick('a', OUTCOMES.LOSS),
    // Neither a hit nor a miss: it must not move the percentage either way.
    pick('a', OUTCOMES.BREAK_EVEN),
  ]);

  assert.equal(record.wins, 2);
  assert.equal(record.losses, 1);
  assert.equal(record.decided, 3);
  assert.equal(formatWinRate(record.winRate), '66.7%');
});

test('nobody can lift their percentage by calling nothing', () => {
  const onlyFlat = computeRecord([pick('a', OUTCOMES.BREAK_EVEN), pick('a', OUTCOMES.VOID)]);
  assert.equal(onlyFlat.winRate, null, 'no decided calls means no rate to show');
  assert.equal(formatWinRate(onlyFlat.winRate), '—');
});

test('a streak runs from the most recent call and stops at the first break', () => {
  const picks = [
    pick('a', OUTCOMES.LOSS, { ago: 400 * minute }),
    pick('a', OUTCOMES.WIN, { ago: 300 * minute }),
    pick('a', OUTCOMES.WIN, { ago: 200 * minute }),
    pick('a', OUTCOMES.WIN, { ago: 100 * minute }),
  ];

  assert.equal(computeRecord(picks).streak, 3);
  assert.equal(formatStreak(3), '🔥 3 in a row');
});

test('a losing streak reads as negative', () => {
  const picks = [
    pick('a', OUTCOMES.WIN, { ago: 300 * minute }),
    pick('a', OUTCOMES.LOSS, { ago: 200 * minute }),
    pick('a', OUTCOMES.LOSS, { ago: 100 * minute }),
  ];

  assert.equal(computeRecord(picks).streak, -2);
  assert.equal(formatStreak(-2), '🧊 2 down');
});

test('a record can be limited to a window', () => {
  const picks = [
    pick('a', OUTCOMES.LOSS, { ago: 40 * 86400000 }),
    pick('a', OUTCOMES.WIN, { ago: 2 * 86400000 }),
  ];

  const last7 = computeRecord(picks, { sinceDays: 7, now });
  assert.equal(last7.decided, 1);
  assert.equal(last7.wins, 1);
});

test('one lucky call does not outrank a long record', () => {
  const picks = [
    ...Array.from({ length: 8 }, (_, i) => pick('veteran', i < 5 ? OUTCOMES.WIN : OUTCOMES.LOSS)),
    pick('newcomer', OUTCOMES.WIN),
  ];

  const board = leaderboard(picks, { minimum: 5, now });

  assert.deepEqual(board.ranked.map((row) => row.analystId), ['veteran']);
  assert.deepEqual(board.provisional.map((row) => row.analystId), ['newcomer'], 'shown, but apart');
});

test('the leaderboard sorts by win rate and breaks ties on volume', () => {
  const picks = [
    ...Array.from({ length: 10 }, (_, i) => pick('a', i < 8 ? OUTCOMES.WIN : OUTCOMES.LOSS)),
    ...Array.from({ length: 5 }, (_, i) => pick('b', i < 4 ? OUTCOMES.WIN : OUTCOMES.LOSS)),
    ...Array.from({ length: 20 }, (_, i) => pick('c', i < 16 ? OUTCOMES.WIN : OUTCOMES.LOSS)),
  ];

  const board = leaderboard(picks, { minimum: 5, now });

  // a and c both sit at 80%; the one with four times the calls ranks first.
  assert.deepEqual(board.ranked.map((row) => row.analystId), ['c', 'a', 'b']);
});

test('open calls are counted separately from settled ones', () => {
  const open = buildPick({ analystId: 'a', guildId: 'g', direction: 'down', asset: 'BTC', minutes: 15, now });
  const record = computeRecord([open, pick('a', OUTCOMES.WIN)], { analystId: 'a' });

  assert.equal(record.open, 1);
  assert.equal(record.settled, 1);
});

test('an empty board is empty rather than broken', () => {
  const board = leaderboard([], { now });
  assert.deepEqual(board.ranked, []);
  assert.deepEqual(board.provisional, []);
});

// Routing tests: a missing import or a command reached through the wrong path
// parses fine and only explodes in the server. /call in particular carries no
// subcommand, so anything that calls getSubcommand() before routing it throws.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createStore } from '../src/lib/store.js';
import { buildCommands, handleInteraction } from '../src/vip/commands.js';

const routingConfig = {
  guildId: 'g',
  modRoleIds: [],
  codePrefix: 'VIP',
  codeLength: 6,
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'r1', label: 'Signals', perks: ['x'] },
    2: { tier: 2, priceCents: 10000, roleId: 'r2', label: 'VIP', perks: ['x'] },
    3: { tier: 3, priceCents: 20000, roleId: 'r3', label: 'Elite', perks: ['x'] },
  },
  picks: { analystRoleIds: [], defaultMinutes: 15, defaultAsset: 'BTC', minimumForBoard: 5, disclaimer: 'nfa' },
};

function routingStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'picks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

function callInteraction(name, options = {}, { subcommand = null, isAdmin = true } = {}) {
  const replies = [];
  const posted = [];
  return {
    replies,
    posted,
    interaction: {
      commandName: name,
      guildId: 'g',
      user: { id: 'analyst1', tag: 'analyst#1', username: 'analyst' },
      member: { roles: { cache: { has: () => false } } },
      memberPermissions: { has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator },
      deferred: false,
      replied: false,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      client: {
        channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => { posted.push(p); return { id: 'msg1' }; } }) },
      },
      channel: { isTextBased: () => true, send: async (p) => { posted.push(p); return { id: 'msg1' }; } },
      options: {
        getSubcommand: () => {
          if (!subcommand) throw new Error('no subcommand on this command');
          return subcommand;
        },
        getString: (key) => options[key] ?? null,
        getInteger: (key) => options[key] ?? null,
        getNumber: (key) => options[key] ?? null,
        getBoolean: (key) => options[key] ?? null,
        getUser: (key) => options[key] ?? null,
      },
      deferReply: async function () {
        this.deferred = true;
      },
      reply: async (payload) => replies.push(payload),
      editReply: async (payload) => replies.push(payload),
    },
  };
}

test('/call is routed without ever asking for a subcommand', async (t) => {
  const store = routingStore(t);
  const { interaction, replies, posted } = callInteraction('call', { direction: 'up' });

  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(posted.length, 1, 'the call was posted');
  assert.match(replies[0], /Call posted/);
  assert.equal(store.listPicks().length, 1);
  assert.equal(store.listPicks()[0].asset, 'BTC', 'the default asset applied');
});

test('a member without the analyst role cannot post a call', async (t) => {
  const store = routingStore(t);
  const { interaction, replies, posted } = callInteraction('call', { direction: 'up' }, { isAdmin: false });

  await handleInteraction(interaction, {
    store,
    config: { ...routingConfig, picks: { ...routingConfig.picks, analystRoleIds: ['analyst-role'] } },
    client: interaction.client,
  });

  assert.equal(posted.length, 0);
  assert.match(replies[0].content, /Only the analysts/);
});

test('/picks board and record are routed', async (t) => {
  const store = routingStore(t);

  const board = callInteraction('picks', {}, { subcommand: 'board' });
  await handleInteraction(board.interaction, { store, config: routingConfig, client: board.interaction.client });
  assert.match(board.replies[0].embeds[0].toJSON().title, /Leaderboard/);

  const record = callInteraction('picks', {}, { subcommand: 'record' });
  await handleInteraction(record.interaction, { store, config: routingConfig, client: record.interaction.client });
  assert.match(record.replies[0], /has not posted a call yet/);
});

test('the pick commands are registered alongside the VIP ones', () => {
  const names = buildCommands(routingConfig).map((command) => command.name);
  assert.deepEqual(names, ['vip', 'vip-admin', 'call', 'picks']);
});

test('command registration survives a config with no picks block', () => {
  const { picks, ...without } = routingConfig;
  assert.doesNotThrow(() => buildCommands(without), 'one unset variable must not cost every command');
});
