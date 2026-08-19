import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateRoleProblems, grantTierRoles } from '../src/vip/roles.js';

test('distinct roles per tier raise nothing', () => {
  assert.deepEqual(
    duplicateRoleProblems({
      1: { roleId: 'a' },
      2: { roleId: 'b' },
      3: { roleId: 'c' },
    }),
    [],
  );
});

test('two tiers sharing a role is reported', () => {
  const problems = duplicateRoleProblems({
    1: { roleId: 'same' },
    2: { roleId: 'same' },
    3: { roleId: 'other' },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Tier 2 uses the same role as tier 1/);
  assert.match(problems[0], /identical access/);
});

test('tiers with no role configured are not clashes', () => {
  assert.deepEqual(duplicateRoleProblems({ 1: { roleId: 'a' }, 2: {}, 3: {} }), []);
});

test('every clash is reported, not just the first', () => {
  const problems = duplicateRoleProblems({
    1: { roleId: 'same' },
    2: { roleId: 'same' },
    3: { roleId: 'same' },
  });
  assert.equal(problems.length, 2);
});

// Selling from a DM means a buyer can pay before they have ever joined. The
// membership is real — it is paid for — so nothing may throw on the way there.

test('granting to somebody who is not in the guild reports it instead of throwing', async () => {
  const guild = {
    id: 'g',
    members: { fetch: async () => { throw new Error('Unknown Member'); } },
    roles: { cache: { get: () => ({ id: 'r1' }) }, fetch: async () => ({ id: 'r1' }) },
  };

  const result = await grantTierRoles(guild, 'not-a-member', 1, {
    tiers: { 1: { roleId: 'role-1' } },
  });

  assert.equal(result.absent, true);
  assert.deepEqual(result.added, [], 'nothing was granted, and nothing blew up');
});

test('a member who is present is not reported absent', async () => {
  const added = [];
  const guild = {
    id: 'g',
    members: {
      fetch: async () => ({ roles: { cache: { has: () => false }, add: async (r) => added.push(r.id) } }),
    },
    roles: { cache: { get: (id) => ({ id }) }, fetch: async (id) => ({ id }) },
  };

  const result = await grantTierRoles(guild, 'member', 1, { tiers: { 1: { roleId: 'role-1' } } });

  assert.equal(result.absent, false);
  assert.deepEqual(added, ['role-1']);
});
