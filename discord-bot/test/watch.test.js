import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addWatch,
  cashOutMessage,
  checkWatch,
  makeWatch,
  pruneWatches,
  removeWatches,
  sweepWatches,
} from '../src/picks/watch.js';

// The bot holds the exit. Entering is a decision made calmly; leaving is made
// in ninety seconds while the number moves, and that is the half worth
// automating.

const history = () => {
  const prices = [];
  let price = 65_000;
  let state = 4242;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    prices.push(price);
  }
  return prices;
};

const input = (over = {}) => ({
  prices: history(),
  spot: 65_050,
  strike: 65_000,
  marketPriceCents: 55,
  market: { yes_bid_dollars: '0.54', yes_ask_dollars: '0.56', liquidity_dollars: '1000' },
  secondsLeft: 400,
  ...over,
});

test('a watch has to describe a real position', () => {
  assert.equal(makeWatch({ userId: '', ticker: 'T', side: 'up', entryCents: 30 }), null);
  assert.equal(makeWatch({ userId: 'u', ticker: 'T', side: 'sideways', entryCents: 30 }), null);
  assert.equal(makeWatch({ userId: 'u', ticker: 'T', side: 'up', entryCents: 0 }), null);
  assert.equal(makeWatch({ userId: 'u', ticker: 'T', side: 'up', entryCents: 100 }), null);
  assert.ok(makeWatch({ userId: 'u', ticker: 'T', side: 'up', entryCents: 34 }));
});

test('registering the same market twice updates rather than stacks', () => {
  let watches = addWatch([], makeWatch({ userId: 'u', ticker: 'T', side: 'up', entryCents: 34 }));
  watches = addWatch(watches, makeWatch({ userId: 'u', ticker: 'T', side: 'down', entryCents: 60 }));

  assert.equal(watches.length, 1);
  assert.equal(watches[0].side, 'down');
  assert.equal(watches[0].entryCents, 60);
});

test('one person leaving does not cancel anyone else', () => {
  const watches = [
    makeWatch({ userId: 'a', ticker: 'T', side: 'up', entryCents: 30 }),
    makeWatch({ userId: 'b', ticker: 'T', side: 'up', entryCents: 30 }),
  ];
  const left = removeWatches(watches, 'a');
  assert.equal(left.length, 1);
  assert.equal(left[0].userId, 'b');
});

test('already-alerted and long-dead watches are dropped', () => {
  const now = Date.now();
  const watches = [
    { userId: 'a', ticker: 'T', side: 'up', entryCents: 30, at: now, alerted: false },
    { userId: 'b', ticker: 'T', side: 'up', entryCents: 30, at: now, alerted: true },
    { userId: 'c', ticker: 'T', side: 'up', entryCents: 30, at: now - 5 * 3600_000, alerted: false },
  ];
  const kept = pruneWatches(watches, { now });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].userId, 'a');
});

test('a DOWN position is valued on the NO bid, not the YES price', () => {
  // The mistake this codebase has already made twice. A down position is sold
  // at the NO bid — a hundred minus the YES ask — and measuring it against the
  // yes price misreads every exit.
  const result = checkWatch(
    { userId: 'u', ticker: 'T', side: 'down', entryCents: 40 },
    input({ secondsLeft: 30 }),
  );

  // 30 seconds left with a losing read is a bell exit; whatever it decides,
  // the price it decided on must be the NO side's.
  if (result.nowCents !== undefined) {
    assert.ok(result.nowCents > 40 && result.nowCents < 50, `NO bid should be ~44, got ${result.nowCents}`);
  }
});

test('the message leads with CASH OUT and states the net, not the gross', () => {
  const message = cashOutMessage({
    watch: { side: 'up', entryCents: 34 },
    nowCents: 50,
    reason: 'move banked',
    trip: { percent: 38.2, netCents: 13 },
  });

  assert.match(message.split('\n')[0], /CASH OUT/);
  assert.match(message, /34%/);
  assert.match(message, /50%/);
  assert.match(message, /net of both fees/);
  // And it says out loud that it went to nobody else.
  assert.match(message, /only to you/i);
});

test('a losing exit says so plainly rather than hiding it', () => {
  const message = cashOutMessage({
    watch: { side: 'down', entryCents: 60 },
    nowCents: 45,
    reason: 'cut',
    trip: { percent: -27.4, netCents: -16 },
  });

  assert.match(message, /❌/);
  assert.match(message, /-27\.4%/);
  assert.match(message, /bleeding/);
});

