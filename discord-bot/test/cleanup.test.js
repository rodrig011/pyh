import test from 'node:test';
import assert from 'node:assert/strict';
import { BULK_DELETE_MAX_AGE_MS, planCleanup } from '../src/photo/cleanup.js';

// This function decides what gets destroyed, and a channel's history does not
// come back. Every branch is checked against fixed input.

const config = { allowCaptions: false, allowVideos: false, allowLinks: false, ignoreBots: true };
const now = Date.now();

const photo = (id, extra = {}) => ({
  id,
  createdTimestamp: now - 1000,
  content: '',
  attachments: [{ contentType: 'image/png', name: 'a.png' }],
  ...extra,
});
const text = (id, extra = {}) => ({
  id,
  createdTimestamp: now - 1000,
  content: 'hello',
  attachments: [],
  ...extra,
});

test('text goes and photos stay', () => {
  const plan = planCleanup([photo('1'), text('2'), photo('3')], config, { now });

  assert.deepEqual(plan.remove.map((m) => m.id), ['2']);
  assert.deepEqual(plan.keep.map((m) => m.id), ['1', '3']);
});

test('a photo with a caption goes, since captions are not allowed', () => {
  const plan = planCleanup([photo('1', { content: 'nice' })], config, { now });
  assert.equal(plan.remove.length, 1);
});

test('the same photo stays once captions are allowed', () => {
  const plan = planCleanup([photo('1', { content: 'nice' })], { ...config, allowCaptions: true }, { now });
  assert.equal(plan.keep.length, 1);
});

test('pinned messages are kept even when they are text', () => {
  const plan = planCleanup([text('1', { pinned: true }), text('2')], config, { now });

  assert.deepEqual(plan.keep.map((m) => m.id), ['1'], 'the pin survived');
  assert.deepEqual(plan.remove.map((m) => m.id), ['2']);
});

test('keepPinned:false sweeps pinned text away too', () => {
  const plan = planCleanup([text('1', { pinned: true })], config, { now, keepPinned: false });
  assert.equal(plan.remove.length, 1);
});

test('messages are split by what Discord will bulk-delete', () => {
  const old = text('old', { createdTimestamp: now - BULK_DELETE_MAX_AGE_MS - 1 });
  const fresh = text('fresh', { createdTimestamp: now - 1000 });

  const plan = planCleanup([old, fresh], config, { now });

  assert.deepEqual(plan.recent.map((m) => m.id), ['fresh']);
  assert.deepEqual(plan.old.map((m) => m.id), ['old']);
  assert.equal(plan.recent.length + plan.old.length, plan.remove.length, 'nothing is lost between the two');
});

test('system messages and bot posts are left alone', () => {
  const plan = planCleanup(
    [text('1', { isSystem: true }), text('2', { authorIsBot: true })],
    config,
    { now },
  );
  assert.equal(plan.remove.length, 0);
});

test('an empty channel produces an empty plan rather than an error', () => {
  const plan = planCleanup([], config, { now });
  assert.deepEqual(plan, { remove: [], keep: [], skipped: 0, recent: [], old: [] });
});

// Role filters decide who is in scope at all, before the photo rule gets a say.

const MOD = 'role-mod';
const TIER1 = 'role-tier-1';

const from = (id, roleIds, extra = {}) => text(id, { memberRoleIds: roleIds, ...extra });

test("except_from keeps a role's messages even when they are plain text", () => {
  const plan = planCleanup([from('mod', [MOD]), from('member', [TIER1])], config, {
    now,
    exceptRoleIds: [MOD],
  });

  assert.deepEqual(plan.remove.map((m) => m.id), ['member']);
  assert.deepEqual(plan.keep.map((m) => m.id), ['mod']);
  assert.equal(plan.skipped, 1);
});

test('only_from restricts the sweep to one role and leaves everyone else', () => {
  const plan = planCleanup(
    [from('vip', [TIER1]), from('nobody', []), from('mod', [MOD])],
    config,
    { now, onlyRoleIds: [TIER1] },
  );

  assert.deepEqual(plan.remove.map((m) => m.id), ['vip']);
  assert.equal(plan.skipped, 2, 'the other two were out of scope');
});

