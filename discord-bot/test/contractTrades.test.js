import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/store.js';

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trades-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, 'store.json'));
}

test('recordContractTrades stores trades under the ticker they came from', (t) => {
  const store = tempStore(t);
  store.recordContractTrades('K-1', [{ at: 1000, count: 50, side: 'yes', priceCents: 45 }]);
  assert.equal(store.listContractTrades('K-1').length, 1);
  assert.equal(store.listContractTrades('K-2').length, 0);
});

test('recordContractTrades deduplicates the same trade seen twice', (t) => {
  const store = tempStore(t);
  const trade = { at: 1000, count: 50, side: 'yes', priceCents: 45 };
  store.recordContractTrades('K-1', [trade]);
  store.recordContractTrades('K-1', [trade]);
  assert.equal(store.listContractTrades('K-1').length, 1);
});

test('recordContractTrades adds genuinely new trades alongside old ones', (t) => {
  const store = tempStore(t);
  store.recordContractTrades('K-1', [{ at: 1000, count: 50, side: 'yes', priceCents: 45 }]);
  store.recordContractTrades('K-1', [{ at: 2000, count: 30, side: 'no', priceCents: 55 }]);
  assert.equal(store.listContractTrades('K-1').length, 2);
});

test('recordContractTrades does nothing with an empty list or no ticker', (t) => {
  const store = tempStore(t);
  store.recordContractTrades('K-1', []);
  store.recordContractTrades(null, [{ at: 1, count: 1, side: 'yes' }]);
  assert.equal(store.listContractTrades('K-1').length, 0);
});
