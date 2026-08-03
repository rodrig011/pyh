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
  describePick,
  editPickOutcome,
  leaderboard,
  nextCandleClose,
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
  const made = buildPick({
    analystId: 'a', guildId: 'g', direction: 'up', asset: 'btc', minutes: 15,
    alignToCandle: false, now,
  });

  assert.equal(made.asset, 'BTC');
  assert.equal(made.closesAt, now + 15 * minute);
  assert.equal(made.outcome, null);
});

// "It says closes in 15 mins so it's gonna overlap next candle." A 15-minute
// market settles on the quarter hour, so the call has to end where the candle
// does — not fifteen minutes after whenever a button was pressed.

test('a call closes on the next candle boundary, not 15 minutes from now', () => {
  const at341 = Date.parse('2026-08-02T15:41:00Z');
  const made = buildPick({ analystId: 'a', guildId: 'g', direction: 'up', asset: 'BTC', minutes: 15, now: at341 });

  assert.equal(new Date(made.closesAt).toISOString(), '2026-08-02T15:45:00.000Z');
});

test('a boundary seconds away is skipped rather than sold as a call', () => {
  const at344_50 = Date.parse('2026-08-02T15:44:50Z');
  const made = buildPick({ analystId: 'a', guildId: 'g', direction: 'up', asset: 'BTC', minutes: 15, now: at344_50 });

  assert.equal(new Date(made.closesAt).toISOString(), '2026-08-02T16:00:00.000Z');
});

test('nextCandleClose lands on the hour for a 60-minute window', () => {
  const at1512 = Date.parse('2026-08-02T15:12:00Z');
  assert.equal(new Date(nextCandleClose(at1512, 60)).toISOString(), '2026-08-02T16:00:00.000Z');
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
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async (p) => { posted.push(p); return { id: 'msg1' }; },
            messages: { fetch: async () => ({ edit: async () => {} }) },
          }),
        },
      },
      channel: {
        isTextBased: () => true,
        send: async (p) => { posted.push(p); return { id: 'msg1' }; },
        messages: { fetch: async () => ({ edit: async () => {} }) },
      },
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
  const { interaction, replies, posted } = callInteraction('call', { direction: 'up', size: 50 });

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

import {
  analystPanel,
  entrySizeRow,
  simpleAnnouncement,
  parseSize,
  readPercent,
  guideMessage,
  managementMessage,
  panelAction,
  PANEL_ACTIONS,
} from '../src/picks/panel.js';
import {
  callerRoleIds,
  gradeQuote,
  pickEmbed,
  pickSettings,
  priceLabel,
  promptDueSettlements,
  publishVoteResults,
} from '../src/picks/commands.js';
import { castVote, emptyVote, tallyVote } from '../src/picks/vote.js';

test('panel button ids map to actions, and nothing else does', () => {
  assert.equal(panelAction('pick:panel:up'), PANEL_ACTIONS.UP);
  assert.equal(panelAction('pick:panel:cash_out'), PANEL_ACTIONS.CASH_OUT);
  assert.equal(panelAction('pick:panel:nonsense'), null);
  assert.equal(panelAction('vip:buy:1'), null);
  assert.equal(panelAction(undefined), null);
});

test('a management message names the call it belongs to', () => {
  const message = managementMessage({
    action: PANEL_ACTIONS.CASH_OUT,
    analystId: 'a1',
    pick: { asset: 'BTC', minutes: 15, entry: 97000 },
    price: '$97,500.00',
  });

  const embed = message.embeds[0].toJSON();
  assert.match(embed.title, /Cash out/i);
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
import { pingFor } from '../src/picks/commands.js';

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
  const { interaction, posted } = callInteraction('call', { direction: 'up', size: 50 });

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
    'pick:panel:cash_out',
    'pick:panel:cut_loss',
    'pick:panel:hold',
  ]);
});

// King T's complaint, reproduced: he pressed CASH AT PROFIT and the bot ignored
// it, kept counting to the 15-minute mark and scored the call on where price
// happened to be then. "It's going every 15 minutes. Not when we go in or out."

