import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contractReturn,
  currentContract,
  formatCents,
  marketForClose,
  gradeByContract,
  isPriceCents,
  openMarkets,
  readMarketPrice,
} from '../src/picks/kalshi.js';

// The response shape could not be verified against the live API from where this
// was written, so it is pinned here instead: if Kalshi's real body differs, the
// fixture is what gets corrected, and these say exactly what was assumed.

const market = {
  ticker: 'KXBTCD-26AUG0215-T63000',
  status: 'active',
  close_time: '2099-01-01T00:00:00Z',
  last_price: 47,
  yes_bid: 46,
  yes_ask: 48,
  no_bid: 52,
  no_ask: 54,
};

test('a price is only a price inside 0–100 cents', () => {
  assert.equal(isPriceCents(47), true);
  assert.equal(isPriceCents(0), true);
  assert.equal(isPriceCents(100), true);
  assert.equal(isPriceCents(101), false);
  assert.equal(isPriceCents(-1), false);
  assert.equal(isPriceCents('47'), false);
});

test("the side's own book is preferred over the last trade", () => {
  // last_price is the YES side's last trade and can be minutes stale. The
  // published bid/ask for the side actually being taken is what a scalper can
  // get right now — and on the NO side it is a real quote rather than 100
  // minus somebody else's fill.
  assert.deepEqual(readMarketPrice(market), { cents: 47, source: 'mid' });
  assert.deepEqual(readMarketPrice(market, 'no'), { cents: 53, source: 'mid' });

  // With no book, the last trade still answers.
  assert.deepEqual(readMarketPrice({ last_price: 47 }), { cents: 47, source: 'last_price' });
});

test('the no side is the complement of the yes side', () => {
  assert.equal(readMarketPrice(market, 'no').cents, 53);
});

test('with nothing traded yet the mid of the book is used', () => {
  const untraded = { ...market, last_price: 0 };
  assert.deepEqual(readMarketPrice(untraded), { cents: 47, source: 'mid' });
});

test('a market with no usable price says so rather than inventing one', () => {
  // A made-up entry produces a made-up profit, which is worse than no grade.
  const empty = { ...market, last_price: 0, yes_bid: 0, yes_ask: 0 };
  assert.equal(readMarketPrice(empty), null);
  assert.equal(readMarketPrice(null), null);
  assert.equal(readMarketPrice({}), null);
});

test('only open markets that have not closed are offered', () => {
  const now = Date.parse('2026-08-02T15:00:00Z');
  const list = [
    { ...market, ticker: 'closed', status: 'closed' },
    { ...market, ticker: 'expired', close_time: '2026-08-02T14:00:00Z' },
    { ...market, ticker: 'later', close_time: '2026-08-02T16:00:00Z' },
    { ...market, ticker: 'sooner', close_time: '2026-08-02T15:15:00Z' },
  ];

  assert.deepEqual(openMarkets(list, now).map((m) => m.ticker), ['sooner', 'later']);
});

test('the return is measured on the contract, not the underlying', () => {
  // 47¢ to 61¢ is +29.8% whatever BTC did in between.
  assert.equal(Math.round(contractReturn(47, 61) * 10) / 10, 29.8);
  assert.equal(Math.round(contractReturn(80, 40) * 10) / 10, -50);
  assert.equal(contractReturn(0, 50), null);
  assert.equal(contractReturn(47, null), null);
});

test('a scalp is graded on what the contract did', () => {
  assert.equal(gradeByContract(47, 61).outcome, 'win');
  assert.equal(gradeByContract(80, 40).outcome, 'loss');
});

test('a one-cent drift is flat, not a win sold to the room', () => {
  assert.equal(gradeByContract(50, 50).outcome, 'break_even');
  assert.equal(gradeByContract(100, 100).outcome, 'break_even');
});

test('a call right at the close can still be a loss on the contract', () => {
  // Bought at 80¢, closed at 55¢: the direction was right, the trade was not.
  const graded = gradeByContract(80, 55);
  assert.equal(graded.outcome, 'loss');
  assert.ok(graded.changePercent < 0);
});

