import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYST_GUIDE_MESSAGE, gainedWatchedRole } from '../src/picks/analystOnboarding.js';

test('firing when the analyst role is newly added', () => {
  assert.equal(gainedWatchedRole(['everyone'], ['everyone', 'analyst'], ['analyst']), true);
});

test('not firing when the role was already held', () => {
  assert.equal(gainedWatchedRole(['everyone', 'analyst'], ['everyone', 'analyst'], ['analyst']), false);
});

test('not firing when a DIFFERENT role was added', () => {
  assert.equal(gainedWatchedRole(['everyone'], ['everyone', 'vip'], ['analyst']), false);
});

test('not firing when a role was removed rather than added', () => {
  assert.equal(gainedWatchedRole(['everyone', 'analyst'], ['everyone'], ['analyst']), false);
});

test('never fires with no watched roles configured', () => {
  assert.equal(gainedWatchedRole([], ['analyst'], []), false);
  assert.equal(gainedWatchedRole([], ['analyst'], undefined), false);
});

test('the guide actually explains every button on the console', () => {
  assert.match(ANALYST_GUIDE_MESSAGE, /BUY UP/);
  assert.match(ANALYST_GUIDE_MESSAGE, /BUY DOWN/);
  assert.match(ANALYST_GUIDE_MESSAGE, /\*\*OUT\*\*/);
  assert.match(ANALYST_GUIDE_MESSAGE, /HOLD/);
});
