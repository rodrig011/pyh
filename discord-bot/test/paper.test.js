import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILES,
  START_BANKROLL,
  auditSettledTrades,
  compareReport,
  contractsFor,
  equity,
  newAccount,
  paperTick,
  report,
  reportDue,
} from '../src/picks/paper.js';
import { evaluate } from '../src/signals/engine.js';

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

const official = (ticker, result) => ({
  [ticker]: {
    ticker,
    result,
    settlementValueCents: result === 'yes' ? 100 : 0,
  },
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

  const { account, event } = paperTick(held, market({ secondsLeft: 0, spot: 66_000 }), {
    officialSettlements: official('T1', 'no'),
  });

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

  const { account, event } = paperTick(held, market({ secondsLeft: 0, spot: 64_000 }), {
    officialSettlements: official('T1', 'yes'),
  });

  assert.equal(event.trade.proceeds, 0);
  assert.equal(account.cash, 60);
  assert.ok(account.trades[0].profit < 0);
});

test('official Kalshi result wins over a contradictory local BRTI window', () => {
  const closesAt = 120_000;
  const held = {
    ...newAccount(),
    cash: 60,
    position: {
      ticker: 'T1', strike: 65_000, side: 'up', entryCents: 51,
      contracts: 10, cost: 5.3, entryFee: 0.2, openedAt: 1_000, closesAt,
    },
  };
  const { event } = paperTick(held, market({
    secondsLeft: 0,
    spot: 60_000,
    spotSource: 'kalshi-brti',
    spotSamples: [
      { at: 70_000, price: 65_100, source: 'kalshi-brti' },
      { at: 100_000, price: 99_999, source: 'coinbase' },
      { at: 110_000, price: 65_300, source: 'kalshi-brti' },
    ],
  }), {
    now: 130_000,
    officialSettlements: official('T1', 'no'),
  });
  assert.equal(event.trade.settlementPrice, null);
  assert.equal(event.trade.settlementSource, 'kalshi-market:official-result');
  assert.equal(event.trade.settlementResult, 'no');
  assert.equal(event.trade.exitCents, 0, 'local prices cannot overrule the exact ticker result');
  assert.equal(event.trade.fees, 0.2);
  assert.equal(event.trade.durationMs, 129_000, 'duration is recorded');
});

test('an expired position waits rather than inventing a settlement result', () => {
  const held = {
    ...newAccount(),
    cash: 60,
    position: { ticker: 'T1', strike: 65_000, side: 'up', entryCents: 51, contracts: 10, cost: 5.3, openedAt: 0 },
  };
  const { account, event } = paperTick(held, market({ secondsLeft: 0, spot: 70_000 }));
  assert.equal(event.kind, 'awaiting_settlement');
  assert.equal(account.position.ticker, 'T1');
  assert.equal(account.cash, 60);
  assert.equal(account.trades.length, 0);
});

test('legacy false wins are re-audited and removed from bankroll and W/L', () => {
  const legacy = {
    ...newAccount({ bankroll: 100 }),
    cash: 107,
    trades: [{
      ticker: 'T1', side: 'up', reason: 'settled', contracts: 10,
      cost: 7, proceeds: 10, profit: 3, exitCents: 100,
      settlementSource: 'kalshi-brti:final-60s-average',
    }],
    tradeStats: { total: 1, wins: 1, losses: 0, breakEven: 0, netProfit: 3 },
  };
  const { account, corrections, cashAdjustment } = auditSettledTrades(
    legacy,
    official('T1', 'no'),
    { now: 1234 },
  );
  assert.equal(corrections, 1);
  assert.equal(cashAdjustment, -10);
  assert.equal(account.cash, 97);
  assert.equal(account.trades[0].profit, -7);
  assert.equal(account.trades[0].exitCents, 0);
  assert.equal(account.tradeStats.wins, 0);
  assert.equal(account.tradeStats.losses, 1);
  assert.equal(account.tradeStats.netProfit, -7);
});

