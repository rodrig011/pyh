import test from 'node:test';
import assert from 'node:assert/strict';
import { payerNameModal, payerNamePlaceholder, suggestedPayerName } from '../src/vip/commands.js';

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

test('suggestedPayerName offers a real-looking display name', () => {
  const interaction = { member: { displayName: 'Jordan Rivera' }, user: { username: 'jr420' } };
  assert.equal(suggestedPayerName(interaction), 'Jordan Rivera');
});

test('suggestedPayerName says nothing for a handle, at any of the three name fields', () => {
  assert.equal(suggestedPayerName({ member: { displayName: 'xX_King420_Xx' }, user: {} }), null);
  assert.equal(suggestedPayerName({ member: null, user: { globalName: 'Deadshot99' } }), null);
  assert.equal(suggestedPayerName({ member: null, user: { username: 'lil_baller' } }), null);
});

test('suggestedPayerName falls back from member nickname to global name to username', () => {
  assert.equal(
    suggestedPayerName({ member: null, user: { globalName: 'Jordan Rivera', username: 'jr420' } }),
    'Jordan Rivera',
  );
  assert.equal(suggestedPayerName({ member: null, user: { globalName: null, username: 'Jordan Rivera' } }), 'Jordan Rivera');
});
