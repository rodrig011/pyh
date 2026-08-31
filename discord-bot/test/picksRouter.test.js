import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';
import { handlePicks } from '../src/picks/commands.js';
import { newRiskState } from '../src/picks/riskLimits.js';

// Every subcommand here was reachable only through Discord, so a name that was
// never imported got all the way to a mod running the command in front of the
// room — `/picks backfill` answered "sendLog is not defined". These drive the
// router directly, which is the cheapest place to catch that class of mistake.

const interactionChannelPosts = [];

function fakeInteraction(sub, options = {}, { admin = true, channel = false } = {}) {
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
    channelId: 'chan-1',
    guild: channel ? { members: { me: { permissionsIn: () => ({ has: () => true }) } } } : undefined,
    // Only handed a channel where a test needs one posted to: several other
    // routes branch on whether one exists at all.
    channel: channel
      ? {
          id: 'chan-1',
          isTextBased: () => true,
          send: async (payload) => {
            interactionChannelPosts.push(payload);
            return { id: 'msg-1' };
          },
        }
      : undefined,
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
  assert.match(String(interaction.replies.at(-1)), /for the mods|Only the mods/);
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
  assert.match(said, /\*\*OUT\*\*/);
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

  assert.match(String(interaction.replies.at(-1)), /for the mods|Only the mods/);
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
  assert.match(String(interaction.replies.at(-1)), /for the mods|Only the mods/);
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
  //
  // The markets are spaced two minutes apart on purpose. An earlier version of
  // this fixture packed forty of them into forty seconds, so their 60-second
  // settlement windows all overlapped and every one graded the same way — which
  // made the model and the market score IDENTICALLY, 0.4100 each, gap 0.0000.
  // The assertion passed anyway, because the command used to print "the market
  // is the better forecaster" on any non-positive sign, an exact tie included.
  const store = freshStore();
  const now = Date.now();
  const log = [];
  const samples = [];

  const SPACING = 120_000;
  const closeOf = (i) => now - 120_000 - (39 - i) * SPACING;

  for (let i = 0; i < 40; i += 1) {
    const finishedAbove = i % 2 === 0;
    const closesAt = closeOf(i);

    // The market is right and the model is confidently backwards.
    log.push({
      at: closesAt,
      ticker: `KXBTC15M-${i}`,
      asset: 'BTC',
      spot: finishedAbove ? 65_100 : 64_800,
      strike: 65_000,
      bid: finishedAbove ? 89 : 9,
      ask: finishedAbove ? 91 : 11,
      secondsLeft: 0,
      model: finishedAbove ? 0.1 : 0.9,
      outcome: null,
    });

    // Spot across this market's own settlement window, so it grades the way
    // the fixture claims rather than the way the neighbours' prices decide.
    for (let t = 90_000; t >= 0; t -= 10_000) {
      samples.push({ at: closesAt - t, price: finishedAbove ? 65_100 : 64_800 });
    }
  }

  store.putQuotes('BTC', log);
  store.putSamples('BTC', samples.sort((a, b) => a.at - b.at));

  const interaction = fakeInteraction('edge');
  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /The market is the better forecaster/);
  assert.match(reply, /no edge here to trade/i);

  // And the grading must have been written back, or every run regrades from
  // scratch and the log never settles.
  assert.ok(store.listQuotes('BTC').every((row) => row.outcome !== null));
});

test('/picks edge refuses to call a tie a defeat', async () => {
  // A gap of zero is the definition of "too close to call", and the command
  // used to print it as "the market is the better forecaster, there is no edge
  // here to trade" — retiring a strategy on a coin flip. Both verdicts now
  // demand the same proof.
  const store = freshStore();
  const now = Date.now();
  const log = [];
  const samples = [];
  const closeOf = (i) => now - 120_000 - (39 - i) * 120_000;

  for (let i = 0; i < 40; i += 1) {
    const finishedAbove = i % 2 === 0;
    const closesAt = closeOf(i);
    // Model and market mirror each other, so neither can win.
    log.push({
      at: closesAt,
      ticker: `TIE-${i}`,
      asset: 'BTC',
      spot: finishedAbove ? 65_100 : 64_800,
      strike: 65_000,
      bid: 49,
      ask: 51,
      secondsLeft: 0,
      model: 0.5,
      outcome: null,
    });
    for (let t = 90_000; t >= 0; t -= 10_000) {
      samples.push({ at: closesAt - t, price: finishedAbove ? 65_100 : 64_800 });
    }
  }

  store.putQuotes('BTC', log);
  store.putSamples('BTC', samples.sort((a, b) => a.at - b.at));

  const interaction = fakeInteraction('edge');
  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /Too close to call/);
  assert.doesNotMatch(reply, /is the better forecaster/);
});

