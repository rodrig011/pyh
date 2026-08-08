import test from 'node:test';
import assert from 'node:assert/strict';
import { payerNameModal, payerNamePlaceholder } from '../src/vip/commands.js';

test('the placeholder suggests the buyer\'s own Discord name, not a stranger\'s', () => {
  assert.equal(
    payerNamePlaceholder('Jordan Rivera'),
    'e.g. Jordan Rivera — or the exact name on your bank/Zelle if different',
  );
});

test('with no name to suggest, the placeholder tells you what to type instead of guessing', () => {
  assert.equal(payerNamePlaceholder(null), 'Exactly as it appears on your bank or Zelle app');
});

test('the modal actually carries the suggested placeholder through', () => {
  const config = { tiers: { 1: { label: 'Signals' } } };
  const modal = payerNameModal(1, config, { suggestedName: 'Jordan Rivera' }).toJSON();
  const input = modal.components[0].components[0];
  assert.match(input.placeholder, /Jordan Rivera/);
});