function panelPress(action, userId = 'analyst1') {
  const replies = [];
  const posted = [];
  return {
    replies,
    posted,
    interaction: {
      customId: `pick:panel:${action}`,
      guildId: 'g',
      user: { id: userId, tag: 'analyst#1', username: 'analyst' },
      member: { roles: { cache: { has: () => false } } },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      deferred: false,
      replied: false,
      isButton: () => true,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      client: {
        channels: {
          fetch: async () => ({ isTextBased: () => true, send: async (p) => posted.push(p) }),
        },
      },
      channel: { isTextBased: () => true, send: async (p) => posted.push(p) },
      deferReply: async function () {
        this.deferred = true;
      },
      reply: async (payload) => replies.push(payload),
      editReply: async (payload) => replies.push(payload),
      showModal: async () => {},
    },
  };
}

function openCallIn(store, { direction = DIRECTIONS.UP, entry = 63297.58, analystId = 'analyst1' } = {}) {
  const pick = buildPick({
    analystId,
    guildId: 'g',
    direction,
    asset: 'BTC',
    minutes: 15,
    entry,
    now: Date.now(),
  });
  pick.channelId = 'c1';
  pick.messageId = 'm1';
  store.recordPick(pick);
  return pick;
}

function withPrice(t, amount) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: String(amount) } }) });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test('cashing out in profit closes the call there and then', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store, { direction: DIRECTIONS.DOWN, entry: 63297.58 });
  withPrice(t, 63281.84);

  const { interaction, replies } = panelPress('cash_out');
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  const closed = store.getPick(pick.id);
  assert.equal(closed.outcome, OUTCOMES.WIN, 'a short closed lower is a win');
  assert.equal(closed.exit, 63281.84, 'scored at the exit, not at the window');
  assert.equal(closed.closedBy, 'exit');
  assert.match(replies[0], /Closed your \*\*BTC\*\* call/);
});

test('a call the analyst cashed is never regraded when the window runs out', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store, { direction: DIRECTIONS.DOWN, entry: 63297.58 });
  withPrice(t, 63281.84);

  const press = panelPress('cash_out');
  await handleInteraction(press.interaction, { store, config: routingConfig, client: press.interaction.client });

  // Price then runs the other way and the window expires — the exact sequence
  // that turned a cashed win into a recorded loss.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { amount: '63381.36' } }) });
  store.getPick(pick.id).closesAt = Date.now() - 1000;

  const swept = await promptDueSettlements(
    { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => {} }) } },
    store,
    routingConfig,
  );

  assert.equal(swept.graded, 0, 'a closed call is not due for anything');
  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.WIN, 'still the win he took');
  assert.equal(store.getPick(pick.id).exit, 63281.84);
});

test('cutting a loss closes the call too', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store, { direction: DIRECTIONS.UP, entry: 63300 });
  withPrice(t, 63200);

  const { interaction } = panelPress('cut_loss');
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.LOSS);
  assert.equal(store.getPick(pick.id).closedBy, 'exit');
});

test('holding leaves the call running', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  withPrice(t, 63400);

  const { interaction } = panelPress('hold');
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.getPick(pick.id).outcome, null, 'nothing changed, so nothing is scored');
});

test('cashing out with nothing open says so instead of inventing a message', async (t) => {
  const store = routingStore(t);
  const { interaction, replies, posted } = panelPress('cash_out');

  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(posted.length, 0, 'the room was not told to close a position nobody opened');
  assert.match(replies[0], /no open call/i);
});

test('a member who is not an analyst cannot press anything', async (t) => {
  const store = routingStore(t);
  openCallIn(store);

  const { interaction, replies, posted } = panelPress('cash_out', 'random-member');
  interaction.memberPermissions = { has: () => false };

  await handleInteraction(interaction, {
    store,
    config: { ...routingConfig, picks: { ...routingConfig.picks, analystRoleIds: ['analyst-role'] } },
    client: interaction.client,
  });

  assert.equal(posted.length, 0);
  assert.match(replies[0].content, /Only the analysts/);
});