test('the DM goes to the one person, and fires exactly once', async () => {
  const sent = [];
  const watch = makeWatch({ userId: 'me', ticker: 'T1', side: 'up', entryCents: 34 });
  let watches = [watch];

  const store = {
    listWatches: () => watches,
    putWatches: (next) => {
      watches = next;
      return next;
    },
    listSamples: () => history().map((price, i) => ({ at: Date.now() - (120 - i) * 30_000, price })),
  };

  const client = {
    users: {
      fetch: async (id) => ({ id, send: async (content) => sent.push({ id, content }) }),
    },
  };

  const deps = {
    // A market well past the bell, so the exit is unambiguous.
    currentContract: async () => ({
      price: 20,
      market: {
        ticker: 'T1',
        floor_strike: 65_000,
        yes_bid_dollars: '0.19',
        yes_ask_dollars: '0.21',
        liquidity_dollars: '1000',
        close_time: new Date(Date.now() + 20_000).toISOString(),
      },
    }),
    fetchSpotPrice: async () => ({ price: 64_500 }),
  };

  const config = { picks: { defaultAsset: 'BTC', kalshi: { enabled: true, seriesTicker: 'K' } } };

  const first = await sweepWatches(client, store, config, deps);
  assert.equal(first.alerted, 1, 'the alert must fire');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'me', 'to that person and nobody else');
  // Either "get out now" or "hold, it settles by itself" — both are answers,
  // and silence is not.
  assert.match(sent[0].content, /CASH OUT|HOLD/);

  // Second sweep: the position is gone and nothing is sent again. Telling
  // somebody to sell what they already sold is worse than saying nothing.
  const second = await sweepWatches(client, store, config, deps);
  assert.equal(second.alerted, 0);
  assert.equal(sent.length, 1);
});

test('one person with closed DMs does not cost anyone else their alert', async () => {
  const sent = [];
  let watches = [
    makeWatch({ userId: 'blocked', ticker: 'T1', side: 'up', entryCents: 34 }),
    makeWatch({ userId: 'fine', ticker: 'T1', side: 'up', entryCents: 34 }),
  ];

  const store = {
    listWatches: () => watches,
    putWatches: (next) => {
      watches = next;
      return next;
    },
    listSamples: () => history().map((price, i) => ({ at: Date.now() - (120 - i) * 30_000, price })),
  };

  const client = {
    users: {
      fetch: async (id) => ({
        id,
        send: async (content) => {
          if (id === 'blocked') throw new Error('Cannot send messages to this user');
          sent.push({ id, content });
        },
      }),
    },
  };

  const result = await sweepWatches(
    client,
    store,
    { picks: { defaultAsset: 'BTC', kalshi: { enabled: true } } },
    {
      currentContract: async () => ({
        price: 20,
        market: {
          ticker: 'T1',
          floor_strike: 65_000,
          yes_bid_dollars: '0.19',
          yes_ask_dollars: '0.21',
          liquidity_dollars: '1000',
          close_time: new Date(Date.now() + 20_000).toISOString(),
        },
      }),
      fetchSpotPrice: async () => ({ price: 64_500 }),
    },
  );

  assert.equal(result.alerted, 2, 'both are resolved');
  assert.equal(sent.length, 1, 'and the reachable one still got theirs');
  assert.equal(sent[0].id, 'fine');
});

test('a market that returns nonsense never stops the sweep', async () => {
  let watches = [makeWatch({ userId: 'me', ticker: 'T1', side: 'up', entryCents: 34 })];
  const store = {
    listWatches: () => watches,
    putWatches: (next) => {
      watches = next;
      return next;
    },
    listSamples: () => [],
  };

  const result = await sweepWatches(
    { users: { fetch: async () => null } },
    store,
    { picks: {} },
    {
      currentContract: async () => {
        throw new Error('exchange on fire');
      },
      fetchSpotPrice: async () => ({ price: 65_000 }),
    },
  );

  assert.equal(result.alerted, 0);
});

test('"do nothing" is sent too, because impatience is what costs the fee', () => {
  // When the model still likes the side near the bell, the right move is to
  // let it expire — settlement is free and selling is not. Somebody watching
  // the number move needs to be TOLD that, or they sell out of nerves.
  const message = cashOutMessage({
    watch: { side: 'up', entryCents: 34 },
    nowCents: 71,
    action: 'settle',
    reason: 'settling',
  });

  assert.match(message, /HOLD/);
  assert.match(message, /Do NOT sell/);
  assert.match(message, /settles by itself/);
});

