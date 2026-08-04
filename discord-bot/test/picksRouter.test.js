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

  const interaction = fakeInteraction('edge');
  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /The market is the better forecaster/);
  assert.match(reply, /no edge here to trade/i);

  // And the grading must have been written back, or every run regrades from
  // scratch and the log never settles.
  assert.ok(store.listQuotes('BTC').every((row) => row.outcome !== null));
});
