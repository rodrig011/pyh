import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { BRTI_FEED_VERSION, fetchBrtiPrice, readBrti, readBrtiValues } from '../src/picks/price.js';
import { collectOnce, priceContext, historyQuality } from '../src/signals/collector.js';
import { quoteCents, executablePrices } from '../src/signals/cost.js';
import { parseOrderbook, sampledOfi, enrichOrderbook } from '../src/picks/orderbook.js';
import { estimateSettlementProbability } from '../src/signals/quantEngine.js';
import { evaluate } from '../src/signals/engine.js';
import { scalpDecision } from '../src/signals/scalp.js';
import { walkForwardValidation } from '../src/signals/validation.js';

const now = Date.parse('2026-09-06T10:00:00Z');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
const credentials = { keyId: 'fixture', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  apiBase: 'https://example.test/trade-api/v2' };
const envelope = (rows) => ({ data: { serverTime: new Date(now).toISOString(), payload: rows } });
const value = (price, sourceAt = now - 1000) => ({ id: 'BRTI', value: String(price), time: String(sourceAt) });
const quoteFrom = (rows) => fetchBrtiPrice(credentials, {
  now, fetchImpl: async () => ({ ok: true, json: async () => envelope(rows) }),
});

test('documented ascending one-hour BRTI response selects the newest value, not the oldest', async () => {
  const rows = [value(80000, now - 3600000), value(79800, now - 30000), value(79700)];
  assert.equal(readBrti(envelope(rows)), 79700);
  assert.equal(readBrti(envelope([...rows].reverse())), 79700);
  const quote = await quoteFrom(rows);
  assert.equal(quote.price, 79700);
  assert.equal(quote.sourceAt, now - 1000);
  assert.equal(quote.ageMs, 1000);
  assert.equal(quote.feedVersion, BRTI_FEED_VERSION);
});

test('missing BRTI cannot turn ETH, a server date or a numeric prefix into a BTC quote', () => {
  assert.equal(readBrti(envelope([{ id: 'ETHUSD_RTI', value: '4500', time: now }])), null);
  assert.equal(readBrti(envelope({ result: '2026-09-06', serverTime: now })), null);
  assert.equal(readBrti(envelope([{ id: 'BRTI', value: '79700garbage', time: now }])), null);
  assert.equal(readBrti(envelope([value(79700), { id: 'ETHUSD_RTI', value: '4500', time: now }])), 79700);
});

test('fresh receipt time cannot hide a stale, repeated, future or undated BRTI calculation', async () => {
  for (const [rows, code] of [
    [[value(79700, now - 3600000)], 'stale_price'],
    [[value(79700, now + 60000)], 'stale_price'],
    [[{ id: 'BRTI', value: '79700' }], 'missing_timestamp'],
    [[{ ...value(79700), repeatOfPreviousValue: true }], 'repeated_value'],
  ]) {
    const quote = await quoteFrom(rows);
    assert.equal(quote.price, null);
    assert.equal(quote.errorCode, code);
  }
  assert.equal(readBrtiValues(envelope({ BRTI: { value: '7.97e4', time: now } }))[0].price, 79700);
});

test('restart bootstraps 120 thirty-second BRTI intervals and preserves the legacy audit rows', async () => {
  const rows = Array.from({ length: 3600 }, (_, i) => value(79700 + Math.sin(i / 20) * 30, now - (3600 - i) * 1000));
  const quote = await quoteFrom(rows);
  const old = { at: now - 500, price: 99999, source: 'kalshi-brti' };
  let stored = [old];
  const store = { listSamples: () => stored, putSamples: (_, samples) => { stored = samples; } };
  const collected = await collectOnce(store, { fetchPrice: async () => quote, now });
  assert.equal(collected.added, true);
  assert.ok(stored.includes(old), 'do not erase historical evidence');
  const context = priceContext(stored, quote, { now });
  assert.equal(context.prices.length, 120);
  assert.ok(!context.prices.includes(99999), 'old receipt-stamped prices never enter inference');
  assert.equal(historyQuality(context.priceSamples).ok, true);
  assert.equal(context.priceSamples[1].at - context.priceSamples[0].at, 30000);
  assert.equal((await collectOnce(store, { fetchPrice: async () => quote, now })).added, false);
});

test('one cent and one dollar have distinct units in execution quotes', () => {
  assert.equal(quoteCents({ yes_bid: 1 }, 'yes_bid'), 1);
  assert.equal(quoteCents({ yes_bid_dollars: '0.0100' }, 'yes_bid'), 1);
  assert.equal(quoteCents({ yes_bid_dollars: '1.0000' }, 'yes_bid'), 100);
  assert.equal(quoteCents({ yes_bid: null }, 'yes_bid'), null);
  assert.equal(executablePrices({ yes_bid: 1, yes_ask: 2 }).noAskCents, 99);
});