test('/picks edge separates any-positive-edge from the bar the engine holds', async () => {
  // "+1.84¢ across 1721 trades" was reported under the label "taking only what
  // it liked", and it fired on 95% of all observations — a strategy the bot has
  // never run. Compared against a 2¢ fee it says "no business"; the engine's
  // own bar is a different, much smaller set of rows.
  const store = freshStore();
  const now = Date.now();
  const log = [];
  const samples = [];
  const closeOf = (i) => now - 120_000 - (39 - i) * 120_000;

  for (let i = 0; i < 40; i += 1) {
    const finishedAbove = i % 2 === 0;
    const closesAt = closeOf(i);
    // A one-cent lean on most markets, a fat one on a few.
    const fat = i % 10 === 0;
    log.push({
      at: closesAt,
      ticker: `BAR-${i}`,
      asset: 'BTC',
      spot: finishedAbove ? 65_100 : 64_800,
      strike: 65_000,
      bid: 49,
      ask: 51,
      secondsLeft: 0,
      model: fat ? 0.72 : 0.52,
      outcome: null,
    });
    for (let t = 90_000; t >= 0; t -= 10_000) {
      samples.push({ at: closesAt - t, price: finishedAbove ? 65_100 : 64_800 });
    }
  }

  store.putQuotes('BTC', log);
  store.putSamples('BTC', samples.sort((a, b) => a.at - b.at));

  const interaction = fakeInteraction('edge');
  await handlePicks(interaction, { store, config });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /Any positive edge/);
  assert.match(reply, /engine's own bar \(6¢\)/);
  // The two counts are different, which is the whole point of showing both.
  const any = /Any positive edge:.*?(\d+) of (\d+) row/s.exec(reply);
  const bar = /own bar \(6¢\):.*?(\d+) of (\d+) row/s.exec(reply);
  if (any && bar) assert.notEqual(any[1], bar[1]);
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

  // Two runs by default: careful and scalp, side by side.
  const accounts = store.paperAccounts();
  assert.deepEqual(Object.keys(accounts).sort(), ['careful', 'scalp']);
  for (const account of Object.values(accounts)) {
    assert.equal(account.userId, 'mod');
    assert.equal(account.cash, 70);
  }
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

  for (const account of Object.values(store.paperAccounts())) {
    assert.equal(account.cash, 70);
    assert.equal(account.seen, 0);
    assert.equal(account.refused, 0);
    assert.deepEqual(account.trades, []);
    assert.deepEqual(account.census, {});
  }
  assert.match(String(interaction.replies.at(-1)), /reset/i);
});

test('/picks paper reset honours a new bankroll', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });

  await handlePicks(fakeInteraction('paper', { reset: true, bankroll: 250 }), {
    store,
    config: paperConfig,
  });

  for (const account of Object.values(store.paperAccounts())) {
    assert.equal(account.cash, 250);
    assert.equal(account.start, 250);
  }
});

test('/picks paper without reset reports instead of silently starting over', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });
  store.putPaperAccount({ ...store.paperAccount('scalp'), cash: 88.25, seen: 40, refused: 40 });

  const interaction = fakeInteraction('paper', {});
  await handlePicks(interaction, { store, config: paperConfig });

  assert.equal(store.paperAccount('scalp').cash, 88.25);
  assert.match(String(interaction.replies.at(-1)), /reset:True/);
});

test('/picks paper mode:always while careful+scalp are running says so, instead of silently doing nothing', async () => {
  // The exact confusion reported live: asking for a different mode while a
  // run is already going ignores `mode` entirely and just reports what is
  // already there — reasonable behavior, but silent about WHY the mode
  // typed in did nothing, which read as the command being broken.
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig }); // starts careful+scalp

  const interaction = fakeInteraction('paper', { mode: 'always' });
  await handlePicks(interaction, { store, config: paperConfig });

  assert.deepEqual(Object.keys(store.paperAccounts()).sort(), ['careful', 'scalp']);
  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /you asked for \*\*always\*\*/i);
  assert.match(reply, /careful, scalp.*actually running/i);
  assert.match(reply, /reset:True/);
});

