import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSection } from '../src/vip/commands.js';

const config = { subscriptionDays: 30 };

test('with Stripe off it teases the method and never mentions a button', () => {
  const lines = cardSection(false, config, 5000).join('\n');
  assert.match(lines, /coming soon/i);
  assert.match(lines, /Zelle/);
  assert.doesNotMatch(lines, /button/i, 'there is no button to press yet');
});

test('with Stripe on it explains the recurring charge and points at the button', () => {
  const lines = cardSection(true, config, 5000).join('\n');
  assert.match(lines, /\$50\.00 every 30 days/);
  assert.match(lines, /button below/);
  assert.doesNotMatch(lines, /coming soon/i);
});