test('with no analyst role configured, Manage Messages is not enough', async (t) => {
  const store = routingStore(t);
  const { interaction, replies, posted } = panelPress('up', 'a-moderator');
  // Every moderator holds this. A member pressing BUY UP by accident sends a
  // real signal to everyone paying for one.
  interaction.memberPermissions = { has: (flag) => flag === PermissionFlagsBits.ManageMessages };

  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(posted.length, 0);
  assert.match(replies[0].content, /Only the analysts/);
});

test('a settled call stops counting down and says how it ended', () => {
  const pick = buildPick({
    analystId: 'a1', guildId: 'g', direction: DIRECTIONS.UP, asset: 'BTC',
    minutes: 15, entry: 63351.415, now: Date.now() - 20 * minute,
  });
  settlePick(pick, { outcome: OUTCOMES.WIN, settledBy: 'a1', exit: 63380.185, closedBy: 'exit' });

  const embed = pickEmbed(pick, routingConfig).toJSON();
  const names = embed.fields.map((f) => f.name);

  assert.ok(!names.includes('Window'), 'no stale countdown on a finished call');
  assert.ok(names.includes('Closed'));
  assert.match(embed.fields.find((f) => f.name === 'Closed').value, /analyst closed it/);
  assert.equal(embed.fields.find((f) => f.name === 'Entry').value, '$63,351.42', 'formatted, not a raw float');
  assert.match(embed.fields.find((f) => f.name === 'Result').value, /\$63,380\.19/);
});

test('/picks reset previews before it destroys anything', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'bot' });
  store.putPick(pick);

  const preview = callInteraction('picks', { analyst: { id: 'analyst1' } }, { subcommand: 'reset' });
  await handleInteraction(preview.interaction, { store, config: routingConfig, client: preview.interaction.client });

  assert.match(preview.replies[0], /This would delete/);
  assert.equal(store.listPicks().length, 1, 'nothing was deleted');

  const confirmed = callInteraction(
    'picks',
    { analyst: { id: 'analyst1' }, confirm: true },
    { subcommand: 'reset' },
  );
  await handleInteraction(confirmed.interaction, { store, config: routingConfig, client: confirmed.interaction.client });

  assert.match(confirmed.replies[0], /Wiped \*\*1\*\*/);
  assert.equal(store.listPicks().length, 0);
});

test('a non-mod cannot wipe a record', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'bot' });
  store.putPick(pick);

  const { interaction, replies } = callInteraction(
    'picks',
    { analyst: { id: 'analyst1' }, confirm: true },
    { subcommand: 'reset', isAdmin: false },
  );
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.match(replies[0], /Only the mods/);
  assert.equal(store.listPicks().length, 1);
});

// Sizing. "Take 50% off" and "get everything out" are the same word to somebody
// who has not traded before, so the two must not behave the same way.

test('cashing out closes the call and takes the whole position', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store, { direction: DIRECTIONS.UP, entry: 63300 });
  withPrice(t, 63400);

  const { interaction, posted } = panelPress('cash_out');
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.WIN);
  assert.equal(store.getPick(pick.id).closedBy, 'exit');
  assert.match(posted[0].embeds[0].toJSON().title, /Cash out/i);
  assert.match(posted[0].embeds[0].toJSON().description, /everything/i);
});

test('there is no partial exit, because Kalshi has none', () => {
  assert.equal(PANEL_ACTIONS.CASH_25, undefined);
  assert.equal(PANEL_ACTIONS.ALL_OUT, undefined);
  assert.equal(PANEL_ACTIONS.CASH_PERCENT, undefined);
  assert.ok(PANEL_ACTIONS.CASH_OUT, 'the exit is one button that takes everything');
});

test('the console comes back after a call closes', async (t) => {
  const store = routingStore(t);
  openCallIn(store, { direction: DIRECTIONS.UP, entry: 63300 });
  withPrice(t, 63400);

  const { interaction, posted } = panelPress('cash_out');
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  const panels = posted.filter((message) =>
    message.embeds?.[0]?.toJSON().title?.includes('Analyst console'),
  );
  assert.equal(panels.length, 1, 'the next signal is one tap away, not fifty messages up');
});