test('/picks paper without an explicit mode does not claim a mismatch that was never asked for', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });

  const interaction = fakeInteraction('paper', {});
  await handlePicks(interaction, { store, config: paperConfig });

  assert.doesNotMatch(String(interaction.replies.at(-1)), /you asked for/i);
});

test('/picks paper says so when the contract feed is switched off', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('paper', {});
  await handlePicks(interaction, { store, config });

  assert.deepEqual(store.paperAccounts(), {});
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

/**
 * `/picks panel` — the panel that turns pulled signals into pushed ones.
 *
 * Wiring, again: the panel is worthless if the channel it was posted in is not
 * remembered, and nothing about that is visible from reading the message.
 */

test('/picks signals posts the panel and remembers where it lives', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('signals', {}, { channel: true });

  await handlePicks(interaction, { store, config: paperConfig });

  const panel = store.signalPanel();
  assert.equal(panel.channelId, 'chan-1');
  assert.equal(panel.messageId, 'msg-1');
  assert.match(String(interaction.replies.at(-1)), /Panel posted/);
});

test('/picks signals is refused to anyone who is not a mod', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('signals', {}, { admin: false, channel: true });

  await handlePicks(interaction, { store, config: paperConfig });

  assert.equal(store.signalPanel(), null);
  assert.match(String(interaction.replies.at(-1)), /for the mods|Only the mods/);
});

test('/picks signals promises nothing about the win rate', async () => {
  // The one thing a signals panel must never do is claim a hit rate. It reports
  // the measured one, sample size attached, or says there is not one yet.
  const store = freshStore();
  const interaction = fakeInteraction('signals', {}, { channel: true });
  await handlePicks(interaction, { store, config: paperConfig });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /measured/i);
  assert.doesNotMatch(reply, /guarantee|guaranteed|win rate of \d/i);
});

/**
 * `/picks` is mods-only, and members keep the two things that were theirs.
 */

test('a member running /picks is refused and told where the calls are', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('read', {}, { admin: false });

  await handlePicks(interaction, { store, config: paperConfig });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /for the mods/);
  // A refusal that does not say what somebody CAN do sends them to ask a human.
  assert.match(reply, /DM me the calls/);
});

test('the mods gate covers every subcommand, not the ones remembered', async () => {
  // The failure this guards: a subcommand added later, gated nowhere, reachable
  // by anyone who knows its name. The check is on the router, so it covers
  // whatever exists rather than whatever was listed.
  const store = freshStore();
  for (const sub of ['read', 'edge', 'paper', 'backfill', 'signals', 'record']) {
    const interaction = fakeInteraction(sub, {}, { admin: false });
    await handlePicks(interaction, { store, config: paperConfig });
    assert.match(String(interaction.replies.at(-1)), /for the mods/, `${sub} was not gated`);
  }
});

test('a mod still gets through to every subcommand', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('record', {});
  await handlePicks(interaction, { store, config: paperConfig });
  assert.doesNotMatch(String(interaction.replies.at(-1)), /for the mods/);
});

test('/picks dm turns the call DMs on for a mod and off again', async () => {
  const store = freshStore();

  const on = fakeInteraction('dm', { on: true });
  await handlePicks(on, { store, config: paperConfig });
  assert.equal(Boolean(store.signalDms()['mod']), true);
  assert.match(String(on.replies.at(-1)), /On — the calls will come/);

  const off = fakeInteraction('dm', { on: false });
  await handlePicks(off, { store, config: paperConfig });
  assert.equal(Boolean(store.signalDms()['mod']), false);
});

test('/picks dm with no argument toggles rather than demanding a state', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('dm', {}), { store, config: paperConfig });
  assert.equal(Boolean(store.signalDms()['mod']), true);

  await handlePicks(fakeInteraction('dm', {}), { store, config: paperConfig });
  assert.equal(Boolean(store.signalDms()['mod']), false);
});

