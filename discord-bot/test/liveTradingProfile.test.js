import test from 'node:test';
import assert from 'node:assert/strict';

import { readBoard } from '../src/signals/board.js';
import { PROFILES } from '../src/picks/paper.js';

/**
 * `sweepLiveTrading` reads config.picks.kalshi.trading.profile and passes
 * PROFILES[profile].engine into readBoard — the same profiles the paper
 * account already trades with. This is the wiring, not the model: proving the
 * 'scalp' engine settings can never be MORE restrictive than 'careful' on the
 * same board is what makes KALSHI_TRADING_PROFILE=scalp actually mean
 * "trade more", rather than silently doing nothing because live trading kept
 * reading the hardcoded engine defaults regardless of the setting.
 */

const HISTORY = Array.from({ length: 90 }, (_, i) => 65_000 + Math.sin(i / 3) * 40);

function strike(price, cents, { ticker = `K-${price}` } = {}) {
  return {
    price: cents,
    market: {
      ticker,
      floor_strike: price,
      status: 'active',
      close_time: '2026-01-01T00:15:00Z',
      yes_bid_dollars: String((cents - 1) / 100),
      yes_ask_dollars: String((cents + 1) / 100),
      liquidity_dollars: '4000',
    },
  };
}

const CONTEXT = { prices: HISTORY, spot: 65_000, secondsLeft: 420 };

// Priced 43-45c on this history: a real edge of a few cents, big enough for
// 'scalp' (minimumEdgeCents 3) but under 'careful' (minimumEdgeCents 6) — the
// exact band the whole point of the profile is to reach.
const THIN_EDGE_LADDER = [strike(65_000, 44), strike(64_900, 60), strike(65_100, 20)];

test('the scalp profile never trades LESS of a board than careful', () => {
  const careful = readBoard(THIN_EDGE_LADDER, CONTEXT, PROFILES.careful.engine);
  const scalp = readBoard(THIN_EDGE_LADDER, CONTEXT, PROFILES.scalp.engine);

  assert.ok(scalp.tradeable.length >= careful.tradeable.length);
});

test('scalp accepts a thin edge careful refuses as no_edge', () => {
  const careful = readBoard(THIN_EDGE_LADDER, CONTEXT, PROFILES.careful.engine);
  const scalp = readBoard(THIN_EDGE_LADDER, CONTEXT, PROFILES.scalp.engine);

  const thinStrike = careful.reads.find((entry) => entry.strike === 65_000);
  assert.equal(thinStrike.read.tradeable, false);
  assert.equal(thinStrike.read.result.reason, 'no_edge');

  const scalpRead = scalp.reads.find((entry) => entry.strike === 65_000);
  assert.equal(scalpRead.read.tradeable, true);
  assert.ok(scalp.tradeable.length > careful.tradeable.length);
});

test('an unconfigured profile falls back to careful, not to nothing', () => {
  const fallback = PROFILES['does-not-exist'] ?? PROFILES.careful;
  assert.equal(fallback, PROFILES.careful);
});
