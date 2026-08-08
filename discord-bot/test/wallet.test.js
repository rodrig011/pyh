import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCents, walletBalances } from '../src/vip/wallet.js';

test('splitCents divides evenly, remainder to the first in line', () => {
  assert.deepEqual(splitCents(100, 5), [20, 20, 20, 20, 20]);
  assert.deepEqual(splitCents(103, 5), [21, 21, 21, 20, 20]);
});

test('splitCents is empty with nothing to split or nobody to split it with', () => {
  assert.deepEqual(splitCents(0, 5), []);
  assert.deepEqual(splitCents(100, 0), []);
});

test('walletBalances sums every payment across the whole team, and the shares add up', () => {
  const team = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  const payments = [{ amountCents: 5000 }, { amountCents: 10000 }, { amountCents: null }];
  const wallet = walletBalances(payments, team);

  assert.equal(wallet.paidCount, 2);
  assert.equal(wallet.totalCents, 15000);
  assert.equal(wallet.balances.find((m) => m.id === 'a').cents, 7500);
  assert.equal(wallet.balances.find((m) => m.id === 'b').cents, 7500);
});

test('walletBalances is all zeros with no payments yet', () => {
  const team = [{ id: 'a', name: 'A' }];
  const wallet = walletBalances([], team);
  assert.equal(wallet.paidCount, 0);
  assert.equal(wallet.balances[0].cents, 0);
});
