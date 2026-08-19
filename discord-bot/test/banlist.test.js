import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banAlertText, isBanned } from '../src/vip/banlist.js';

test('isBanned matches an id on the list', () => {
  assert.equal(isBanned('123', ['123', '456']), true);
  assert.equal(isBanned('789', ['123', '456']), false);
});

test('isBanned is false with no list configured', () => {
  assert.equal(isBanned('123', undefined), false);
  assert.equal(isBanned('123', []), false);
});

test('banAlertText names the id, not just the tag', () => {
  const member = { id: '123', user: { tag: 'ghost#0001' } };
  const text = banAlertText(member);
  assert.match(text, /123/);
  assert.match(text, /ghost#0001/);
});
