import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_BANKROLL,
  contractsFor,
  equity,
  newAccount,
  paperTick,
  report,
  reportDue,
} from '../src/picks/paper.js';

// The engine trading the real market with imaginary money. The rules that make
// the answer worth having are all about not flattering itself.

const history = () => {
  const prices = [];
  let price = 65_000;
  let state = 8_675_309;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    prices.push(price);
  }
  return prices;
};

const market = (over = {}) => ({
  prices: history(),
  spot: 64_500,
  strike: 65_000,
  marketPriceCents: 50,
  market: { yes_bid_dollars: '0.49', yes_ask_dollars: '0.51', liquidity_dollars: '900' },
  secondsLeft: 500,
  ...over,
});

test('it starts with what it was given', () => {
  const account = newAccount();
  assert.equal(account.cash, START_BANKROLL);
  assert.equal(account.start, 70);
  assert.equal(account.position, null);
});

test('buying pays the ASK, never the mid', () => {
  // A paper account that fills at the mid beats a real one by half a spread on
  // every single trade, and nobody notices until the money is real.
  const { account, event } = paperTick(newAccount(), market());
  if (!event) return; // the engine may decline this market, which is its right

  assert.equal(event.kind, 'enter');
  // The book is 49/51. A DOWN buy pays the NO ask, which is 100 − 49 = 51.
  assert.ok(
    account.position.entryCents === 51 || account.position.entryCents === 51,
    `filled at ${account.position.entryCents}, which is not an ask`,
  );
  // And the cash actually left the account, fee included.
  assert.ok(account.cash < 70);
  assert.ok(account.position.cost > account.position.contracts * 0.51);
});

test('it can never spend money it does not have', () => {
  const broke = { ...newAccount({ bankroll: 0.4 }), cash: 0.4 };
  const { account } = paperTick(broke, market());
  assert.equal(account.position, null, 'opened a position it could not pay for');
  assert.ok(account.cash >= 0);
});

test('contracts are whole, and rounded down', () => {
  assert.equal(contractsFor(1, 51), 1);
  assert.equal(contractsFor(1.5, 51), 2);
  assert.equal(contractsFor(0.4, 51), 0);
  assert.equal(contractsFor(10, 25), 40);
});

test('a settled winner pays a dollar a contract and no exit fee', () => {
  // Settlement is the one exit the exchange does not charge for.
  const held = {
    ...newAccount(),
    cash: 60,
    position: {
      ticker: 'T1', side: 'down', entryCents: 51, contracts: 10, cost: 5.3, openedAt: 0,
    },
  };

  // Down wins: the index finished at or below the strike.
  const { account, event } = paperTick(held, market({ secondsLeft: 0, spot: 64_000 }));

  assert.equal(event.kind, 'settled');
  assert.equal(event.trade.proceeds, 10, 'ten contracts at a dollar, no fee taken');
  assert.equal(account.position, null);
  assert.equal(account.cash, 70);
  assert.ok(account.trades[0].profit > 0);
});

test('a settled loser pays nothing at all', () => {
  const held = {
    ...newAccount(),
    cash: 60,
    position: { ticker: 'T1', side: 'down', entryCents: 51, contracts: 10, cost: 5.3, openedAt: 0 },
  };

  const { account, event } = paperTick(held, market({ secondsLeft: 0, spot: 66_000 }));

  assert.equal(event.trade.proceeds, 0);
  assert.equal(account.cash, 60);
  assert.ok(account.trades[0].profit < 0);
});

test('refusals are counted, because most markets are refusals', () => {
  // A report saying "0 trades, refused 41 markets" is the engine working. It
  // has to be able to say that rather than looking broken.
  let account = newAccount();
  for (let i = 0; i < 5; i += 1) {
    // A fairly priced market: nothing to win.
    account = paperTick(account, market({ spot: 65_000, marketPriceCents: 50 })).account;
  }
  assert.equal(account.seen, 5);
  assert.ok(account.refused > 0);
});

test('the report leads with the money and never hides the fees', () => {
  const account = {
    ...newAccount(),
    cash: 78.4,
    seen: 120,
    refused: 112,
    trades: [
      { side: 'up', entryCents: 40, exitCents: 60, contracts: 10, cost: 4.2, proceeds: 5.8, profit: 1.6 },
      { side: 'down', entryCents: 55, exitCents: 30, contracts: 8, cost: 4.6, proceeds: 2.4, profit: -2.2 },
    ],
  };

  const text = report(account);
  assert.match(text.split('\n')[0], /PAPER — \$78\.40/);
  assert.match(text, /started \$70\.00/);
  assert.match(text, /1W 1L/);
  assert.match(text, /went to the exchange in fees/);
  // The limitation is stated every time, not buried in a doc.
  assert.match(text, /whether that price was there in size/);
});

test('a run with no trades reads as working, not as broken', () => {
  const text = report({ ...newAccount(), seen: 41, refused: 41 });
  assert.match(text, /No trades/);
  assert.match(text, /refused \*\*41\*\*/);
  assert.match(text, /Refusing is the normal state/);
});

test('an open position is marked at what it could be sold for', () => {
  const account = {
    ...newAccount(),
    cash: 60,
    position: { side: 'up', entryCents: 50, contracts: 20, cost: 10.4, openedAt: 0 },
  };
  // Twenty contracts marked at 70 is $14 on top of the cash.
  assert.ok(Math.abs(equity(account, 70) - 74) < 1e-9);
  // With no mark available, only the cash counts — never the cost.
  assert.equal(equity(account), 60);
});