test('turning on what is already on says so instead of writing again', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('dm', { on: true }), { store, config: paperConfig });
  const again = fakeInteraction('dm', { on: true });
  await handlePicks(again, { store, config: paperConfig });
  assert.match(String(again.replies.at(-1)), /Already on/);
});

test('/picks paper mode:scalp runs only the one asked for', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', { mode: 'scalp' }), { store, config: paperConfig });
  assert.deepEqual(Object.keys(store.paperAccounts()), ['scalp']);
});

test('/picks paper mode:always is selectable and runs alone, not folded into "both"', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', { mode: 'always' }), { store, config: paperConfig });
  assert.deepEqual(Object.keys(store.paperAccounts()), ['always']);
  assert.equal(store.paperAccount('always').profile, 'always');
});

test('both runs start from the same bankroll on the same clock', async () => {
  // Same markets, same instant, same money. Anything else and the difference
  // between them stops being the profile.
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });

  const [a, b] = Object.values(store.paperAccounts());
  assert.equal(a.start, b.start);
  assert.equal(a.startedAt, b.startedAt);
  assert.notEqual(a.profile, b.profile);
});

test('/picks paper on an existing pair reports both, not one', async () => {
  const store = freshStore();
  await handlePicks(fakeInteraction('paper', {}), { store, config: paperConfig });

  const interaction = fakeInteraction('paper', {});
  await handlePicks(interaction, { store, config: paperConfig });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /CAREFUL/);
  assert.match(reply, /SCALP/);
  assert.match(reply, /Already running/);
});

/**
 * `/picks live` — the only command that can spend real money.
 */

const liveConfig = {
  ...paperConfig,
  picks: {
    ...paperConfig.picks,
    kalshi: {
      ...paperConfig.picks.kalshi,
      trading: { ownerId: 'mod', dailyLimitDollars: 20 },
    },
  },
};

test('live trading starts disarmed and stays that way until somebody arms it', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('live', {});
  await handlePicks(interaction, { store, config: liveConfig });

  assert.match(String(interaction.replies.at(-1)), /Disarmed/);
  assert.notEqual(store.riskState()?.armed, true);
});

test('arming is refused without trading credentials on the host', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('live', { action: 'arm' });
  await handlePicks(interaction, { store, config: liveConfig });

  assert.match(String(interaction.replies.at(-1)), /No trading credentials/);
  assert.notEqual(store.riskState()?.armed, true);
});

test('arming with always mode is refused because forced profiles are paper-only', async () => {
  const store = freshStore();
  const config = {
    ...liveConfig,
    picks: {
      ...liveConfig.picks,
      kalshi: {
        ...liveConfig.picks.kalshi,
        trading: { ownerId: 'mod', dailyLimitDollars: 20, keyId: 'k', privateKeyPem: 'p', profile: 'always' },
      },
    },
  };

  const interaction = fakeInteraction('live', { action: 'arm' });
  await handlePicks(interaction, { store, config });

  assert.notEqual(store.riskState()?.armed, true);
  const reply = interaction.replies.at(-1);
  // discord.js rejects anything that is not a real string with "Cannot send
  // an empty message" — a JS array happens to stringify into something
  // String() and a regex will still match, which is exactly how a broken
  // .filter(...) missing its .join('\n') slipped through here once already.
  assert.equal(typeof reply, 'string');
  assert.match(reply, /Live trading refused/);
  assert.match(reply, /paper-only/);
});

test('arming with the default profile carries none of the always-mode warning', async () => {
  const store = freshStore();
  const config = {
    ...liveConfig,
    picks: {
      ...liveConfig.picks,
      kalshi: {
        ...liveConfig.picks.kalshi,
        trading: { ownerId: 'mod', dailyLimitDollars: 20, keyId: 'k', privateKeyPem: 'p' },
      },
    },
  };

  const interaction = fakeInteraction('live', { action: 'arm' });
  await handlePicks(interaction, { store, config });

  const reply = interaction.replies.at(-1);
  assert.equal(typeof reply, 'string');
  assert.match(reply, /Profile: \*\*careful\*\*/);
  assert.doesNotMatch(reply, /every window with no edge required/);
});