const bookBody = (bidCount = 100) => ({ orderbook_fp: {
  yes_dollars: [['0.45', '50.00'], ['0.49', String(bidCount)]],
  no_dollars: [['0.48', '100.00']],
} });
test('actual Kalshi bid arrays reconstruct asks and distinguish event OFI from static imbalance', () => {
  const first = parseOrderbook(bookBody(), { ticker: 'BTC', at: now });
  const second = parseOrderbook(bookBody(200), { ticker: 'BTC', at: now + 5000 });
  assert.equal(first.bid, 49);
  assert.equal(first.ask, 52);
  assert.equal(first.liquidityDollars, 119.5);
  assert.equal(sampledOfi(null, first), null);
  assert.equal(sampledOfi(first, second), 0.2);
  assert.equal(sampledOfi(first, { ...second, ticker: 'NEXT' }), null);
  assert.equal(sampledOfi(first, { ...second, at: now + 31000 }), null);
});

test('depth supersedes a summary liquidity zero and reaches quant through the normal engine', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => bookBody(400) });
  const market = await enrichOrderbook({ ticker: 'BTC', liquidity_dollars: '0' }, credentials, { fetchImpl, now });
  const history = Array.from({ length: 120 }, (_, i) => 79700 + Math.sin(i) * 20);
  const result = evaluate({ prices: history, spot: 79700, strike: 79700, secondsLeft: 300,
    marketPriceCents: 50.5, market }, { maximumTrendFit: 1 });
  assert.ok(result.quant.features.liquidityDollars > 25);
  assert.equal(result.quant.features.thinBook, false);
  assert.ok(result.quant.features.bookImbalance > 0);
  assert.equal(result.quant.features.ofi, null);
  const thin = estimateSettlementProbability({ prices: history, spot: 79700, strike: 79700, secondsLeft: 300,
    marketPriceCents: 50, market: { yes_bid: 49, yes_ask: 51, liquidity_dollars: '0' } }, { minimumLiquidityDollars: 0 });
  assert.equal(thin.features.thinBook, true, 'ALWAYS cannot erase evidence penalties');
});

test('final-minute settlement uses banked BRTI, not the current spike, and rejects sparse history', () => {
  const history = Array.from({ length: 120 }, (_, i) => 79700 + Math.sin(i) * 10);
  const samples = Array.from({ length: 30 }, (_, i) => ({ source: 'kalshi-brti',
    sourceAt: now - (30 - i) * 1000, price: 79500 }));
  const input = { prices: history, spot: 79800, strike: 79750, secondsLeft: 30, now,
    marketPriceCents: 50, market: { yes_bid: 49, yes_ask: 51 }, settlementSamples: samples };
  const result = estimateSettlementProbability(input);
  assert.equal(result.features.settlementReference, 79650);
  assert.ok(result.fairPYes < 0.5, 'spot is above strike but banked average is below');
  const sparse = estimateSettlementProbability({ ...input, settlementSamples: samples.slice(10) });
  assert.equal(sparse.fairPYes, null);
  assert.ok(sparse.missing.includes('settlement_window_history'));
});

test('entry pricing tests the chosen side and preserves a priced-out read for exiting a held position', () => {
  const input = { prices: Array.from({ length: 120 }, (_, i) => 79700 + Math.sin(i) * 20),
    spot: 79700, strike: 79700, secondsLeft: 300, marketPriceCents: 97,
    market: { yes_bid: 96, yes_ask: 98, liquidity_dollars: '1000' } };
  const options = { maximumTrendFit: 1, strongChartConflictScore: Infinity };
  assert.equal(evaluate(input, options).verdict, 'down', '4c NO is inside the permitted band');
  const rejected = evaluate(input, { ...options, minimumEntryCents: 5 });
  assert.equal(rejected.reason, 'priced_out');
  assert.ok(Number.isFinite(rejected.probability));
  const exit = scalpDecision({ position: { side: 'up', entryCents: 60 }, nowCents: 96,
    signal: rejected, secondsLeft: 300 });
  assert.equal(exit.action, 'exit');
});

test('production validation quarantines unverified prices without dropping retained audit data', () => {
  const rows = [{ ticker: 'A', at: now, secondsLeft: 300, model: 0.99, bid: 49, ask: 51,
    outcome: 0, outcomeSource: 'kalshi-market:official-result' }];
  const checked = walkForwardValidation(rows, { requireVerifiedFeed: true });
  assert.equal(checked.totalMarkets, 0);
  assert.equal(checked.excludedUnverifiedObservations, 1);
  assert.equal(rows.length, 1);
});
