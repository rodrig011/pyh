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
      getNumber: (name) => options[name] ?? null,
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

test('an opposite call is refused while one is still open', async () => {
  const store = freshStore();
  const open = {
    id: 'live',
    guildId: 'g',
    analystId: 'mod',
    asset: 'BTC',
    direction: 'down',
    entry: 61,
    priceUnit: 'cents',
    outcome: null,
    createdAt: Date.now(),
  };
  store.recordPick(open);

  const interaction = fakeInteraction('call');
  interaction.options.getString = (name) => (name === 'direction' ? 'up' : null);
  interaction.options.getInteger = (name) => (name === 'size' ? 50 : null);
  interaction.options.getNumber = () => null;

  const { handleCall } = await import('../src/picks/commands.js');
  await handleCall(interaction, { store, config });

  // Nothing new was posted, and the analyst is told which call is in the way.
  assert.equal(store.listPicks().length, 1);
  const said = String(interaction.replies.at(-1));
  assert.match(said, /still have a/);
  assert.match(said, /CASH OUT/);
});

test('the same direction is not treated as a conflict', async () => {
  const store = freshStore();
  store.recordPick({
    id: 'live',
    guildId: 'g',
    analystId: 'mod',
    asset: 'BTC',
    direction: 'up',
    outcome: null,
    createdAt: Date.now(),
  });

  const interaction = fakeInteraction('call');
  interaction.options.getString = (name) => (name === 'direction' ? 'up' : null);
  interaction.options.getInteger = (name) => (name === 'size' ? 50 : null);
  interaction.options.getNumber = () => null;

  const { handleCall } = await import('../src/picks/commands.js');
  await handleCall(interaction, { store, config });

  assert.doesNotMatch(String(interaction.replies.at(-1)), /still have a/);
});

test('another analyst’s open call never blocks yours', async () => {
  const store = freshStore();
  store.recordPick({
    id: 'theirs',
    guildId: 'g',
    analystId: 'someone-else',
    asset: 'BTC',
    direction: 'down',
    outcome: null,
    createdAt: Date.now(),
  });

  const interaction = fakeInteraction('call');
  interaction.options.getString = (name) => (name === 'direction' ? 'up' : null);
  interaction.options.getInteger = (name) => (name === 'size' ? 50 : null);
  interaction.options.getNumber = () => null;

  const { handleCall } = await import('../src/picks/commands.js');
  await handleCall(interaction, { store, config });

  assert.doesNotMatch(String(interaction.replies.at(-1)), /still have a/);
});

test('a closed call in the other direction does not block anything', async () => {
  const store = freshStore();
  store.recordPick({
    id: 'done',
    guildId: 'g',
    analystId: 'mod',
    asset: 'BTC',
    direction: 'down',
    outcome: 'win',
    createdAt: Date.now(),
  });

  const interaction = fakeInteraction('call');
  interaction.options.getString = (name) => (name === 'direction' ? 'up' : null);
  interaction.options.getInteger = (name) => (name === 'size' ? 50 : null);
  interaction.options.getNumber = () => null;

  const { handleCall } = await import('../src/picks/commands.js');
  await handleCall(interaction, { store, config });

  assert.doesNotMatch(String(interaction.replies.at(-1)), /still have a/);
});

test('/picks account says what is missing before anyone hunts for a key', async () => {
  const interaction = fakeInteraction('account');
  await handlePicks(interaction, { store: freshStore(), config });

  const said = String(interaction.replies.at(-1));
  assert.match(said, /No Kalshi account is connected/);
  assert.match(said, /KALSHI_PRIVATE_KEY/);
  // The promise that matters: the credential can trade, this cannot.
  assert.match(said, /cannot place, change or cancel an order/);
});

test('/picks account is refused to anyone who is not a mod', async () => {
  const interaction = fakeInteraction('account', {}, { admin: false });
  await handlePicks(interaction, { store: freshStore(), config });

  assert.match(String(interaction.replies.at(-1)), /Only the mods/);
});