test('the console does not come back when that is switched off', async (t) => {
  const store = routingStore(t);
  openCallIn(store, { direction: DIRECTIONS.UP, entry: 63300 });
  withPrice(t, 63400);

  const { interaction, posted } = panelPress('cash_out');
  await handleInteraction(interaction, {
    store,
    config: { ...routingConfig, picks: { ...routingConfig.picks, repostPanel: false } },
    client: interaction.client,
  });

  assert.equal(
    posted.filter((m) => m.embeds?.[0]?.toJSON().title?.includes('Analyst console')).length,
    0,
  );
});

test('the guide explains every button the console has', () => {
  const guide = guideMessage(routingConfig, pickSettings(routingConfig));
  const text = JSON.stringify(guide.embeds[0].toJSON());

  for (const phrase of ['LONG', 'SHORT', 'of port', 'CASH OUT', 'CUT LOSS', 'HOLD']) {
    assert.ok(text.includes(phrase), `the guide never mentions ${phrase}`);
  }
  assert.match(text, /own money and your own size/, 'and says whose risk it is');
});

// Editing a result. These numbers are public and members judge the room by
// them, so an edit has to leave a trail and be announced — otherwise it is a
// way to launder a record rather than correct one.

test('editing an outcome keeps what it was, who changed it and why', () => {
  const pick = openPick();
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'price-feed' });

  const result = editPickOutcome(pick, {
    outcome: OUTCOMES.WIN,
    editedBy: 'mod1',
    note: 'cashed at 6% before the candle turned',
  });

  assert.equal(result.changed, true);
  assert.equal(result.from, OUTCOMES.LOSS);
  assert.equal(pick.outcome, OUTCOMES.WIN);
  assert.equal(pick.edits.length, 1);
  assert.equal(pick.edits[0].from, OUTCOMES.LOSS);
  assert.equal(pick.edits[0].by, 'mod1');
  assert.match(pick.edits[0].note, /cashed at 6%/);
  assert.equal(pick.settledBy, 'mod1', 'it no longer claims the feed decided it');
});

test('every edit is appended, so the whole history survives', () => {
  const pick = openPick();
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'price-feed' });
  editPickOutcome(pick, { outcome: OUTCOMES.WIN, editedBy: 'mod1' });
  editPickOutcome(pick, { outcome: OUTCOMES.VOID, editedBy: 'mod2' });

  assert.deepEqual(pick.edits.map((e) => [e.from, e.to]), [
    [OUTCOMES.LOSS, OUTCOMES.WIN],
    [OUTCOMES.WIN, OUTCOMES.VOID],
  ]);
});

test('editing to what it already says changes nothing', () => {
  const pick = openPick();
  settlePick(pick, { outcome: OUTCOMES.WIN, settledBy: 'price-feed' });

  const result = editPickOutcome(pick, { outcome: OUTCOMES.WIN, editedBy: 'mod1' });

  assert.equal(result.changed, false);
  assert.equal(pick.edits, undefined, 'no empty entry in the history');
});

test('an edited outcome moves the record', () => {
  const win = openPick();
  const loss = openPick();
  settlePick(win, { outcome: OUTCOMES.WIN, settledBy: 'feed' });
  settlePick(loss, { outcome: OUTCOMES.LOSS, settledBy: 'feed' });

  assert.equal(computeRecord([win, loss]).winRate, 0.5);
  editPickOutcome(loss, { outcome: OUTCOMES.WIN, editedBy: 'mod1' });
  assert.equal(computeRecord([win, loss]).winRate, 1);
});

test('voiding a call takes it out of the win rate entirely', () => {
  const win = openPick();
  const bad = openPick();
  settlePick(win, { outcome: OUTCOMES.WIN, settledBy: 'feed' });
  settlePick(bad, { outcome: OUTCOMES.LOSS, settledBy: 'feed' });

  editPickOutcome(bad, { outcome: OUTCOMES.VOID, editedBy: 'mod1' });
  const record = computeRecord([win, bad]);

  assert.equal(record.decided, 1);
  assert.equal(record.winRate, 1);
});

