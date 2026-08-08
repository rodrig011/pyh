import test from 'node:test';
import assert from 'node:assert/strict';
import { leastBadCandidate, shouldForceEntry, tradesInWindow } from '../src/picks/forceTrade.js';

test('tradesInWindow only counts orders actually placed, inside the window', () => {
  const now = 1_000_000;
  const orders = [
    { result: { status: 'placed' }, at: now - 1000 }, // inside
    { result: { status: 'placed' }, at: now - 10_000_000 }, // outside
    { result: { status: 'rejected' }, at: now - 1000 }, // not placed
    { result: { status: 'timeout' }, at: now - 1000 }, // not placed
  ];
  assert.equal(tradesInWindow(orders, { windowMs: 3_600_000, now }), 1);
});

test('tradesInWindow is zero with no window configured', () => {
  assert.equal(tradesInWindow([{ result: { status: 'placed' }, at: 5 }], { windowMs: 0, now: 10 }), 0);
});

test('shouldForceEntry is off unless a target is actually configured', () => {
  assert.equal(shouldForceEntry({ ordersInWindow: 0, targetPerWindow: 0 }), false);
  assert.equal(shouldForceEntry({ ordersInWindow: 0, targetPerWindow: null }), false);
});

test('shouldForceEntry fires below the target and stops once it is met', () => {
  assert.equal(shouldForceEntry({ ordersInWindow: 2, targetPerWindow: 5 }), true);
  assert.equal(shouldForceEntry({ ordersInWindow: 5, targetPerWindow: 5 }), false);
  assert.equal(shouldForceEntry({ ordersInWindow: 6, targetPerWindow: 5 }), false);
});

test('leastBadCandidate picks the best of the refused, never a blind one', () => {
  const reads = [
    // No opinion at all — the feed gave nothing to work with.
    { ticker: 'A', read: { call: null, entryCents: null } },
    // An opinion, but a bad one.
    { ticker: 'B', read: { call: 'down', entryCents: 90, netEdgeCents: -8 } },
    // The least-bad opinion on the board.
    { ticker: 'C', read: { call: 'up', entryCents: 45, netEdgeCents: -1 } },
  ];
  const picked = leastBadCandidate(reads);
  assert.equal(picked.ticker, 'C');
});

test('leastBadCandidate is null when nothing on the board has an opinion', () => {
  const reads = [{ ticker: 'A', read: { call: null, entryCents: null } }];
  assert.equal(leastBadCandidate(reads), null);
});