test('only the owner may touch the rails, not merely a mod', async () => {
  // A mod is trusted with the room. This is trusted with a bank account, and
  // those are different trusts.
  const store = freshStore();
  const config = {
    ...liveConfig,
    picks: {
      ...liveConfig.picks,
      kalshi: { ...liveConfig.picks.kalshi, trading: { ownerId: 'somebody-else' } },
    },
  };

  const interaction = fakeInteraction('live', { action: 'arm' });
  await handlePicks(interaction, { store, config });

  assert.match(String(interaction.replies.at(-1)), /somebody else’s money/);
  assert.equal(store.riskState(), null);
});

test('kill disarms and does not clear itself', async () => {
  const store = freshStore();
  store.putRiskState({ ...newRiskState(), armed: true });

  await handlePicks(fakeInteraction('live', { action: 'kill' }), { store, config: liveConfig });
  assert.equal(store.riskState().armed, false);
  assert.equal(store.riskState().killed, true);

  // Resume clears the kill but does NOT re-arm: arming is a separate act.
  await handlePicks(fakeInteraction('live', { action: 'resume' }), { store, config: liveConfig });
  assert.equal(store.riskState().killed, false);
  assert.equal(store.riskState().armed, false);
});

test('disarm leaves an open position alone rather than dumping it', async () => {
  const store = freshStore();
  store.putRiskState({
    ...newRiskState(),
    armed: true,
    position: { ticker: 'T', side: 'up', entryCents: 44, contracts: 10 },
  });

  await handlePicks(fakeInteraction('live', { action: 'disarm' }), { store, config: liveConfig });
  assert.equal(store.riskState().armed, false);
  assert.ok(store.riskState().position, 'the open position survived');
});

test('the daily limit can be changed and is reported back', async () => {
  const store = freshStore();
  const interaction = fakeInteraction('live', { limit: 8 });
  await handlePicks(interaction, { store, config: liveConfig });
  assert.match(String(interaction.replies.at(-1)), /\$8\.00/);
});

test('the status names today’s spending, read from the order ledger', async () => {
  const store = freshStore();
  store.putRiskState({ ...newRiskState(), armed: true });
  store.appendTradeOrder({
    at: Date.now(),
    ticker: 'T',
    costDollars: 6,
    profitDollars: -2,
    status: 'filled',
    clientOrderId: 'c1',
  });

  const interaction = fakeInteraction('live', {});
  await handlePicks(interaction, { store, config: liveConfig });

  const reply = String(interaction.replies.at(-1));
  assert.match(reply, /\*\*\$6\.00\*\* spent/);
  assert.match(reply, /\*\*\$14\.00\*\* left/);
});

test('status names the active trading profile — "armed but nothing traded" is unanswerable without it', async () => {
  const store = freshStore();
  store.putRiskState({ ...newRiskState(), armed: true });
  const config = {
    ...liveConfig,
    picks: {
      ...liveConfig.picks,
      kalshi: { ...liveConfig.picks.kalshi, trading: { ...liveConfig.picks.kalshi.trading, profile: 'always' } },
    },
  };

  const interaction = fakeInteraction('live', {});
  await handlePicks(interaction, { store, config });

  const reply = interaction.replies.at(-1);
  assert.equal(typeof reply, 'string');
  assert.match(reply, /Profile: \*\*always\*\*/);
  assert.match(reply, /forces every window/);
});

test('status defaults to careful and says so, when no profile is configured at all', async () => {
  const store = freshStore();
  store.putRiskState({ ...newRiskState(), armed: true });

  const interaction = fakeInteraction('live', {});
  await handlePicks(interaction, { store, config: liveConfig });

  const reply = interaction.replies.at(-1);
  assert.equal(typeof reply, 'string');
  assert.match(reply, /Profile: \*\*careful\*\*/);
});

test('status flags a misspelled profile instead of silently trading as careful', async () => {
  const store = freshStore();
  store.putRiskState({ ...newRiskState(), armed: true });
  const config = {
    ...liveConfig,
    picks: {
      ...liveConfig.picks,
      kalshi: { ...liveConfig.picks.kalshi, trading: { ...liveConfig.picks.kalshi.trading, profile: 'allways' } },
    },
  };

  const interaction = fakeInteraction('live', {});
  await handlePicks(interaction, { store, config });

  const reply = interaction.replies.at(-1);
  assert.match(reply, /does not exist — running as careful instead/);
});