test('/picks account names the markets traded, so a wrong series filter is visible', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const fetchImpl = async (url) => ({
    ok: true,
    json: async () =>
      url.includes('/fills')
        ? { fills: [{ ticker: 'KXBTCD-26AUG03-T63000', side: 'yes', action: 'buy', count: 1, yes_price_dollars: '0.40', created_time: '2026-08-03T06:00:00Z' }] }
        : { balance: 855 },
  });

  const { fetchFills, foldFills } = await import('../src/picks/kalshiAccount.js');
  const account = {
    keyId: 'k',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    seriesTicker: 'KXBTC15M',
  };

  const { fills } = await fetchFills(account, { fetchImpl });
  // He traded the daily series; the filter is watching the 15-minute one.
  assert.equal(fills.length, 1);
  assert.equal(foldFills(fills, { seriesTicker: 'KXBTC15M' }).length, 0);
  assert.equal(foldFills(fills, { seriesTicker: 'KXBTCD' }).length, 1);
});

test('/picks account answers with credentials set, all the way through', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  // The account path was only ever tested without credentials, so it returned
  // early and never ran the half of the handler that reads a live account —
  // which is exactly where an undefined name survived to production.
  const withAccount = {
    guildId: 'g',
    picks: {
      defaultAsset: 'BTC',
      defaultMinutes: 15,
      kalshi: {
        account: {
          keyId: 'key-1',
          privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
          seriesTicker: 'KXBTC15M',
        },
      },
    },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => '',
    json: async () =>
      String(url).includes('/fills')
        ? {
            fills: [
              {
                ticker: 'KXBTCD-26AUG03-T63000',
                side: 'yes',
                action: 'buy',
                count: 1,
                yes_price_dollars: '0.40',
                created_time: '2026-08-03T06:00:00Z',
              },
            ],
          }
        : { balance: 855 },
  });

  try {
    const interaction = fakeInteraction('account');
    await handlePicks(interaction, { store: freshStore(), config: withAccount });

    const payload = interaction.replies.at(-1);
    const text = JSON.stringify(payload);
    assert.match(text, /connected/i);
    assert.match(text, /KXBTCD-26AUG03-T63000/);
    // He trades the daily series while the filter watches the 15-minute one.
    assert.match(text, /Nothing will publish/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a fill that cannot be read is printed raw rather than silently dropped', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const withAccount = {
    guildId: 'g',
    picks: {
      kalshi: {
        account: {
          keyId: 'key-1',
          privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
          seriesTicker: 'KXBTC15M',
        },
      },
    },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => '',
    json: async () =>
      String(url).includes('/fills')
        ? {
            // Right series, but the price is under a name the folder does not
            // know — which is how "connected, 0 positions" happens.
            fills: [{ ticker: 'KXBTC15M-26AUG031630-30', side: 'yes', action: 'buy', quantity: 3, price_fp: '390000' }],
          }
        : { balance: 140 },
  });

  try {
    const interaction = fakeInteraction('account');
    await handlePicks(interaction, { store: freshStore(), config: withAccount });

    const text = JSON.stringify(interaction.replies.at(-1));
    assert.match(text, /none could be read/);
    assert.match(text, /price_fp/, 'the unknown field has to be visible to be fixed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/picks undo-auto removes only what the account published', async () => {
  const store = freshStore();
  const now = Date.now();

  store.recordPick({ id: 'auto-1', guildId: 'g', fromAccount: true, createdAt: now, outcome: 'win' });
  store.recordPick({ id: 'auto-2', guildId: 'g', fromAccount: true, createdAt: now, outcome: 'loss' });
  // Sent by hand from the console: never collateral damage.
  store.recordPick({ id: 'by-hand', guildId: 'g', createdAt: now, outcome: 'win' });
  // Published automatically, but yesterday.
  store.recordPick({ id: 'old', guildId: 'g', fromAccount: true, createdAt: now - 86_400_000 });

  const preview = fakeInteraction('undo-auto', { minutes: 60 });
  await handlePicks(preview, { store, config });
  assert.match(String(preview.replies.at(-1)), /would delete \*\*2\*\*/);
  assert.equal(store.listPicks().length, 4, 'a preview destroys nothing');

  const confirmed = fakeInteraction('undo-auto', { minutes: 60, confirm: true });
  await handlePicks(confirmed, { store, config });

  const left = store.listPicks().map((pick) => pick.id).sort();
  assert.deepEqual(left, ['by-hand', 'old']);
});

test('/picks undo-auto is refused to anyone who is not a mod', async () => {
  const interaction = fakeInteraction('undo-auto', {}, { admin: false });
  await handlePicks(interaction, { store: freshStore(), config });
  assert.match(String(interaction.replies.at(-1)), /Only the mods/);
});

test('/picks edge says plainly that nothing has settled yet', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('edge');

  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /Recorded \*\*0\*\*/);
  // The one instruction that matters when the log is empty: it is not
  // recording, and the reason is a setting.
  assert.match(reply, /KALSHI_ENABLED/);
});

