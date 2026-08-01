import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateRoleProblems } from '../src/vip/roles.js';

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
