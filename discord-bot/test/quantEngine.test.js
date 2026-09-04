import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookImbalance,
  cumulativeVolumeDelta,
  estimateSettlementProbability,
  QUANT_STATUS,
} from '../src/signals/quantEngine.js';

function prices({ n = 120, start = 65_000, step = 3 } = {}) {
  return Array.from({ length: n }, (_, index) => start + index * step + Math.sin(index / 3) * 8);
}

const market = {
  yes_bid_dollars: '0.49',
  yes_ask_dollars: '0.51',
  yes_bid_size: 300,
  yes_ask_size: 100,
  liquidity_dollars: '500',
};

function input(overrides = {}) {
  const history = prices();
  return {
    prices: history,
    spot: history.at(-1),
    strike: 65_300,
    secondsLeft: 420,
    marketPriceCents: 50,
    market,
    microstructure: { ofi: 0.25 },
    trades: [
      { taker_side: 'yes', count: 80 },
      { taker_side: 'no', count: 20 },
    ],
    ...overrides,
  };
}

test('critical missing data returns an explicit insufficient result, never an invented probability', () => {
  const result = estimateSettlementProbability(input({ strike: null }));
  assert.equal(result.status, QUANT_STATUS.INSUFFICIENT);
  assert.equal(result.fairPYes, null);
  assert.ok(result.missing.includes('strike'));
});

test('the pure quant engine returns complementary fair probabilities and both net edges', () => {
  const result = estimateSettlementProbability(input());
  assert.equal(result.status, QUANT_STATUS.OK);
  assert.ok(result.fairPYes > 0 && result.fairPYes < 1);
  assert.ok(Math.abs(result.fairPYes + result.fairPNo - 1) < 1e-12);
  assert.ok(Number.isFinite(result.edge.yes.netCents));
  assert.ok(Number.isFinite(result.edge.no.netCents));
  assert.match(result.confidence.grade, /^[ABCD]$/);
});

test('trend strength under 0.20 caps confidence at 70 percent', () => {
  const flat = Array.from({ length: 120 }, (_, i) => 65_000 + Math.sin(i) * 20);
  const result = estimateSettlementProbability(input({ prices: flat, spot: flat.at(-1) }));
  assert.ok(result.features.trendStrength < 0.2);
  assert.ok(result.confidence.score <= 70);
  assert.ok(result.confidence.caps.some((cap) => cap.includes('0.20')));
});

test('thin books and expanding volatility apply exact confidence penalties', () => {
  const calm = Array.from({ length: 60 }, (_, i) => 65_000 + Math.sin(i) * 2);
  const wild = Array.from({ length: 60 }, (_, i) => 65_000 + Math.sin(i) * (20 + i));
  const history = [...calm, ...wild];
  const liquid = estimateSettlementProbability(input({ prices: history, spot: history.at(-1) }));
  const thin = estimateSettlementProbability(input({
    prices: history,
    spot: history.at(-1),
    market: { ...market, liquidity_dollars: '2' },
  }));
  assert.equal(thin.features.thinBook, true);
  assert.equal(thin.features.volatilityExpanding, true);
  assert.ok(thin.confidence.penalties.includes('thin book: -15'));
  assert.ok(thin.confidence.penalties.includes('expanding volatility: -10'));
  assert.ok(thin.confidence.score <= liquid.confidence.score - 15);
});

test('technical-only evidence loses twenty confidence points', () => {
  const normal = estimateSettlementProbability(input());
  const technical = estimateSettlementProbability(input({ technicalOnly: true }));
  assert.equal(technical.confidence.score, normal.confidence.score - 20);
  assert.ok(technical.confidence.penalties.includes('technical-only thesis: -20'));
});

test('trade delta and book imbalance remain separate measured features', () => {
  assert.equal(cumulativeVolumeDelta([
    { taker_side: 'yes', count: 75 },
    { taker_side: 'no', count: 25 },
  ]), 0.5);
  assert.equal(bookImbalance({ yes_bid_size: 300, yes_ask_size: 100 }), 0.5);
  assert.equal(bookImbalance({ yes_bid_dollars: 0.49, yes_ask_dollars: 0.51 }), null);
});

test('missing OFI or complete depth caps confidence instead of pretending zero', () => {
  const result = estimateSettlementProbability(input({
    microstructure: {},
    market: { ...market, yes_bid_size: undefined, yes_ask_size: undefined },
  }));
  assert.ok(result.missing.includes('ofi'));
  assert.ok(result.missing.includes('book_imbalance'));
  assert.ok(result.confidence.score <= 80);
});