test('/picks edge reports the market winning, rather than hiding it', async () => {
  // The result nobody wants and everybody needs. A market that forecasts
  // better than the model means there is no business here, and the command
  // has to say so in those words rather than burying it in a score.
  const store = freshStore();
  const now = Date.now();
  const log = [];

  for (let i = 0; i < 40; i += 1) {
    const ticker = `KXBTC15M-${i}`;
    const finishedAbove = i % 2 === 0;
    // The market is right and the model is confidently backwards.
    log.push({
      at: now - 600_000 + i * 1000,
      ticker,
      asset: 'BTC',
      spot: finishedAbove ? 65_100 : 64_800,
      strike: 65_000,
      bid: finishedAbove ? 89 : 9,
      ask: finishedAbove ? 91 : 11,
      secondsLeft: 0,
      model: finishedAbove ? 0.1 : 0.9,
      outcome: null,
    });
  }
  store.putQuotes('BTC', log);
  // Spot samples spanning each market's close, which is what grading needs now
  // that a market settles on its clock rather than on an observed zero.
  const samples = [];
  for (let i = 0; i < 200; i += 1) {
    samples.push({ at: now - 700_000 + i * 3000, price: i % 2 === 0 ? 65_100 : 64_800 });
  }
  store.putSamples('BTC', samples);

  const interaction = fakeInteraction('edge');
  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /The market is the better forecaster/);
  assert.match(reply, /no edge here to trade/i);

  // And the grading must have been written back, or every run regrades from
  // scratch and the log never settles.
  assert.ok(store.listQuotes('BTC').every((row) => row.outcome !== null));
});

test('/picks read says what is missing before anyone hunts for a bug', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('read');

  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /KALSHI_ENABLED/);
});

test('/picks read runs end to end with the feed on', async () => {
  // The whole path: contract, spot, samples, model, message. Every previous
  // command in this file shipped with a name that was never imported, and this
  // is the cheapest place to catch the next one.
  const store = freshStore();

  // An hour of price history, so the model has a volatility to work from.
  const now = Date.now();
  const samples = [];
  let price = 65_000;
  let state = 999;
  for (let i = 120; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    samples.push({ at: now - i * 30_000, price });
  }
  store.putSamples('BTC', samples);

  const interaction = fakeInteraction('read');
  await handlePicks(interaction, {
    store,
    config: {
      ...config,
      picks: {
        ...config.picks,
        kalshi: { enabled: true, seriesTicker: 'KXBTC15M', side: 'yes' },
      },
    },
  });

  const reply = String(interaction.replies.at(-1));
  // Either a real read or an honest "the feed did not answer" — never a crash
  // and never a silent empty reply.
  assert.ok(reply.length > 0);
  assert.ok(
    /UP|DOWN|No open market|No spot price|No read/.test(reply),
    `unexpected reply: ${reply.slice(0, 200)}`,
  );
});

