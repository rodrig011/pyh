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
  assert.deepEqual(plan, { remove: [], keep: [], recent: [], old: [] });
});