test('a call is described by what a mod would recognise, not its id', () => {
  const pick = buildPick({
    analystId: 'a1', guildId: 'g', direction: DIRECTIONS.DOWN, asset: 'BTC', minutes: 15,
    now: Date.parse('2026-08-02T15:41:00Z'),
  });
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'feed' });

  const label = describePick(pick);
  assert.match(label, /08\/02/);
  assert.match(label, /SHORT BTC 15m/);
  assert.match(label, /Loss/);
  assert.ok(label.length <= 100, 'Discord truncates a choice name past 100 characters');
});

test('/picks edit changes the result and announces the correction', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'price-feed' });
  store.putPick(pick);

  const { interaction, replies, posted } = callInteraction(
    'picks',
    { call: pick.id, outcome: OUTCOMES.WIN, reason: 'cashed before the turn' },
    { subcommand: 'edit' },
  );
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.WIN);
  assert.equal(posted.length, 1, 'the room was told');
  assert.match(posted[0].content, /Correction/);
  assert.match(posted[0].content, /cashed before the turn/);
  assert.match(replies[0], /100%/);
});

test('a non-mod cannot change a result', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  settlePick(pick, { outcome: OUTCOMES.LOSS, settledBy: 'price-feed' });
  store.putPick(pick);

  const { interaction, replies, posted } = callInteraction(
    'picks',
    { call: pick.id, outcome: OUTCOMES.WIN },
    { subcommand: 'edit', isAdmin: false },
  );
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.match(replies[0], /Only the mods/);
  assert.equal(store.getPick(pick.id).outcome, OUTCOMES.LOSS, 'untouched');
  assert.equal(posted.length, 0);
});

/** A bare open call, for the pure-function tests above. */
function openPick() {
  return buildPick({
    analystId: 'a1', guildId: 'g', direction: DIRECTIONS.UP, asset: 'BTC', minutes: 15,
    now: Date.now(),
  });
}

// Entry size and the room's vote.

test('a direction button asks for the size instead of firing the call', async (t) => {
  const store = routingStore(t);
  const { interaction, replies, posted } = panelPress('up');

  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.listPicks().length, 0, 'nothing sent until the size is chosen');
  assert.equal(posted.length, 0);
  assert.match(replies[0].content, /how much of the port/i);
  assert.equal(replies[0].components.length, 1);
});

test('the size button sends the call and records what was chosen', async (t) => {
  const store = routingStore(t);
  withPrice(t, 63300);

  const { interaction, replies, posted } = panelPress('up');
  interaction.customId = 'pick:size:up:50';
  interaction.deferUpdate = async function () {
    this.deferred = true;
  };

  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.listPicks().length, 1);
  assert.equal(store.listPicks()[0].sizePercent, 50);
  assert.equal(posted.length, 1);
  assert.match(replies[0].content, /50% of port/);
});

test('a nonsense size is not accepted', () => {
  assert.equal(parseSize('pick:size:up:50').percent, 50);
  assert.equal(parseSize('pick:size:sideways:50'), null);
  assert.equal(parseSize('pick:size:up:0'), null);
  assert.equal(parseSize('pick:size:up:500'), null);
  assert.equal(parseSize('pick:panel:up'), null);
});

test('closing a call opens the vote', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store, { direction: DIRECTIONS.UP, entry: 63300 });
  withPrice(t, 63400);

  const { interaction } = panelPress('cash_out');
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  const vote = store.getVote(pick.id);
  assert.ok(vote, 'the room was asked');
  assert.ok(vote.closesAt > Date.now());
});