test('/picks backfill run twice leaves the same record, not double', async () => {
  // The bug as reported from the room: running it again adds instead of
  // replacing, and a 7-0 record becomes 14-0, then 21-0. A restore states what
  // the record IS, so running it twice must leave exactly what running it once
  // left.
  const store = freshStore();
  const analyst = { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' };

  for (let run = 0; run < 3; run += 1) {
    const interaction = fakeInteraction('backfill', { analyst, wins: 7, losses: 2 });
    await handlePicks(interaction, { store, config });
  }

  const picks = store.listPicks().filter((pick) => pick.analystId === 'kingt');
  assert.equal(picks.length, 9, `three runs of 7W-2L left ${picks.length} calls`);

  const wins = picks.filter((pick) => pick.outcome === 'win').length;
  assert.equal(wins, 7);
});

test('/picks backfill leaves live-graded calls alone', async () => {
  // Only the restored ones are replaceable. A call the bot actually graded is
  // real history and must survive a restore.
  const store = freshStore();
  store.putPick({
    id: 'live-1',
    analystId: 'kingt',
    guildId: 'g',
    outcome: 'win',
    direction: 'up',
    asset: 'BTC',
  });

  for (let run = 0; run < 2; run += 1) {
    const interaction = fakeInteraction('backfill', {
      analyst: { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' },
      wins: 3,
      losses: 1,
    });
    await handlePicks(interaction, { store, config });
  }

  const picks = store.listPicks().filter((pick) => pick.analystId === 'kingt');
  assert.ok(picks.some((pick) => pick.id === 'live-1'), 'the live call was deleted');
  assert.equal(picks.length, 5, '4 restored + 1 live');
});

test('/picks backfill says which part of the record came from where', async () => {
  // The reason a working restore was reported as broken: the reply quoted the
  // TOTAL record, which also holds every call the bot graded live — and with
  // Kalshi auto-publish on, those arrive by themselves all day. The total grew
  // between restores and it looked exactly like adding up.
  const store = freshStore();
  for (let i = 0; i < 4; i += 1) {
    store.putPick({
      id: `live-${i}`,
      analystId: 'kingt',
      guildId: 'g',
      outcome: 'win',
      direction: 'up',
      asset: 'BTC',
    });
  }

  const interaction = fakeInteraction('backfill', {
    analyst: { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' },
    wins: 7,
    losses: 2,
  });
  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /7W 2L\*\* restored by hand/);
  assert.match(reply, /graded live by the bot/);
  // And it says plainly that running it again does not stack.
  assert.match(reply, /never adds/);
});

test('/picks backfill with replace_all makes the record EXACTLY what was typed', async () => {
  // The thing that was actually being asked for: change the record, not add
  // to it. Without this the restore is correct and the total is still wrong,
  // because the calls the bot graded live are untouchable and keep arriving.
  const store = freshStore();
  for (let i = 0; i < 20; i += 1) {
    store.putPick({
      id: `live-${i}`,
      analystId: 'kingt',
      guildId: 'g',
      outcome: 'win',
      direction: 'up',
      asset: 'BTC',
    });
  }

  const first = fakeInteraction('backfill', {
    analyst: { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' },
    wins: 5,
    losses: 1,
    replace_all: true,
  });
  await handlePicks(first, { store, config });

  const picks = store.listPicks().filter((pick) => pick.analystId === 'kingt');
  assert.equal(picks.length, 6, `expected exactly 5W+1L, got ${picks.length}`);
  assert.equal(picks.filter((pick) => pick.outcome === 'win').length, 5);

  // And changing it again lands on the new number, not the sum of both.
  const second = fakeInteraction('backfill', {
    analyst: { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' },
    wins: 3,
    losses: 2,
    replace_all: true,
  });
  await handlePicks(second, { store, config });

  const after = store.listPicks().filter((pick) => pick.analystId === 'kingt');
  assert.equal(after.length, 5, `expected exactly 3W+2L, got ${after.length}`);
  assert.equal(after.filter((pick) => pick.outcome === 'win').length, 3);
});

test('without replace_all the live calls survive, and it says how to change that', async () => {
  const store = freshStore();
  store.putPick({ id: 'live-1', analystId: 'kingt', guildId: 'g', outcome: 'win', direction: 'up', asset: 'BTC' });

  const interaction = fakeInteraction('backfill', {
    analyst: { id: 'kingt', tag: 'kingt_67', username: 'kingt_67' },
    wins: 4,
    losses: 0,
  });
  await handlePicks(interaction, { store, config });

  assert.ok(store.listPicks().some((pick) => pick.id === 'live-1'), 'live call must survive');
  assert.match(String(interaction.replies.at(-1)), /replace_all/);
});

test('/picks read never says BUY when nothing is cheap enough to buy', async () => {
  // Reported from the room: "buy at 62, target 61%". Buy this in order to sell
  // it lower. It happened because the model still had a direction and the
  // headline reached for it — but a direction is not an instruction, and the
  // headline is the only line most people read.
  const store = freshStore();
  const now = Date.now();
  const samples = [];
  let price = 65_000;
  let state = 777;
  for (let i = 120; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    samples.push({ at: now - i * 30_000, price });
  }
  store.putSamples('BTC', samples);

  const interaction = fakeInteraction('read');
  await handlePicks(interaction, {
    store,
    config: {
      ...config,
      picks: { ...config.picks, kalshi: { enabled: true, seriesTicker: 'KXBTC15M', side: 'yes' } },
    },
  });

  const reply = String(interaction.replies.at(-1));

  // Whatever it decided, a BUY headline and a target below the entry can never
  // appear together.
  const buy = reply.match(/BUY (?:UP|DOWN) @ (\d+)%/);
  const target = reply.match(/Target (\d+)%/);
  if (buy && target) {
    assert.ok(
      Number(target[1]) > Number(buy[1]),
      `headline says buy at ${buy[1]}% with target ${target[1]}%`,
    );
  }
});

test('/picks read never says BUY and "not worth trading" in the same message', async () => {
  // The message that made the point: headline "BUY UP @ 4%", and four lines
  // later "there is no exit here that pays" and "not worth trading". All three
  // came from one read and only one of them can be the headline.
  const store = freshStore();
  const now = Date.now();
  const samples = [];
  let price = 65_000;
  let state = 31337;
  for (let i = 120; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    samples.push({ at: now - i * 30_000, price });
  }
  store.putSamples('BTC', samples);

  const interaction = fakeInteraction('read');
  await handlePicks(interaction, {
    store,
    config: {
      ...config,
      picks: { ...config.picks, kalshi: { enabled: true, seriesTicker: 'KXBTC15M', side: 'yes' } },
    },
  });

  const reply = String(interaction.replies.at(-1));
  const saysBuy = /BUY (?:UP|DOWN) @/.test(reply);
  const saysNo = /NO TRADE|not worth trading|no exit here that pays/i.test(reply);

  assert.ok(!(saysBuy && saysNo), `contradicts itself:\n${reply.slice(0, 400)}`);

  // And a real buy always says how long to hold it, because "get in" without
  // "stay in until told" is what makes people sell on the first wobble.
  if (saysBuy) assert.match(reply, /Hold it/);
});

/**
 * `/picks paper`, driven through the router.
 *
 * "The reset doesn't work" was reported from Discord, and no test touched the
 * command — only the pure functions underneath it, which were fine. That is
 * the pattern this file exists for.
 */

const paperConfig = {
  guildId: 'g',
  picks: {
    defaultAsset: 'BTC',
    defaultMinutes: 15,
    kalshi: { enabled: true, seriesTicker: 'KXBTC' },
  },
};

test('/picks paper starts a run and stores it against the caller', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('paper', {});

  await handlePicks(interaction, { store, config: paperConfig });

  const account = store.paperAccount();
  assert.equal(account.userId, 'mod');
  assert.equal(account.cash, 70);
  assert.match(String(interaction.replies.at(-1)), /Paper trading started/);
});

test('/picks paper reset actually wipes cash, trades and the refusal count', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });

  // A run with some history on it.
  store.putPaperAccount({
    ...store.paperAccount(),
    cash: 11.4,
    seen: 900,
    refused: 890,
    census: { no_edge: 890 },
    trades: [{ profit: -5, contracts: 10, entryCents: 50, exitCents: 20 }],
  });

  const interaction = fakeInteraction('paper', { reset: true });
  await handlePicks(interaction, { store, config: paperConfig });

  const account = store.paperAccount();
  assert.equal(account.cash, 70);
  assert.equal(account.seen, 0);
  assert.equal(account.refused, 0);
  assert.deepEqual(account.trades, []);
  assert.deepEqual(account.census, {});
  assert.match(String(interaction.replies.at(-1)), /reset/i);
});