test('except_from wins over only_from when a member holds both', () => {
  const plan = planCleanup([from('both', [MOD, TIER1])], config, {
    now,
    onlyRoleIds: [TIER1],
    exceptRoleIds: [MOD],
  });

  assert.equal(plan.remove.length, 0, 'the exemption is the safer reading');
});

test('a member who has left is never swept by only_from', () => {
  // No member object means no roles, so they can never match — and deleting the
  // history of someone who is gone is exactly what nobody asked for.
  const plan = planCleanup([text('gone')], config, { now, onlyRoleIds: [TIER1] });

  assert.equal(plan.remove.length, 0);
  assert.equal(plan.skipped, 1);
});

test('the role filters never rescue a breach they do not cover', () => {
  const plan = planCleanup([from('vip', [TIER1])], config, { now, exceptRoleIds: [MOD] });
  assert.deepEqual(plan.remove.map((m) => m.id), ['vip']);
});

test('with no role filter nothing is skipped', () => {
  const plan = planCleanup([text('1'), photo('2')], config, { now });
  assert.equal(plan.skipped, 0);
});

// Both panels post into a channel that is normally locked, so they share one
// permission check rather than each rediscovering the same failure.
import { missingPostPermissions, postPermissionHelp } from '../src/lib/channelAccess.js';
import { PermissionFlagsBits } from 'discord.js';

function channelWhere(allowed) {
  return {
    name: 'how-to-buy-vip',
    toString: () => '#how-to-buy-vip',
    permissionsFor: () => ({ has: (flag) => allowed.includes(flag) }),
  };
}

const guild = { members: { me: { id: 'bot' } } };
const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

test('a channel the bot can post in reports nothing missing', () => {
  assert.deepEqual(missingPostPermissions(channelWhere(ALL), guild), []);
  assert.equal(postPermissionHelp(channelWhere(ALL), guild), null);
});

test('a locked channel names each missing permission and the channel', () => {
  const help = postPermissionHelp(channelWhere([PermissionFlagsBits.ViewChannel]), guild);

  assert.match(help, /Send Messages/);
  assert.match(help, /Embed Links/);
  assert.match(help, /how-to-buy-vip/);
});

test('a channel with no permission data is not reported as broken', () => {
  assert.deepEqual(missingPostPermissions({}, guild), []);
  assert.deepEqual(missingPostPermissions(channelWhere(ALL), {}), []);
});

test('one named person can be spared without inventing a role for them', () => {
  const messages = [text('1', { authorId: 'kenson' }), text('2', { authorId: 'someone' })];
  const plan = planCleanup(messages, config, { now, exceptUserIds: ['kenson'] });

  assert.deepEqual(
    plan.remove.map((message) => message.id),
    ['2'],
  );
  assert.equal(plan.skipped, 1);
});

test('sparing a person beats a role filter that would have caught them', () => {
  const messages = [text('1', { authorId: 'kenson', memberRoleIds: ['tier1'] })];
  const plan = planCleanup(messages, config, {
    now,
    onlyRoleIds: ['tier1'],
    exceptUserIds: ['kenson'],
  });

  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep.length, 1);
});

test('only_person narrows the sweep to that one member', () => {
  const messages = [text('1', { authorId: 'kenson' }), text('2', { authorId: 'someone' })];
  const plan = planCleanup(messages, config, { now, onlyUserIds: ['kenson'] });

  assert.deepEqual(
    plan.remove.map((message) => message.id),
    ['1'],
  );
});

test('with both only filters set, matching either one puts a message in scope', () => {
  const messages = [
    text('1', { authorId: 'kenson' }),
    text('2', { memberRoleIds: ['tier1'] }),
    text('3', { authorId: 'stranger' }),
  ];
  const plan = planCleanup(messages, config, { now, onlyUserIds: ['kenson'], onlyRoleIds: ['tier1'] });

  assert.deepEqual(
    plan.remove.map((message) => message.id),
    ['1', '2'],
  );
  assert.equal(plan.skipped, 1);
});

test('a pinned message survives even the person filters', () => {
  const plan = planCleanup([text('1', { authorId: 'kenson', pinned: true })], config, {
    now,
    onlyUserIds: ['kenson'],
  });

  assert.deepEqual(plan.remove, []);
});