test('a member votes once and can change their mind', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  store.recordVote({ ...emptyVote(pick.id, { closesAt: Date.now() + 60000 }) });

  const first = panelPress('x', 'member1');
  first.interaction.customId = `pick:vote:${pick.id}:profit`;
  await handleInteraction(first.interaction, { store, config: routingConfig, client: first.interaction.client });

  const second = panelPress('x', 'member1');
  second.interaction.customId = `pick:vote:${pick.id}:loss`;
  await handleInteraction(second.interaction, { store, config: routingConfig, client: second.interaction.client });

  assert.deepEqual(tallyVote(store.getVote(pick.id)), {
    profit: 0, loss: 1, total: 1, profitShare: 0,
  });
});

test('the result publishes both answers and closes the vote', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store);
  settlePick(pick, { outcome: OUTCOMES.WIN, settledBy: 'feed' });
  store.putPick(pick);

  const vote = emptyVote(pick.id, { closesAt: Date.now() - 1000 });
  castVote(vote, 'a', 'profit');
  castVote(vote, 'b', 'loss');
  castVote(vote, 'c', 'loss');
  store.recordVote(vote);

  const posted = [];
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (p) => posted.push(p),
        messages: { fetch: async () => ({ edit: async () => {} }) },
      }),
    },
  };

  const published = await publishVoteResults(client, store, routingConfig);

  assert.equal(published, 1);
  const embed = posted[0].embeds[0].toJSON();
  // The bot said win, the room said it lost money — the disagreement is the point.
  assert.match(embed.fields.find((f) => f.name === 'The bot scored it').value, /Win/);
  assert.match(embed.fields.find((f) => f.name === 'The room says').value, /Lost money/);
  assert.match(embed.description, /33%/);
  assert.ok(store.getVote(pick.id).resultPostedAt, 'not published twice');

  assert.equal(await publishVoteResults(client, store, routingConfig), 0);
});

// Custom entry size, contract pricing and who gets tagged for the vote.

test('the size row offers an escape from the presets', () => {
  const ids = entrySizeRow(DIRECTIONS.UP).toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, [
    'pick:size:up:25',
    'pick:size:up:50',
    'pick:size:up:75',
    'pick:size:up:100',
    'pick:size:up:custom',
  ]);
});

test('the custom button is recognised as custom, not as a percentage', () => {
  assert.deepEqual(parseSize('pick:size:up:custom'), { direction: 'up', percent: null, custom: true });
  assert.equal(parseSize('pick:size:up:50').custom, false);
});

test('a typed percentage is read, and nonsense is refused', () => {
  assert.equal(readPercent('15'), 15);
  assert.equal(readPercent(' 12.5 % '), 12.5);
  assert.equal(readPercent('0'), null);
  assert.equal(readPercent('150'), null);
  assert.equal(readPercent('a lot'), null);
  assert.equal(readPercent(null), null);
});

test('a typed size opens the call at that size', async (t) => {
  const store = routingStore(t);
  withPrice(t, 63300);

  const { interaction, replies } = panelPress('x');
  interaction.customId = 'pick:sizemodal:up';
  interaction.isButton = () => false;
  interaction.isModalSubmit = () => true;
  interaction.fields = { getTextInputValue: (key) => (key === 'percent' ? '15' : '') };

  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.listPicks()[0].sizePercent, 15);
  assert.match(replies[0], /15% of port/);
});

test('a call priced in cents is graded on the contract, not on spot', () => {
  const pick = buildPick({
    analystId: 'a1', guildId: 'g', direction: DIRECTIONS.UP, asset: 'BTC', minutes: 15,
    entry: 80, now: Date.now(),
  });
  pick.priceUnit = 'cents';

  // The direction was right but the contract was bought expensive: on a scalp
  // that is a loss, and spot would have called it a win.
  assert.equal(gradeQuote(pick, 55).outcome, OUTCOMES.LOSS);
  assert.equal(gradeQuote(pick, 95).outcome, OUTCOMES.WIN);
});

test('prices are shown in the unit the call was opened in', () => {
  const cents = { priceUnit: 'cents' };
  const usd = { priceUnit: 'usd' };
  assert.equal(priceLabel(cents, 47), '47¢');
  assert.equal(priceLabel(usd, 63300), '$63,300.00');
  assert.equal(priceLabel(cents, null), '—');
});

