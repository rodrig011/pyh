import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { describeChannel, isMissingCommandScope } from '../src/photo/setupCheck.js';

// "Watching 1 photos-only channel(s)" counted entries in an environment
// variable. A wrong id, a channel in another server and a channel the bot
// cannot see all produced that same reassuring line while nothing was policed.

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

const botMember = { id: 'bot' };

function channelWith(allowed, extra = {}) {
  return {
    name: 'photos',
    guild: { name: 'King T Parlays' },
    isTextBased: () => true,
    permissionsFor: () => ({ has: (flag) => allowed.includes(flag) }),
    ...extra,
  };
}

test('an id that resolves to nothing is called out, not counted', () => {
  const result = describeChannel('12345', null, botMember);

  assert.equal(result.ok, false);
  assert.match(result.label, /no such channel/);
  assert.match(result.label, /not in that server/, 'and says the likely reason');
});

test('a channel the bot can police reports its name and server', () => {
  const result = describeChannel('12345', channelWith(ALL), botMember);

  assert.equal(result.ok, true);
  assert.match(result.label, /#photos/);
  assert.match(result.label, /King T Parlays/);
});

test('a channel the bot cannot delete in is not reported as watched', () => {
  const result = describeChannel('12345', channelWith([PermissionFlagsBits.ViewChannel]), botMember);

  assert.equal(result.ok, false);
  assert.match(result.label, /Manage Messages/);
  assert.match(result.label, /Read Message History/);
});

test('a voice channel is refused rather than silently watched', () => {
  const voice = channelWith(ALL, { isTextBased: () => false });
  const result = describeChannel('12345', voice, botMember);

  assert.equal(result.ok, false);
  assert.match(result.label, /not a text channel/);
});

test('the missing-scope failure is told apart from every other one', () => {
  // It is fixed by re-inviting, not by anything in the code, so it needs
  // different advice from a generic API error.
  assert.equal(isMissingCommandScope(new Error('Missing Access')), true);
  assert.equal(isMissingCommandScope({ code: 50001 }), true);
  assert.equal(isMissingCommandScope(new Error('Service Unavailable')), false);
  assert.equal(isMissingCommandScope(null), false);
});

test('a channel it can police but not speak in is a warning, not a failure', () => {
  const channel = {
    name: 'profits',
    guild: { name: 'King T parlays' },
    isTextBased: () => true,
    permissionsFor: () => ({
      has: (flag) => flag !== PermissionFlagsBits.SendMessages,
    }),
  };

  const verdict = describeChannel('1', channel, {}, { warn: true });
  assert.equal(verdict.ok, true);
  assert.match(verdict.label, /Send Messages/);
  assert.match(verdict.label, /^⚠️/);
});

test('no Send Messages is not worth mentioning when the notice is off', () => {
  const channel = {
    name: 'profits',
    guild: { name: 'King T parlays' },
    isTextBased: () => true,
    permissionsFor: () => ({
      has: (flag) => flag !== PermissionFlagsBits.SendMessages,
    }),
  };

  const verdict = describeChannel('1', channel, {}, { warn: false });
  assert.equal(verdict.ok, true);
  assert.match(verdict.label, /^✅/);
});
