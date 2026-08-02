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

// The console and automatic grading. Grading is the part that decides what goes
// on a public leaderboard, so it is driven end to end here rather than trusted.

import { analystPanel, panelAction, PANEL_ACTIONS, managementMessage } from '../src/picks/panel.js';
import { promptDueSettlements } from '../src/picks/commands.js';

test('panel button ids map to actions, and nothing else does', () => {
  assert.equal(panelAction('pick:panel:up'), PANEL_ACTIONS.UP);
  assert.equal(panelAction('pick:panel:cash_profit'), PANEL_ACTIONS.CASH_PROFIT);
  assert.equal(panelAction('pick:panel:nonsense'), null);
  assert.equal(panelAction('vip:buy:1'), null);
  assert.equal(panelAction(undefined), null);
});

test('a management message names the call it belongs to', () => {
  const message = managementMessage({
    action: PANEL_ACTIONS.CASH_PERCENT,
    analystId: 'a1',
    pick: { asset: 'BTC', minutes: 15, entry: 97000 },
    percent: 50,
    price: '$97,500.00',
  });

  const embed = message.embeds[0].toJSON();
  assert.match(embed.title, /50%/);
  assert.match(embed.description, /BTC/);
  assert.ok(embed.fields.some((field) => field.name === 'Price now'));
});

function settlingClient(posted) {
  return {
    channels: {
      fetch: async () => ({ isTextBased: () => true, send: async (p) => posted.push(p) }),
    },
  };
}

test('a call with a live entry grades itself from the price', async (t) => {
  const store = routingStore(t);
  const pick = buildPick({
    analystId: 'a1',
    guildId: 'g',
    direction: DIRECTIONS.UP,
    asset: 'BTC',
    minutes: 15,
    entry: 97000,
    now: Date.now() - 16 * 60000,
  });
  pick.channelId = 'c1';
  store.recordPick(pick);

  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: '97500.00' } }) });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await promptDueSettlements(settlingClient(posted), store, routingConfig);

  assert.equal(result.graded, 1);
  assert.equal(result.asked, 0, 'nobody was asked to confirm what the tape already said');
  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.WIN);
  assert.equal(store.getPick(pick.id).exit, 97500);
  assert.match(posted[0].content, /97,500/);
});

test('a down call that went up is graded a loss, not skipped', async (t) => {
  const store = routingStore(t);
  const pick = buildPick({
    analystId: 'a1',
    guildId: 'g',
    direction: DIRECTIONS.DOWN,
    asset: 'BTC',
    minutes: 15,
    entry: 97000,
    now: Date.now() - 16 * 60000,
  });
  pick.channelId = 'c1';
  store.recordPick(pick);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: '98000.00' } }) });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await promptDueSettlements(settlingClient([]), store, routingConfig);
  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.LOSS);
});

test('with no price the analyst is asked instead of the call being lost', async (t) => {
  const store = routingStore(t);
  const pick = buildPick({
    analystId: 'a1',
    guildId: 'g',
    direction: DIRECTIONS.UP,
    asset: 'BTC',
    minutes: 15,
    entry: null,
    now: Date.now() - 16 * 60000,
  });
  pick.channelId = 'c1';
  store.recordPick(pick);

  const posted = [];
  const result = await promptDueSettlements(settlingClient(posted), store, routingConfig);

  assert.equal(result.asked, 1);
  assert.equal(store.getPick(pick.id).outcome, null, 'still open until a human says');
  assert.ok(posted[0].components?.length, 'the grading buttons were offered');
});

test('a call is only ever settled once', async (t) => {
  const store = routingStore(t);
  const pick = buildPick({
    analystId: 'a1',
    guildId: 'g',
    direction: DIRECTIONS.UP,
    asset: 'BTC',
    minutes: 15,
    entry: 97000,
    now: Date.now() - 16 * 60000,
  });
  pick.channelId = 'c1';
  store.recordPick(pick);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: '97500.00' } }) });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await promptDueSettlements(settlingClient([]), store, routingConfig);
  const second = await promptDueSettlements(settlingClient([]), store, routingConfig);

  assert.equal(second.graded, 0);
  assert.equal(second.asked, 0);
});

// Pinging: the people paying for signals are the ones who have to see them, and
// the bot must never be able to reach past those roles.
import { pingFor, pickSettings } from '../src/picks/commands.js';

const pinging = {
  ...routingConfig,
  picks: { ...routingConfig.picks, pingRoleIds: ['tier1', 'tier2', 'tier3'] },
};

test('a call mentions every VIP tier and permits exactly those roles', () => {
  const ping = pingFor(pickSettings(pinging));

  assert.equal(ping.content, '<@&tier1> <@&tier2> <@&tier3>');
  assert.deepEqual(ping.allowedMentions, { roles: ['tier1', 'tier2', 'tier3'] });
});

test('allowedMentions is always set, so @everyone can never be reached', () => {
  const ping = pingFor(pickSettings(routingConfig));

  assert.equal(ping.content, undefined, 'nothing to mention');
  assert.deepEqual(ping.allowedMentions, { roles: [] }, 'and nothing is permitted');
});

test('the call posted to the channel carries the ping', async (t) => {
  const store = routingStore(t);
  const { interaction, posted } = callInteraction('call', { direction: 'up' });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: '97000' } }) });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleInteraction(interaction, { store, config: pinging, client: interaction.client });

  assert.match(posted[0].content, /<@&tier1>/);
  assert.deepEqual(posted[0].allowedMentions.roles, ['tier1', 'tier2', 'tier3']);
});

test('CUT LOSS is a real action with its own message', () => {
  assert.equal(panelAction('pick:panel:cut_loss'), PANEL_ACTIONS.CUT_LOSS);

  const message = managementMessage({
    action: PANEL_ACTIONS.CUT_LOSS,
    analystId: 'a1',
    pick: { asset: 'BTC', minutes: 15, entry: 97000 },
  });

  const embed = message.embeds[0].toJSON();
  assert.match(embed.title, /Cut the loss/);
  assert.match(embed.description, /take the loss/i);
});

test('the console offers every action, cutting losses included', () => {
  const panel = analystPanel(pinging, pickSettings(pinging));
  const ids = panel.components.flatMap((row) =>
    row.toJSON().components.map((component) => component.custom_id),
  );

  assert.deepEqual(ids, [
    'pick:panel:up',
    'pick:panel:down',
    'pick:panel:cash_percent',
    'pick:panel:cash_profit',
    'pick:panel:cut_loss',
    'pick:panel:hold',
  ]);
});
