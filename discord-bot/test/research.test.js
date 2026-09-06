import test from 'node:test';
import assert from 'node:assert/strict';
import { researchExport, tradeDiagnostics } from '../src/signals/research.js';

test('research groups actual fees, net losses and repeated contracts without inventing reasons', () => {
  const trades = [
    { ticker: 'T', profit: -2, fees: 0.2, forced: true, reason: 'model_flipped' },
    { ticker: 'T', profit: 1, fees: 0.1, forced: true, reason: 'model_flipped' },
  ];
  const result = tradeDiagnostics(trades);
  assert.equal(result.groups[0].profit, -1);
  assert.equal(result.groups[0].wins, 1);
  assert.equal(result.repeatedMarkets[0].trades, 2);
  assert.equal(result.missingEntryEvidence, 2);
});

test('export is read-only and excludes account secrets and payment data', () => {
  const account = { start: 100, cash: 2, userId: 'private-user', privateKey: 'secret', trades: [] };
  const result = researchExport({ paperAccounts: () => ({ always: account }), listQuotes: () => [] });
  assert.equal(result.profiles.always.cash, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-user|secret/);
  assert.equal(account.cash, 2);
});
