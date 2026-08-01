import test from 'node:test';
import assert from 'node:assert/strict';
import { planAdoption } from '../src/vip/subscriptions.js';

const options = (tracked = []) => ({
  roleId: 'tier2',
  modRoleIds: ['mod'],
  hasActiveSubscription: (id) => tracked.includes(id),
});

test('members holding the role with no membership are adopted', () => {
  const plan = planAdoption(
    [
      { id: 'a', roleIds: ['tier2'] },
      { id: 'b', roleIds: ['tier2', 'other'] },
      { id: 'c', roleIds: ['other'] },
    ],
    options(),
  );
  assert.deepEqual(plan.adopt, ['a', 'b']);
});

test('members already tracked are left alone, so it is safe to run twice', () => {
  const plan = planAdoption([{ id: 'a', roleIds: ['tier2'] }], options(['a']));
  assert.deepEqual(plan.adopt, []);
  assert.deepEqual(plan.skipped.tracked, ['a']);
});

test('staff and bots are never given a countdown', () => {
  const plan = planAdoption(
    [
      { id: 'mod1', roleIds: ['tier2', 'mod'] },
      { id: 'bot1', roleIds: ['tier2'], isBot: true },
      { id: 'member', roleIds: ['tier2'] },
    ],
    options(),
  );
  assert.deepEqual(plan.adopt, ['member']);
  assert.deepEqual(plan.skipped.staff, ['mod1']);
  assert.deepEqual(plan.skipped.bots, ['bot1']);
});

test('nobody holding the role means nothing to do', () => {
  const plan = planAdoption([{ id: 'a', roleIds: ['tier1'] }], options());
  assert.deepEqual(plan.adopt, []);
});