test('a contract is counted once, when it expires — not once per sweep', () => {
  // The bug this pins, reported from six hours of live running: "it says 2100
  // markets, that's impossible". It was. The sweep fires every ten seconds, so
  // six hours is 2,160 ticks — and the counter added one per TICK, turning a
  // couple of dozen fifteen-minute contracts into two thousand "markets". It
  // also made a working reset look broken, because the number climbed back into
  // the hundreds within minutes of being zeroed.
  let account = newAccount();

  // The same market, seen over and over. That is one contract, not many.
  for (let i = 0; i < 200; i += 1) {
    account = paperTick(account, market({ spot: 65_000, marketPriceCents: 50 })).account;
  }
  assert.equal(account.seen, 0, 'still in view, so nothing has finished yet');
  assert.equal(account.looks, 200);

  // The window rolls: a different strike is listed, so the old one expired.
  account = paperTick(account, market({ spot: 65_000, strike: 66_000, marketPriceCents: 50 })).account;
  assert.equal(account.seen, 1, '200 sweeps of one contract is one contract');
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

test('the whole ladder counts once each, as its contracts expire', () => {
  const first = ladder();
  let account = newAccount();

  // Many sweeps of the same five strikes.
  for (let i = 0; i < 50; i += 1) {
    account = paperTick(account, context(), { candidates: first }).account;
  }
  assert.equal(account.seen, 0);
  assert.equal(account.looks, 50);

  // The window rolls to a completely different ladder.
  const next = ladder([70, 60, 50, 40, 30], [66_000, 66_200, 66_400, 66_600, 66_800]);
  account = paperTick(account, context(), { candidates: next }).account;
  assert.equal(account.seen, 5, 'five contracts expired, whatever the sweep count');
});

test('refusals are broken down by reason once the contracts expire', () => {
  let account = newAccount();
  account = paperTick(account, context(), { candidates: ladder() }).account;
  account = paperTick(account, context(), {
    candidates: ladder([70, 60, 50, 40, 30], [66_000, 66_200, 66_400, 66_600, 66_800]),
  }).account;

  const total = Object.values(account.census).reduce((sum, n) => sum + n, 0);
  assert.equal(total, account.refused);
});

test('a contract that was EVER tradeable is not booked as a refusal', () => {
  // It is refused close to the bell, and near an extreme price, and that is
  // normal. Counting the last word rather than the best one would report a
  // market it genuinely called as one it turned down.
  let account = newAccount();
  const good = ladder([50], [65_000]);

  account = paperTick(account, context(), { candidates: good }).account;
  const everTradeable = account.window['KXBTC-65000'] === null;

  // Now it goes untradeable — out of time.
  account = paperTick(account, context({ secondsLeft: 10 }), { candidates: good }).account;
  // And rolls off.
  account = paperTick(account, context(), { candidates: ladder([50], [66_000]) }).account;

  assert.equal(account.seen, 1);
  if (everTradeable) assert.equal(account.refused, 0);
});

test('a real refusal reason is not overwritten by too_late in the contract\'s last seconds', () => {
  // Priced out (>92c) the whole way through — refused for a real reason for
  // the bulk of its life, with plenty of time on the clock.
  const overpriced = ladder([95], [65_000]);
  let account = newAccount();
  account = paperTick(account, context({ secondsLeft: 500 }), { candidates: overpriced }).account;
  account = paperTick(account, context({ secondsLeft: 200 }), { candidates: overpriced }).account;
  // The last look before it rolls off happens to land inside the too-late
  // window — which used to overwrite the real reason with a trivial one.
  account = paperTick(account, context({ secondsLeft: 10 }), { candidates: overpriced }).account;
  // Rolls off.
  account = paperTick(account, context(), { candidates: ladder([50], [66_000]) }).account;

  assert.equal(account.seen, 1);
  assert.equal(account.refused, 1);
  assert.deepEqual(account.census, { priced_out: 1 });
  assert.equal(account.census.too_late, undefined);
});

test('a contract that truly is only ever seen too late is still recorded as too_late', () => {
  const lastSecond = ladder([50], [65_000]);
  let account = newAccount();
  account = paperTick(account, context({ secondsLeft: 10 }), { candidates: lastSecond }).account;
  account = paperTick(account, context(), { candidates: ladder([50], [66_000]) }).account;

  assert.equal(account.seen, 1);
  assert.deepEqual(account.census, { too_late: 1 });
});

test('a position settles from its OWN exact ticker result', () => {
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
    officialSettlements: official('KXBTC-64600', 'yes'),
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
    officialSettlements: official('KXBTC-GONE', 'yes'),
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

/**
 * Two runs, one tape.
 *
 * The comparison IS the answer, so it arrives as one message. Two reports
 * landing together make a person do the subtraction themselves, and the
 * subtraction is the only part that matters.
 */

test('the comparison shows both runs, best first', () => {
  const accounts = {
    careful: { ...newAccount({ profile: 'careful' }), cash: 72, seen: 40, refused: 38 },
    scalp: { ...newAccount({ profile: 'scalp' }), cash: 66, seen: 40, refused: 20 },
  };
  const text = compareReport(accounts, { now: Date.now() + 6 * 3_600_000 });

  assert.match(text, /CAREFUL/);
  assert.match(text, /SCALP/);
  // Best first: the answer is the first thing read.
  assert.ok(text.indexOf('CAREFUL') < text.indexOf('SCALP'));
  assert.match(text, /careful is ahead by/);
});

test('the comparison never lets a small sample read as a verdict', () => {
  // A handful of 15-minute binaries is a coin-flip sequence, and the gap
  // between two of them after a day says almost nothing.
  const accounts = {
    careful: { ...newAccount({ profile: 'careful' }), cash: 90 },
    scalp: { ...newAccount({ profile: 'scalp' }), cash: 50 },
  };
  assert.match(compareReport(accounts), /Far too few trades/);
});

test('a dead heat is called a dead heat, not a winner', () => {
  const accounts = {
    careful: { ...newAccount({ profile: 'careful' }), cash: 70 },
    scalp: { ...newAccount({ profile: 'scalp' }), cash: 70 },
  };
  assert.match(compareReport(accounts), /Dead level/);
});

test('one run alone falls back to the ordinary report', () => {
  const accounts = { scalp: { ...newAccount({ profile: 'scalp' }), cash: 70 } };
  const text = compareReport(accounts);
  assert.match(text, /PAPER —/);
  assert.doesNotMatch(text, /runs, same markets/);
});

test('the comparison carries each run’s refusal reasons', () => {
  const accounts = {
    careful: { ...newAccount({ profile: 'careful' }), seen: 40, refused: 40, census: { no_edge: 40 } },
    scalp: { ...newAccount({ profile: 'scalp' }), seen: 40, refused: 12, census: { wide_spread: 12 } },
  };
  const text = compareReport(accounts);
  assert.match(text, /no edge/);
  assert.match(text, /wide spread/);
});

test('nothing running says so rather than dividing by zero', () => {
  assert.match(compareReport({}), /No paper runs/);
  assert.match(compareReport(null), /No paper runs/);
});

/**
 * "always" — not a strategy, a measurement. It exists so the other two
 * profiles' refusals can be checked against something real: if this loses
 * money on the same markets careful and scalp stand aside on, that is the
 * gate earning its keep, in a way a census of refusal reasons alone cannot
 * show as plainly as a losing account can.
 */

// A ladder quoted at exactly what the model itself calls fair for each
// strike, rather than guessing cents that happen to clear or miss a bar.
// Guarantees near-zero edge everywhere, so careful and scalp both refuse the
// whole board on their own merits.
function fairLadder(strikes) {
  const prices = history();
  const spot = 65_000;
  const secondsLeft = 500;
  const cents = strikes.map((strike) => {
    const probe = evaluate(
      { prices, spot, strike, marketPriceCents: 50, secondsLeft },
      PROFILES.always.engine,
    );
    return Math.round((probe.probability ?? 0.5) * 100);
  });
  return ladder(cents, strikes);
}

test('always forces an entry on a fairly-priced board that careful and scalp correctly refuse', () => {
  const board = fairLadder([64_900, 64_950, 65_000, 65_050, 65_100]);

  for (const profile of ['careful', 'scalp']) {
    const { event } = paperTick(newAccount({ profile }), context(), { candidates: board });
    assert.equal(event, null, `${profile} should have stood aside on a fair market`);
  }

  const { account, event } = paperTick(newAccount({ profile: 'always' }), context(), {
    candidates: board,
  });
  assert.equal(event.kind, 'enter');
  assert.equal(event.trade.forced, true, "nothing here cleared even always's own loosened bar");
  assert.ok(account.position.contracts > 0);
  assert.ok(account.cash < 70, 'the forced stake never actually left the account');
});

test("a forced entry sizes off the fixed floor, not Kelly's zero on a no-edge market", () => {
  const board = fairLadder([64_900, 64_950, 65_000, 65_050, 65_100]);
  const { account } = paperTick(newAccount({ profile: 'always' }), context(), { candidates: board });

  // Kelly on a genuinely fair price is zero. The only way this account is not
  // still flat is the forcedFraction floor actually overriding it.
  const spent = 70 - account.cash;
  assert.ok(
    spent > 70 * PROFILES.always.forcedFraction * 0.5,
    `spent only $${spent.toFixed(2)} — looks like Kelly's zero won instead of the floor`,
  );
});

test('always stakes against its starting bankroll instead of compounding a fantasy balance', () => {
  const board = ladder([50], [65_000]);
  const richOnPaper = { ...newAccount({ bankroll: 100, profile: 'always' }), cash: 100_000 };
  const { event } = paperTick(richOnPaper, context(), { candidates: board });
  assert.ok(event, 'the always benchmark should enter the readable window');
  assert.ok(event.trade.cost < 6, `a $100 benchmark risked $${event.trade.cost}`);
});

test('lifetime counters are not truncated with the 500-row audit log', () => {
  const account = {
    ...newAccount(),
    trades: Array.from({ length: 500 }, (_, i) => ({ profit: i % 2 ? 1 : -1 })),
    tradeStats: { total: 777, wins: 400, losses: 377, breakEven: 0, netProfit: 23 },
  };
  assert.match(report(account), /777.*trade/);
  assert.match(report(account), /400W 377L/);
});

test('always still tells a genuine edge from a forced one', () => {
  // The default ladder carries real drift from its own seeded history, so
  // several strikes clear even always's loosened bar on their own merits —
  // this is NOT the forced fallback, and the record has to say so, or a
  // forced run's results could never be told apart from a real one.
  const { event } = paperTick(newAccount({ profile: 'always' }), context(), { candidates: ladder() });
  if (!event) return; // still a legitimate outcome if the seeded history ever shifts
  assert.equal(event.trade.forced, false);
});

test('always does not fabricate a trade when nothing on the board has any opinion at all', () => {
  // No price history at all: every strike refuses with no_vol, which carries
  // no probability and therefore no call — there is no "least bad" candidate
  // among opinions that were never formed, forced mode or not.
  const blind = { spot: 65_000, secondsLeft: 500, prices: [] };
  const { account, event } = paperTick(newAccount({ profile: 'always' }), blind, {
    candidates: ladder(),
  });
  assert.equal(event, null);
  assert.equal(account.position, null);
});

test('the always profile is wired for forced entry, not just loosened thresholds', () => {
  assert.equal(PROFILES.always.forceEveryWindow, true);
  assert.ok(PROFILES.always.forcedFraction > 0);
});