test('the report fires every six hours and not before', () => {
  const now = Date.now();
  assert.equal(reportDue({ lastReportAt: now - 5 * 3_600_000 }, { now }), false);
  assert.equal(reportDue({ lastReportAt: now - 6 * 3_600_000 }, { now }), true);
});

/**
 * Reading a ladder of strikes instead of one contract.
 *
 * "It skips every single market" was a true report with the wrong diagnosis
 * attached. The thresholds were not too strict — the bot was being shown one
 * strike out of the dozen Kalshi lists for the same window, and refusing that
 * one is not evidence about the other eleven.
 */

const ladder = (cents = [70, 60, 50, 40, 30], strikes = [64_600, 64_800, 65_000, 65_200, 65_400]) =>
  cents.map((price, i) => ({
    price,
    market: {
      ticker: `KXBTC-${strikes[i]}`,
      floor_strike: strikes[i],
      status: 'active',
      close_time: '2026-01-01T00:15:00Z',
      yes_bid_dollars: String((price - 1) / 100),
      yes_ask_dollars: String((price + 1) / 100),
      liquidity_dollars: '4000',
    },
  }));

const context = (over = {}) => ({
  prices: history(),
  spot: 65_000,
  secondsLeft: 500,
  ...over,
});

test('the whole ladder counts towards what it looked at, not one strike', () => {
  const candidates = ladder();
  const { account } = paperTick(newAccount(), context(), { candidates });
  assert.equal(account.seen, candidates.length);
});

test('refusals are broken down by reason, so a dead feed is not read as a fair market', () => {
  let account = newAccount();
  for (let i = 0; i < 3; i += 1) {
    account = paperTick(account, context(), { candidates: ladder() }).account;
  }

  const total = Object.values(account.census).reduce((sum, n) => sum + n, 0);
  assert.equal(total, account.refused);
  assert.ok(account.refused > 0);
});

test('a position remembers its OWN strike and settles against that one', () => {
  // The ladder makes this fatal rather than merely wrong: "whatever strike the
  // feed lists now" is a different contract on almost every tick, so settling
  // against it grades the trade on a bet that was never placed.
  const held = {
    ...newAccount(),
    cash: 40,
    position: {
      ticker: 'KXBTC-64600',
      strike: 64_600,
      side: 'up',
      entryCents: 50,
      contracts: 60,
      cost: 30,
      openedAt: 0,
    },
  };

  // Out of time. Spot finished at 64,800: above the position's own strike of
  // 64,600, and below the 65,000 strike the feed happens to lead with.
  const { account, event } = paperTick(held, context({ secondsLeft: 0, spot: 64_800 }), {
    candidates: ladder(),
  });

  assert.equal(event.kind, 'settled');
  assert.equal(event.trade.exitCents, 100);
  assert.ok(account.cash > 40);
});

test('a position whose contract has left the board settles rather than hanging', () => {
  // The window rolled. The old ticker is gone, and a position that quietly
  // stayed open across the roll would be marked against the next window's
  // prices for the rest of the run.
  const held = {
    ...newAccount(),
    cash: 40,
    position: {
      ticker: 'KXBTC-GONE',
      strike: 64_600,
      side: 'down',
      entryCents: 50,
      contracts: 60,
      cost: 30,
      openedAt: 0,
    },
  };

  const { event } = paperTick(held, context({ spot: 64_800, secondsLeft: 400 }), {
    candidates: ladder(),
  });

  assert.equal(event.kind, 'settled');
  // Spot 64,800 finished ABOVE the 64,600 strike, so the DOWN side lost.
  assert.equal(event.trade.exitCents, 0);
});

test('an entry records the ticker and strike of the contract it actually bought', () => {
  const candidates = ladder([88, 70, 50, 30, 12]);
  const { account, event } = paperTick(newAccount(), context(), { candidates });
  if (!event) return; // refusing the whole ladder is a legitimate outcome

  assert.equal(event.kind, 'enter');
  assert.ok(account.position.ticker.startsWith('KXBTC-'));
  assert.ok(account.position.strike > 0);
  // The strike stored is the one belonging to the ticker stored.
  const bought = candidates.find((c) => c.market.ticker === account.position.ticker);
  assert.equal(Number(bought.market.floor_strike), account.position.strike);
});

test('a fresh account carries an epoch, so a reset can be told from a no-op', () => {
  const first = newAccount({ at: 1000 });
  const second = newAccount({ at: 2000 });
  assert.notEqual(first.epoch, second.epoch);
  assert.equal(first.census && typeof first.census, 'object');
});

test('the report says WHY it refused, not only how many', () => {
  const account = {
    ...newAccount(),
    seen: 60,
    refused: 60,
    census: { no_edge: 48, thin_book: 9, trending: 3 },
  };
  const text = report(account, { now: account.startedAt + 6 * 3_600_000 });

  assert.match(text, /48× no edge/);
  assert.match(text, /thin book/);
  // And it still leads with the money.
  assert.match(text.split('\n')[0], /\$70\.00/);
});

test('the report names the strike being held, since a dozen share the asset', () => {
  const account = {
    ...newAccount(),
    cash: 40,
    position: { ticker: 'KXBTC-64600', strike: 64_600, side: 'up', entryCents: 50, contracts: 60 },
  };
  const text = report(account, { markCents: 55 });
  assert.match(text, /64,600/);
});
