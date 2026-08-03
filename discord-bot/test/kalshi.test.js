import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contractReturn,
  currentContract,
  formatCents,
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

test('the last traded price is preferred, since that is what a scalper gets', () => {
  assert.deepEqual(readMarketPrice(market), { cents: 47, source: 'last_price' });
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
