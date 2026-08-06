import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKED,
  DEFAULT_DAILY_LIMIT_DOLLARS,
  checkTrade,
  dayKey,
  lossStreak,
  newRiskState,
  riskSummary,
  spentToday,
} from '../src/picks/riskLimits.js';

/**
 * The rails between a bug and somebody's actual money.
 *
 * Every test here is about what must NOT happen. A model that is wrong loses
 * slowly and is caught by the record; a bug that is wrong loses everything at
 * once and is caught by nothing.
 */

const armed = (over = {}) => ({ ...newRiskState(), armed: true, ...over });
const ok = { hasCredentials: true, secondsLeft: 400, wantDollars: 5 };

test('a fresh state is DISARMED, and that is not a formality', () => {
  const state = newRiskState();
  assert.equal(state.armed, false);
  assert.equal(checkTrade({ state, ...ok }).blocked, BLOCKED.DISARMED);
});

test('the default budget is twenty dollars a day', () => {
  assert.equal(DEFAULT_DAILY_LIMIT_DOLLARS, 20);
  assert.equal(newRiskState().dailyLimitDollars, 20);
});

test('no credentials means no trade, however armed it is', () => {
  const result = checkTrade({ state: armed(), ...ok, hasCredentials: false });
  assert.equal(result.blocked, BLOCKED.NO_CREDENTIALS);
  assert.equal(result.dollars, 0);
});

test('the kill switch stops everything and does not expire by itself', () => {
  const state = armed({ killed: true, killedReason: 'by hand' });
  const result = checkTrade({ state, ...ok });
  assert.equal(result.blocked, BLOCKED.KILLED);
  assert.equal(result.dollars, 0);
});

test('spending is rebuilt from filled orders, not from a counter in memory', () => {
  // A counter is reset by a redeploy, and this bot redeployed eight times in a
  // day. The day's spending has to survive restarts.
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [
    { at: Date.parse('2026-08-06T01:00:00Z'), costDollars: 5, status: 'filled' },
    { at: Date.parse('2026-08-06T09:00:00Z'), costDollars: 4, status: 'filled' },
    // Yesterday: does not count against today.
    { at: Date.parse('2026-08-05T23:00:00Z'), costDollars: 9, status: 'filled' },
    // Rejected: cost nothing.
    { at: Date.parse('2026-08-06T10:00:00Z'), costDollars: 6, status: 'rejected' },
  ];

  const spent = spentToday(orders, { now });
  assert.equal(spent.spent, 9);
  assert.equal(spent.trades, 2);
});

test('an order of unknown fate counts as spent', () => {
  // The safe assumption about an order nobody can account for is that it worked.
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [{ at: now, costDollars: 7, status: 'unknown' }];
  assert.equal(spentToday(orders, { now }).spent, 7);
});

test('the day is the UTC day, because that is the one the exchange settles on', () => {
  assert.equal(dayKey(Date.parse('2026-08-06T23:59:00Z')), '2026-08-06');
  assert.equal(dayKey(Date.parse('2026-08-07T00:01:00Z')), '2026-08-07');
});

test('the budget is what may be PUT AT RISK, not a target for net losses', () => {
  // Counting only losses would let a day of round trips spend the limit many
  // times over on the way to the same place.
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [
    { at: now, costDollars: 10, profitDollars: 1, status: 'filled' },
    { at: now, costDollars: 10, profitDollars: 1, status: 'filled' },
  ];
  const result = checkTrade({ state: armed(), orders, ...ok, now });
  assert.equal(result.blocked, BLOCKED.DAILY_LIMIT, 'two winning trades still spent the budget');
});

test('a trade is capped at a quarter of the day, never the whole of it', () => {
  const result = checkTrade({ state: armed(), ...ok, wantDollars: 100 });
  assert.equal(result.allowed, true);
  assert.equal(result.dollars, 5, 'a quarter of twenty');
});

test('the last trade of the day is trimmed to what is left, not refused', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [{ at: now, costDollars: 18, status: 'filled' }];
  const result = checkTrade({ state: armed(), orders, ...ok, wantDollars: 5, now });
  assert.equal(result.allowed, true);
  assert.equal(result.dollars, 2);
});

test('three losses in a row ends the day, whatever the budget says', () => {
  // A losing streak is exactly when a wrong model looks most like bad luck.
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [
    { at: now, costDollars: 1, profitDollars: -1, status: 'filled' },
    { at: now, costDollars: 1, profitDollars: -1, status: 'filled' },
    { at: now, costDollars: 1, profitDollars: -1, status: 'filled' },
  ];
  assert.equal(lossStreak(orders, { now }), 3);
  assert.equal(checkTrade({ state: armed(), orders, ...ok, now }).blocked, BLOCKED.LOSS_STREAK);
});

test('a win breaks the streak', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [
    { at: now, costDollars: 1, profitDollars: -1, status: 'filled' },
    { at: now, costDollars: 1, profitDollars: -1, status: 'filled' },
    { at: now, costDollars: 1, profitDollars: 2, status: 'filled' },
    { at: now, costDollars: 1, profitDollars: -1, status: 'filled' },
  ];
  assert.equal(lossStreak(orders, { now }), 1);
});

test('only one position at a time', () => {
  // Two open bets on a 15-minute crypto contract are not two bets: they move
  // together, so the real exposure is the sum while the limit was for one.
  const result = checkTrade({ state: armed(), ...ok, openPosition: { ticker: 'T' } });
  assert.equal(result.blocked, BLOCKED.ALREADY_IN);
});

test('a market whose clock cannot be read is never spent on', () => {
  // The same caution that refused every market for two days, pointed at the
  // thing that costs money.
  assert.equal(checkTrade({ state: armed(), ...ok, secondsLeft: null }).blocked, BLOCKED.STALE_CLOCK);
  assert.equal(checkTrade({ state: armed(), ...ok, secondsLeft: 0 }).blocked, BLOCKED.STALE_CLOCK);
});

test('the summary says the things a person needs before trusting it', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const orders = [{ at: now, costDollars: 6, profitDollars: -2, status: 'filled' }];
  const summary = riskSummary(armed(), orders, { now });

  assert.equal(summary.armed, true);
  assert.equal(summary.limit, 20);
  assert.equal(summary.spent, 6);
  assert.equal(summary.remaining, 14);
  assert.equal(summary.realised, -2);
});

test('a killed account never reads as armed, whatever the flag says', () => {
  const summary = riskSummary(armed({ killed: true }), []);
  assert.equal(summary.armed, false);
  assert.equal(summary.killed, true);
});

test('a custom daily limit is respected in both directions', () => {
  const state = armed({ dailyLimitDollars: 8 });
  const result = checkTrade({ state, ...ok, wantDollars: 100 });
  assert.equal(result.dollars, 2, 'a quarter of eight');
  assert.equal(result.limit, 8);
});
