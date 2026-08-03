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

// Adopting one named person, for somebody verified by hand.
import { planIndividualAdoption, tierFromRoles } from '../src/vip/subscriptions.js';

const tiersConfig = {
  1: { roleId: 'role-1' },
  2: { roleId: 'role-2' },
  3: { roleId: 'role-3' },
};
const untracked = () => false;

test('the tier is read from the highest role held, since tiers stack', () => {
  // A tier 3 member carries all three roles; taking the lowest would demote them.
  assert.equal(tierFromRoles(['role-1', 'role-2', 'role-3'], tiersConfig), 3);
  assert.equal(tierFromRoles(['role-1'], tiersConfig), 1);
  assert.equal(tierFromRoles(['something-else'], tiersConfig), null);
  assert.equal(tierFromRoles([], tiersConfig), null);
});

test('a named member is adopted at the tier their role says', () => {
  const plan = planIndividualAdoption(
    { id: 'u1', isBot: false, roleIds: ['role-1', 'role-2'] },
    { tiersConfig, hasActiveSubscription: untracked },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.tier, 2);
});

test('an explicit tier overrides whatever roles they hold', () => {
  const plan = planIndividualAdoption(
    { id: 'u1', isBot: false, roleIds: ['role-1'] },
    { tiersConfig, tier: 3, hasActiveSubscription: untracked },
  );

  assert.equal(plan.tier, 3);
});

test('staff are adopted when named, unlike in the bulk sweep', () => {
  // Skipping mods in bulk stops their own role reading as a paid membership.
  // Naming somebody says the checking already happened.
  const plan = planIndividualAdoption(
    { id: 'mod1', isBot: false, roleIds: ['role-2', 'mod-role'] },
    { tiersConfig, hasActiveSubscription: untracked },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.tier, 2);
});

test('somebody with no tier role and no tier given is refused with a reason', () => {
  const plan = planIndividualAdoption(
    { id: 'u1', isBot: false, roleIds: [] },
    { tiersConfig, hasActiveSubscription: untracked },
  );

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'no_tier');
});

test('somebody already tracked is not adopted twice', () => {
  const plan = planIndividualAdoption(
    { id: 'u1', isBot: false, roleIds: ['role-2'] },
    { tiersConfig, hasActiveSubscription: () => true },
  );

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'already_tracked');
  assert.equal(plan.tier, 2, 'and still says which tier they are on');
});

test('a bot is never adopted', () => {
  const plan = planIndividualAdoption(
    { id: 'bot1', isBot: true, roleIds: ['role-3'] },
    { tiersConfig, hasActiveSubscription: untracked },
  );

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'bot');
});

test('a tier that is not configured is refused', () => {
  const plan = planIndividualAdoption(
    { id: 'u1', isBot: false, roleIds: [] },
    { tiersConfig, tier: 9, hasActiveSubscription: untracked },
  );

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'unknown_tier');
});