test('currentContract returns the soonest open market and its price', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ markets: [market] }),
  });

  const result = await currentContract({ seriesTicker: 'KXBTCD' }, { fetchImpl });
  assert.equal(result.price, 47);
  assert.equal(result.market.ticker, market.ticker);
  assert.equal(result.error, null);
});

test('a feed that is down reports the reason and never throws', async () => {
  const down = await currentContract({}, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.price, null);
  assert.match(down.error, /ECONNREFUSED/);

  const rejected = await currentContract({}, {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.match(rejected.error, /401/);
});

test('no open market is reported as such, not as a zero price', async () => {
  const result = await currentContract({}, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ markets: [] }) }),
  });
  assert.equal(result.price, null);
  assert.match(result.error, /no open markets/);
});

test('cents are formatted the way the site shows them', () => {
  // A Kalshi price in cents is also the implied probability, and the room says
  // it out loud as a percentage: "down is 53, up is 47".
  assert.equal(formatCents(47), '47%');
  assert.equal(formatCents(null), '—');
});

test('a DOWN call is priced on the side the analyst actually bought', () => {
  // One market, two sides. YES pays if the candle closes up.
  const market = { status: 'open', last_price: 61 };

  assert.equal(readMarketPrice(market, 'yes').cents, 61);
  assert.equal(readMarketPrice(market, 'no').cents, 39);
});

test('the same move is a win on one side and a loss on the other', () => {
  // Bought NO at 39, it went to 50: the DOWN call made money.
  assert.equal(gradeByContract(39, 50).outcome, 'win');
  // Read off the YES side instead, the identical trade reports a loss.
  assert.equal(gradeByContract(61, 50).outcome, 'loss');
});

test('a call is priced against the market covering its own window', () => {
  const now = Date.parse('2026-08-03T02:14:00Z');
  const markets = [
    { ticker: 'KXBTC15M-26AUG030215', status: 'open', close_time: '2026-08-03T02:15:00Z', last_price: 39 },
    { ticker: 'KXBTC15M-26AUG030230', status: 'open', close_time: '2026-08-03T02:30:00Z', last_price: 52 },
  ];

  // Opened at 02:14 with a minute to run: the 02:15 contract.
  assert.equal(
    marketForClose(markets, Date.parse('2026-08-03T02:15:00Z'), now).ticker,
    'KXBTC15M-26AUG030215',
  );

  // Opened seconds before the bell, so the call rolled to the next candle —
  // and the contract has to roll with it.
  assert.equal(
    marketForClose(markets, Date.parse('2026-08-03T02:30:00Z'), now).ticker,
    'KXBTC15M-26AUG030230',
  );
});

test('with no window given it falls back to whatever closes next', () => {
  const now = Date.parse('2026-08-03T02:14:00Z');
  const markets = [
    { ticker: 'later', status: 'open', close_time: '2026-08-03T02:30:00Z' },
    { ticker: 'sooner', status: 'open', close_time: '2026-08-03T02:15:00Z' },
  ];

  assert.equal(marketForClose(markets, null, now).ticker, 'sooner');
});

test('a market that already closed is never chosen', () => {
  const now = Date.parse('2026-08-03T02:20:00Z');
  const markets = [
    { ticker: 'gone', status: 'open', close_time: '2026-08-03T02:15:00Z' },
    { ticker: 'live', status: 'open', close_time: '2026-08-03T02:30:00Z' },
  ];

  // Even though its close time is nearer the asked-for window.
  assert.equal(marketForClose(markets, Date.parse('2026-08-03T02:15:00Z'), now).ticker, 'live');
});

