import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkets, planScan } from '../src/signals/scanner.js';

// The edge per bet is capped by the maths. The number of good bets a day is
// not, and that is the only honest way to make the account grow faster.

const walk = (n, step) => Array.from({ length: n }, (_, i) => 65000 * Math.exp(((i % 3) - 1) * step));

const mispriced = (asset, ticker) => ({
  asset,
  ticker,
  prices: walk(40, 0.0004),
  spot: 65120,
  strike: 65000,
  marketPriceCents: 40,
  secondsLeft: 300,
  market: { yes_bid_dollars: '0.39', yes_ask_dollars: '0.40', liquidity_dollars: '800' },
});

const fair = (asset, ticker) => ({
  ...mispriced(asset, ticker),
  spot: 65000,
  marketPriceCents: 50,
  market: { yes_bid_dollars: '0.49', yes_ask_dollars: '0.50', liquidity_dollars: '800' },
});

test('a scan calls what is mispriced and refuses the rest', () => {
  const plan = planScan([mispriced('BTC', 'B1'), fair('ETH', 'E1'), mispriced('SOL', 'S1')]);

  assert.equal(plan.scanned, 3);
  assert.equal(plan.calls.length, 2);
  assert.equal(plan.skips.length, 1);
  assert.equal(plan.skips[0].asset, 'ETH');
});

test('every call is sized, best edge first', () => {
  const plan = planScan([mispriced('BTC', 'B1'), mispriced('ETH', 'E1')]);

  assert.ok(plan.calls.every((call) => call.sizing.suggested > 0));
  assert.ok(
    (plan.calls[0].result.expected.net ?? 0) >= (plan.calls[1].result.expected.net ?? 0),
    'if the cap forces a trim, the strongest claim keeps most of its size',
  );
});

test('simultaneous signals are capped together, because crypto moves as one', () => {
  const many = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'].map((asset) => mispriced(asset, asset));
  const plan = planScan(many, { maximumTotalFraction: 0.15 });

  const total = plan.calls.reduce((sum, call) => sum + call.sizing.suggested, 0);

  // Five same-direction crypto bets in one quarter hour are closer to one big
  // bet than five small ones. Sizing them as independent is how a single bad
  // candle takes five losses at once.
  assert.ok(total <= 0.15 + 1e-9);
  assert.ok(plan.scale < 1);
});

test('the trim is proportional, never pick-and-drop', () => {
  const many = ['BTC', 'ETH', 'SOL', 'BNB'].map((asset) => mispriced(asset, asset));
  const plan = planScan(many, { maximumTotalFraction: 0.05 });

  // Everything that beat the filters stays on, at a smaller size.
  assert.equal(plan.calls.length, 4);
  assert.ok(plan.calls.every((call) => call.sizing.suggested > 0));
  assert.ok(plan.calls.every((call) => Math.abs(call.sizing.scaledBy - plan.scale) < 1e-9));
});

test('one good signal is not trimmed at all', () => {
  const plan = planScan([mispriced('BTC', 'B1')], { maximumTotalFraction: 0.15 });

  assert.equal(plan.scale, 1);
  assert.equal(plan.calls[0].sizing.scaledBy, 1);
});

test('a scan of nothing is a scan, not a crash', () => {
  const empty = planScan([]);
  assert.deepEqual(empty.calls, []);
  assert.equal(empty.scanned, 0);
  assert.equal(planScan(null).scanned, 0);
});

test('the market list is configuration, because only the exchange knows what exists', () => {
  assert.deepEqual(parseMarkets('BTC:KXBTC15M,ETH:KXETH15M'), [
    { asset: 'BTC', series: 'KXBTC15M' },
    { asset: 'ETH', series: 'KXETH15M' },
  ]);

  // Falls back to the single-market config rather than watching nothing.
  assert.deepEqual(parseMarkets('', 'BTC', 'KXBTC15M'), [{ asset: 'BTC', series: 'KXBTC15M' }]);
  assert.deepEqual(parseMarkets(null, 'BTC', null), []);
  // Rubbish entries are dropped, not guessed at.
  assert.deepEqual(parseMarkets('BTC:KXBTC15M,nonsense'), [{ asset: 'BTC', series: 'KXBTC15M' }]);
});