test('the vote tags the tiers that are in the room to answer it', async (t) => {
  const store = routingStore(t);
  const pick = openCallIn(store, { direction: DIRECTIONS.UP, entry: 63300 });
  withPrice(t, 63400);

  const config = {
    ...routingConfig,
    picks: { ...routingConfig.picks, votePingRoleIds: ['tier2', 'tier3'] },
  };

  const { interaction, posted } = panelPress('cash_out');
  await handleInteraction(interaction, { store, config, client: interaction.client });

  const ask = posted.find((message) => /Did you make money/.test(message.content ?? ''));
  assert.ok(ask, 'the room was asked');
  assert.match(ask.content, /<@&tier2>/);
  assert.match(ask.content, /<@&tier3>/);
  assert.deepEqual(ask.allowedMentions.roles, ['tier2', 'tier3']);
  assert.ok(store.getVote(pick.id));
});

// A call without a size is half an instruction: the room can act on "long BTC
// with a quarter of your book", not on "long BTC". Every path has to insist.

test('/call will not register without a size', () => {
  const call = buildCommands(routingConfig).find((command) => command.name === 'call');
  const size = call.options.find((option) => option.name === 'size');

  assert.ok(size, 'the option exists');
  assert.equal(size.required, true);
  assert.equal(size.min_value, 1);
  assert.equal(size.max_value, 100);
});

test('/call sends the size the analyst gave', async (t) => {
  const store = routingStore(t);
  withPrice(t, 63300);

  const { interaction, posted } = callInteraction('call', { direction: 'up', size: 35 });
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.listPicks()[0].sizePercent, 35);
  assert.match(posted[0].embeds[0].toJSON().fields.find((f) => f.name === 'Size').value, /35%/);
});

test('a call with no size is refused rather than posted half-formed', async (t) => {
  const store = routingStore(t);
  withPrice(t, 63300);

  const { interaction, replies, posted } = callInteraction('call', { direction: 'up' });
  await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });

  assert.equal(store.listPicks().length, 0);
  assert.equal(posted.length, 0);
  assert.match(replies[0], /needs a size/i);
});

test('a size outside 0–100 never becomes a call', async (t) => {
  const store = routingStore(t);
  withPrice(t, 63300);

  for (const size of [0, -5, 150]) {
    const { interaction } = callInteraction('call', { direction: 'up', size });
    await handleInteraction(interaction, { store, config: routingConfig, client: interaction.client });
  }

  assert.equal(store.listPicks().length, 0);
});

test('the one-line announcement always carries the size', () => {
  const line = simpleAnnouncement({
    direction: DIRECTIONS.UP, asset: 'BTC', minutes: 15, sizePercent: 50, entry: null,
  });
  assert.match(line.content, /50% of port/);
});

// In most rooms the analysts are the mods. The permission check has always
// known that; the command's visibility did not, so /call hid behind Manage
// Messages from the very people allowed to use it.

test('mods count as callers, so /call is not hidden from them', () => {
  const modsOnly = { ...routingConfig, modRoleIds: ['mod-role'], picks: { ...routingConfig.picks, analystRoleIds: [] } };

  assert.deepEqual(callerRoleIds(modsOnly), ['mod-role']);

  const call = buildCommands(modsOnly).find((command) => command.name === 'call');
  assert.equal(call.default_member_permissions, null, 'visible to everyone, gated in code');
});

test('with neither list set the command stays behind a permission', () => {
  const call = buildCommands(routingConfig).find((command) => command.name === 'call');
  assert.ok(call.default_member_permissions, 'nothing configured means nothing open');
});

test('a mod can press the console when only the mod role is configured', async (t) => {
  const store = routingStore(t);
  const { interaction, replies } = panelPress('up', 'a-mod');
  interaction.memberPermissions = { has: () => false };
  interaction.member = { roles: { cache: { has: (id) => id === 'mod-role' } } };

  await handleInteraction(interaction, {
    store,
    config: { ...routingConfig, modRoleIds: ['mod-role'] },
    client: interaction.client,
  });

  assert.match(replies[0].content, /how much of the port/i, 'let through, not turned away');
});