test('/picks paper reset honours a new bankroll', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });

  await handlePicks(fakeInteraction('paper', { reset: true, bankroll: 250 }), {
    store,
    config: paperConfig,
  });

  assert.equal(store.paperAccount().cash, 250);
  assert.equal(store.paperAccount().start, 250);
});

test('/picks paper without reset reports instead of silently starting over', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });
  store.putPaperAccount({ ...store.paperAccount(), cash: 88.25, seen: 40, refused: 40 });

  const interaction = fakeInteraction('paper', {});
  await handlePicks(interaction, { store, config: paperConfig });

  assert.equal(store.paperAccount().cash, 88.25);
  assert.match(String(interaction.replies.at(-1)), /reset:True/);
});

test('/picks paper says so when the contract feed is switched off', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('paper', {});
  await handlePicks(interaction, { store, config });

  assert.equal(store.paperAccount(), null);
  assert.match(String(interaction.replies.at(-1)), /contract feed is off/);
});

/**
 * `/picks read`, driven through the router with a whole ladder of strikes.
 *
 * This is the command the room runs, and it was reading one contract —
 * whichever closed soonest. So it answered NO TRADE almost every time and the
 * room concluded the bot was too strict. It was near-sighted, not strict.
 */

const priceHistory = () => {
  const samples = [];
  let price = 65_000;
  let state = 20_260_805;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.003);
    samples.push({ at: Date.now() - (120 - i) * 30_000, price });
  }
  return samples;
};