// Captured live from /picks kalshi on 2026-08-03. Kalshi reports dollar
// strings; the bot had been looking for whole-cent integers and called a
// perfectly liquid market unpriceable.
const liveMarket = {
  ticker: 'KXBTC15M-26AUG030230-30',
  event_ticker: 'KXBTC15M-26AUG030230',
  status: 'active',
  market_type: 'binary',
  can_close_early: true,
  close_time: '2026-08-03T06:30:00Z',
  open_time: '2026-08-03T06:15:00Z',
  expiration_time: '2026-08-10T06:30:00Z',
  floor_strike: 62772.53,
  last_price_dollars: '0.3900',
  no_ask_dollars: '0.6100',
  no_bid_dollars: '0.6000',
  notional_value_dollars: '1.0000',
  previous_price_dollars: '0.0000',
  previous_yes_ask_dollars: '0.0000',
  previous_yes_bid_dollars: '0.0000',
  liquidity_dollars: '0.0000',
  open_interest_fp: '148631.49',
};

test('a live market quoted in dollar strings is priced, not rejected', () => {
  const down = readMarketPrice(liveMarket, 'no');
  assert.equal(down.cents, 61);
  assert.equal(down.source, 'mid');

  // No YES book on this one, so the YES side falls back to the last trade.
  const up = readMarketPrice(liveMarket, 'yes');
  assert.equal(up.cents, 39);
  assert.equal(up.source, 'last_price');
});

test('the two sides of a live market still add up to a whole contract', () => {
  const up = readMarketPrice(liveMarket, 'yes').cents;
  const down = readMarketPrice(liveMarket, 'no').cents;

  assert.ok(Math.abs(up + down - 100) <= 1, `${up} + ${down} should be about 100`);
});

test('the old whole-cent fields still work', () => {
  assert.equal(readMarketPrice({ yes_bid: 46, yes_ask: 48 }, 'yes').cents, 47);
  assert.equal(readMarketPrice({ last_price: 61 }, 'no').cents, 39);
});

test('a dollar string of zero is not a price', () => {
  assert.equal(readMarketPrice({ last_price_dollars: '0.0000' }, 'yes'), null);
  assert.equal(readMarketPrice({ yes_bid_dollars: '', yes_ask_dollars: '' }, 'yes'), null);
});

test('the live market is open and matched to its own window', () => {
  const now = Date.parse('2026-08-03T06:20:00Z');
  assert.equal(openMarkets([liveMarket], now).length, 1);
  assert.equal(
    marketForClose([liveMarket], Date.parse('2026-08-03T06:30:00Z'), now).ticker,
    'KXBTC15M-26AUG030230-30',
  );
});

/**
 * Which strike gets recorded decides what the edge measurement is even about.
 *
 * `currentContract()` returns whichever market closes soonest, and a dozen
 * strikes in one window all close at the same instant — so it returned
 * whichever the exchange listed first, a fixed position on the ladder rather
 * than a fixed distance from the money. The edge log filled up with contracts
 * priced at 3¢ and 96¢: nearly decided, easy to forecast, and refused by the
 * engine on sight. That measures a population the bot does not trade.
 */

import { nearestTheMoneyContract } from '../src/picks/kalshi.js';

test('the recorded strike is the one nearest a coin flip', () => {
  const contracts = [
    { price: 96, market: { ticker: 'deep-itm' } },
    { price: 47, market: { ticker: 'near-money' } },
    { price: 4, market: { ticker: 'deep-otm' } },
  ];
  assert.equal(nearestTheMoneyContract(contracts).market.ticker, 'near-money');
});

test('nearest the money ignores strikes with no usable price', () => {
  const contracts = [
    { price: null, market: { ticker: 'unquoted' } },
    { price: 80, market: { ticker: 'quoted' } },
  ];
  assert.equal(nearestTheMoneyContract(contracts).market.ticker, 'quoted');
});

test('an empty board has no nearest strike rather than throwing', () => {
  assert.equal(nearestTheMoneyContract([]), null);
  assert.equal(nearestTheMoneyContract(null), null);
});

test('a tie picks one rather than none', () => {
  const contracts = [{ price: 45, market: { ticker: 'a' } }, { price: 55, market: { ticker: 'b' } }];
  assert.ok(['a', 'b'].includes(nearestTheMoneyContract(contracts).market.ticker));
});
