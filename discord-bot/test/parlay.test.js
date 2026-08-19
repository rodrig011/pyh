import test from 'node:test';
import assert from 'node:assert/strict';
import { PARLAY_OUTCOMES, buildParlay, parlayLeaderboard, parlayRecord, settleParlay } from '../src/picks/parlay.js';

const base = { analystId: 'a1', analystTag: 'Ana#0001', guildId: 'g', legs: 'Lakers -4.5, Over 220' };

test('buildParlay refuses a parlay with no legs', () => {
  assert.throws(() => buildParlay({ ...base, legs: '  ' }));
});

test('buildParlay refuses one with nobody attached to it', () => {
  assert.throws(() => buildParlay({ ...base, analystId: null }));
});

test('a fresh parlay is unsettled', () => {
  const parlay = buildParlay(base);
  assert.equal(parlay.outcome, null);
  assert.equal(parlay.settledAt, null);
});

test('settleParlay records the outcome and when', () => {
  const parlay = buildParlay(base);
  const settled = settleParlay(parlay, PARLAY_OUTCOMES.WIN, { now: 12345 });
  assert.equal(settled.outcome, 'win');
  assert.equal(settled.settledAt, 12345);
});

test('settleParlay ignores a nonsense outcome rather than corrupting the record', () => {
  const parlay = buildParlay(base);
  assert.equal(settleParlay(parlay, 'maybe'), parlay);
});

test('parlayRecord counts wins and losses, and treats a push as neither', () => {
  const parlays = [
    settleParlay(buildParlay(base), PARLAY_OUTCOMES.WIN),
    settleParlay(buildParlay(base), PARLAY_OUTCOMES.WIN),
    settleParlay(buildParlay(base), PARLAY_OUTCOMES.LOSS),
    settleParlay(buildParlay(base), PARLAY_OUTCOMES.PUSH),
    buildParlay(base), // never settled — must not count either way
  ];
  const record = parlayRecord(parlays, 'a1');
  assert.deepEqual(record, { wins: 2, losses: 1, pushes: 1, decided: 3, winRate: 2 / 3 });
});

test('parlayRecord for somebody with nothing decided yet has no win rate', () => {
  assert.deepEqual(parlayRecord([], 'a1'), { wins: 0, losses: 0, pushes: 0, decided: 0, winRate: null });
});

test('parlayLeaderboard ranks by win rate, best first, and drops anyone with nothing decided', () => {
  const other = { ...base, analystId: 'a2', analystTag: 'Ben#0002' };
  const parlays = [
    settleParlay(buildParlay(base), PARLAY_OUTCOMES.WIN),
    settleParlay(buildParlay(base), PARLAY_OUTCOMES.LOSS),
    settleParlay(buildParlay(other), PARLAY_OUTCOMES.WIN),
    settleParlay(buildParlay(other), PARLAY_OUTCOMES.WIN),
    buildParlay({ ...base, analystId: 'a3' }), // never decided, must not appear
  ];
  const board = parlayLeaderboard(parlays);
  assert.deepEqual(
    board.map((row) => row.analystId),
    ['a2', 'a1'],
  );
  assert.equal(board.find((row) => row.analystId === 'a2').winRate, 1);
});