const ladderBoard = (cents = [82, 70, 58, 44, 30, 18], base = 64_400) => ({
  contracts: cents.map((price, i) => ({
    price,
    market: {
      ticker: `KXBTC-${base + i * 200}`,
      floor_strike: base + i * 200,
      status: 'active',
      close_time: new Date(Date.now() + 420_000).toISOString(),
      yes_bid_dollars: String((price - 1) / 100),
      yes_ask_dollars: String((price + 1) / 100),
      liquidity_dollars: '5000',
    },
  })),
});

function storeWithHistory() {
  const store = freshStore();
  store.putSamples('BTC', priceHistory());
  return store;
}

test('/picks read reports how much of the board it looked at', async () => {
  const store = storeWithHistory();
  const interaction = fakeInteraction('read', {});

  await handlePicks(interaction, {
    store,
    config: paperConfig,
    deps: {
      openBoard: async () => ladderBoard(),
      fetchSpotPrice: async () => ({ price: 65_000 }),
    },
  });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /Read \*\*6\*\* strike\(s\)/);
  assert.match(reply, /KXBTC-/);
});

test('/picks read refusing the whole board says why, not just that it refused', async () => {
  const store = storeWithHistory();
  const interaction = fakeInteraction('read', {});

  await handlePicks(interaction, {
    store,
    config: paperConfig,
    deps: {
      // Every strike priced at exactly what the model would say: nothing to win.
      openBoard: async () => ladderBoard([50, 50, 50]),
      fetchSpotPrice: async () => ({ price: 65_000 }),
    },
  });

  const reply = String(interaction.replies.at(-1));
  if (/NO TRADE/.test(reply)) {
    assert.match(reply, /refused all of them/);
  }
});

test('/picks read says so when the board comes back empty', async () => {
  const store = storeWithHistory();
  const interaction = fakeInteraction('read', {});

  await handlePicks(interaction, {
    store,
    config: paperConfig,
    deps: {
      openBoard: async () => ({ contracts: [], error: 'HTTP 503' }),
      fetchSpotPrice: async () => ({ price: 65_000 }),
    },
  });

  assert.match(String(interaction.replies.at(-1)), /No open market.*503/);
});

test('/picks read survives a feed that throws', async () => {
  const store = storeWithHistory();
  const interaction = fakeInteraction('read', {});

  await handlePicks(interaction, {
    store,
    config: paperConfig,
    deps: {
      openBoard: async () => {
        throw new Error('socket hang up');
      },
      fetchSpotPrice: async () => ({ price: 65_000 }),
    },
  });

  assert.match(String(interaction.replies.at(-1)), /No open market/);
});
