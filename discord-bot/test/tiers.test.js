import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableTiers,
  formatMoney,
  highestTierCoveredBy,
  includedTiers,
  resolveGrantedTier,
  roleIdsForTier,
} from '../src/lib/tiers.js';

const tiers = {
  1: { tier: 1, priceCents: 5000, roleId: 'role-1' },
  2: { tier: 2, priceCents: 10000, roleId: 'role-2' },
  3: { tier: 3, priceCents: 20000, roleId: 'role-3' },
};

test('tiers stack', () => {
  assert.deepEqual(includedTiers(1), [1]);
  assert.deepEqual(includedTiers(2), [1, 2]);
  assert.deepEqual(includedTiers(3), [1, 2, 3]);
});

test('tier 3 grants all three roles, tier 2 grants two, tier 1 grants one', () => {
  assert.deepEqual(roleIdsForTier(3, tiers), ['role-1', 'role-2', 'role-3']);
  assert.deepEqual(roleIdsForTier(2, tiers), ['role-1', 'role-2']);
  assert.deepEqual(roleIdsForTier(1, tiers), ['role-1']);
});

test('roleIdsForTier skips tiers with no role configured', () => {
  const partial = { 1: { priceCents: 5000 }, 2: { priceCents: 10000, roleId: 'role-2' } };
  assert.deepEqual(roleIdsForTier(2, partial), ['role-2']);
});

test('formatMoney renders dollars', () => {
  assert.equal(formatMoney(5000), '$50.00');
  assert.equal(formatMoney(20000), '$200.00');
});

test('highestTierCoveredBy picks the highest covered tier', () => {
  assert.equal(highestTierCoveredBy(4999, tiers), null);
  assert.equal(highestTierCoveredBy(5000, tiers), 1);
  assert.equal(highestTierCoveredBy(9999, tiers), 1);
  assert.equal(highestTierCoveredBy(10000, tiers), 2);
  assert.equal(highestTierCoveredBy(25000, tiers), 3);
});

test('an exact payment grants the tier that was ordered', () => {
  assert.deepEqual(resolveGrantedTier({ tier: 2 }, 10000, { tiers }), { ok: true, tier: 2 });
});

test('an underpayment grants nothing', () => {
  const result = resolveGrantedTier({ tier: 3 }, 10000, { tiers });
  assert.equal(result.ok, false);
  assert.match(result.reason, /too low/);
});

test('the tolerance allows slightly smaller payments', () => {
  assert.equal(resolveGrantedTier({ tier: 1 }, 4900, { tiers }).ok, false);
  assert.equal(resolveGrantedTier({ tier: 1 }, 4900, { tiers, toleranceCents: 100 }).ok, true);
});

test('overpaying upgrades the tier when enabled', () => {
  assert.deepEqual(resolveGrantedTier({ tier: 1 }, 20000, { tiers }), { ok: true, tier: 3 });
  assert.deepEqual(
    resolveGrantedTier({ tier: 1 }, 20000, { tiers, upgradeOnOverpay: false }),
    { ok: true, tier: 1 },
  );
});

test('availableTiers only lists tiers that have a role configured', () => {
  assert.deepEqual(availableTiers(tiers), [1, 2, 3]);
  assert.deepEqual(availableTiers({ 1: { priceCents: 5000, roleId: 'role-1' }, 2: { priceCents: 10000 } }), [1]);
  assert.deepEqual(availableTiers({ 1: { priceCents: 5000 } }), []);
});

test('overpaying never upgrades into a tier that is still coming soon', () => {
  // Only tier 1 has a role: paying $200 must not grant a tier the bot cannot deliver.
  const onlyTier1 = {
    1: { tier: 1, priceCents: 5000, roleId: 'role-1' },
    2: { tier: 2, priceCents: 10000 },
    3: { tier: 3, priceCents: 20000 },
  };
  assert.deepEqual(resolveGrantedTier({ tier: 1 }, 20000, { tiers: onlyTier1 }), { ok: true, tier: 1 });
  assert.deepEqual(resolveGrantedTier({ tier: 1 }, 20000, { tiers }), { ok: true, tier: 3 });
});
