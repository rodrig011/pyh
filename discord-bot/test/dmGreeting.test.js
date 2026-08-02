import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldGreetDm } from '../src/vip/dmGreeting.js';

// The bot answers strangers unprompted, so the cases that must never fire are
// the ones worth pinning: answering itself, answering in a server, and sending
// three storefronts to somebody who typed three messages.

const config = { dmAutoReply: true, dmReplyCooldownHours: 24, clientId: 'bot-id' };
const now = Date.now();
const hour = 3600000;

const dm = (overrides = {}) => ({
  authorId: 'stranger',
  authorIsBot: false,
  isDirectMessage: true,
  ...overrides,
});

test('a first DM from a stranger is answered', () => {
  const verdict = shouldGreetDm(dm(), config, null, now);
  assert.equal(verdict.reply, true);
});

test('a message in a server is not answered', () => {
  assert.equal(shouldGreetDm(dm({ isDirectMessage: false }), config, null, now).reply, false);
});

test('the bot never answers itself', () => {
  // Without this it replies to its own storefront, then replies to that.
  assert.equal(shouldGreetDm(dm({ authorId: 'bot-id' }), config, null, now).reply, false);
  assert.equal(shouldGreetDm(dm({ authorIsBot: true }), config, null, now).reply, false);
});

test('three messages in a row get one storefront', () => {
  const first = shouldGreetDm(dm(), config, null, now);
  assert.equal(first.reply, true);

  const straightAfter = shouldGreetDm(dm(), config, now, now + 2000);
  assert.equal(straightAfter.reply, false);
  assert.match(straightAfter.reason, /already answered/);
});

test('somebody who comes back the next day is answered again', () => {
  const verdict = shouldGreetDm(dm(), config, now - 25 * hour, now);
  assert.equal(verdict.reply, true);
});

test('the cooldown is configurable, and zero means always answer', () => {
  const short = { ...config, dmReplyCooldownHours: 1 };
  assert.equal(shouldGreetDm(dm(), short, now - 2 * hour, now).reply, true);
  assert.equal(shouldGreetDm(dm(), short, now - 10 * 60000, now).reply, false);

  const always = { ...config, dmReplyCooldownHours: 0 };
  assert.equal(shouldGreetDm(dm(), always, now - 1000, now).reply, true);
});

test('DM_AUTO_REPLY=false switches the whole thing off', () => {
  const off = { ...config, dmAutoReply: false };
  assert.equal(shouldGreetDm(dm(), off, null, now).reply, false);
});