test('a position deep underwater warns without closing, and warns only once', () => {
  const message = cashOutMessage({
    watch: { side: 'up', entryCents: 28 },
    nowCents: 15,
    action: 'warn',
    trip: { percent: -52.4, netCents: -14 },
  });

  assert.match(message, /DOWN 52%/);
  assert.match(message, /NOT telling you to sell/);
  // And it says the uncomfortable half out loud.
  assert.match(message, /exactly what a wrong model says/);
  assert.match(message, /Your call/);
  // The position is still live, so the exit alert is still coming.
  assert.match(message, /still get the CASH OUT/);
});

/**
 * The paper sweep, and the reset that would not stick.
 *
 * The reported bug was "/picks paper reset doesn't work". It did work — and
 * then the background sweep, which had read the account BEFORE the reset and
 * only wrote it back after its network calls returned, put the old one back.
 * The account reset and then silently came back, which is indistinguishable
 * from a reset that never happened.
 */

import { sweepPaper } from '../src/picks/watch.js';
import { newAccount } from '../src/picks/paper.js';

const ladderMarkets = (cents = [70, 60, 50, 40, 30], strikes = [64_600, 64_800, 65_000, 65_200, 65_400]) =>
  cents.map((price, i) => ({
    price,
    market: {
      ticker: `KXBTC-${strikes[i]}`,
      floor_strike: strikes[i],
      status: 'active',
      close_time: new Date(Date.now() + 400_000).toISOString(),
      yes_bid_dollars: String((price - 1) / 100),
      yes_ask_dollars: String((price + 1) / 100),
      liquidity_dollars: '4000',
    },
  }));

function paperStore(account) {
  let stored = account;
  return {
    paperAccount: () => stored,
    putPaperAccount: (next) => {
      stored = next;
      return next;
    },
    listSamples: () => history().map((price, i) => ({ at: Date.now() - (120 - i) * 30_000, price })),
    get current() {
      return stored;
    },
    set current(next) {
      stored = next;
    },
  };
}

const paperConfig = {
  picks: { defaultAsset: 'BTC', kalshi: { enabled: true, seriesTicker: 'KXBTC' } },
};

const noClient = { users: { fetch: async () => null } };

test('the paper sweep looks at the whole ladder, not one strike', async () => {
  const store = paperStore({ ...newAccount(), userId: 'u1' });
  const result = await sweepPaper(noClient, store, paperConfig, {
    openBoard: async () => ({ contracts: ladderMarkets() }),
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });

  assert.equal(result.ran, true);
  assert.equal(result.looked, 5);
  // Seen counts contracts that have EXPIRED, not sweeps: after one sweep the
  // whole ladder is still live, so nothing has finished yet. Counting per sweep
  // is what turned six hours into "2100 markets".
  assert.equal(store.current.seen, 0);
  assert.equal(store.current.looks, 1);
  assert.equal(Object.keys(store.current.window).length, 5);
});

test('a reset landing mid-sweep is NOT overwritten by the stale copy', async () => {
  // This is the whole bug. The sweep reads, then awaits the network, then
  // writes. A reset inside that gap used to be undone by the write.
  const store = paperStore({ ...newAccount({ at: 1000 }), userId: 'u1', cash: 12.5, seen: 400 });

  const result = await sweepPaper(noClient, store, paperConfig, {
    openBoard: async () => {
      // The user runs /picks paper reset:True while the request is in flight.
      store.current = { ...newAccount({ at: 2000 }), userId: 'u1' };
      return { contracts: ladderMarkets() };
    },
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });

  assert.equal(result.ran, false);
  // The reset survived: fresh bankroll, nothing seen, no trades.
  assert.equal(store.current.cash, 70);
  assert.equal(store.current.seen, 0);
  assert.equal(store.current.epoch, 2000);
});

test('with no account registered the sweep does nothing at all', async () => {
  const store = paperStore(null);
  const result = await sweepPaper(noClient, store, paperConfig, {
    openBoard: async () => ({ contracts: ladderMarkets() }),
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });
  assert.equal(result.ran, false);
});

test('an empty board is not treated as a market worth refusing', async () => {
  // Counting a feed outage as "refused 12 markets" would poison the census
  // that the report now leans on to say whether the engine is working.
  const store = paperStore({ ...newAccount(), userId: 'u1' });
  const result = await sweepPaper(noClient, store, paperConfig, {
    openBoard: async () => ({ contracts: [], error: 'HTTP 503' }),
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });

  assert.equal(result.ran, false);
  assert.equal(store.current.seen, 0);
});

test('a feed that throws does not take down the sweep', async () => {
  const store = paperStore({ ...newAccount(), userId: 'u1' });
  const result = await sweepPaper(noClient, store, paperConfig, {
    openBoard: async () => {
      throw new Error('socket hang up');
    },
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });
  assert.equal(result.ran, false);
});
