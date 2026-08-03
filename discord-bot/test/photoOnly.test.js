import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMessage, isImageAttachment } from '../src/photo/photoOnly.js';

const photo = { contentType: 'image/png', name: 'photo.png' };

test('recognizes images by content type and by extension', () => {
  assert.equal(isImageAttachment(photo), true);
  assert.equal(isImageAttachment({ name: 'photo.JPG' }), true);
  assert.equal(isImageAttachment({ name: 'document.pdf' }), false);
  assert.equal(isImageAttachment({}), false);
});

test('a photo on its own is allowed', () => {
  assert.equal(evaluateMessage({ attachments: [photo] }).allowed, true);
});

test('text on its own is deleted', () => {
  const verdict = evaluateMessage({ content: 'hi everyone' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'no_image');
});

test('an empty message with no attachments is deleted', () => {
  assert.equal(evaluateMessage({ content: '   ' }).allowed, false);
});

test('a photo with text is deleted by default and allowed with captions on', () => {
  const message = { content: 'look at this', attachments: [photo] };
  const strict = evaluateMessage(message);
  assert.equal(strict.allowed, false);
  assert.equal(strict.reason, 'text_not_allowed');
  assert.equal(evaluateMessage(message, { allowCaptions: true }).allowed, true);
});

test('a file that is not an image is deleted', () => {
  const verdict = evaluateMessage({ attachments: [{ contentType: 'application/pdf', name: 'x.pdf' }] });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'attachment_not_an_image');
});

test('videos only pass when explicitly enabled', () => {
  const message = { attachments: [{ contentType: 'video/mp4', name: 'clip.mp4' }] };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { allowVideos: true }).allowed, true);
});

test('image links only pass when explicitly enabled', () => {
  const message = { content: 'https://example.com/photo.png', embeds: [{ type: 'image' }] };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { allowLinks: true, allowCaptions: true }).allowed, true);
});

test('bots and system messages are left alone', () => {
  assert.equal(evaluateMessage({ authorIsBot: true, content: 'notice' }).allowed, true);
  assert.equal(evaluateMessage({ authorIsBot: true, content: 'notice' }, { ignoreBots: false }).allowed, false);
  assert.equal(evaluateMessage({ isSystem: true, content: 'joined the server' }).allowed, true);
});

test('bypass roles may post text', () => {
  const message = { content: 'moderating', memberRoleIds: ['mod'] };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { bypassRoleIds: ['mod'] }).allowed, true);
  assert.equal(evaluateMessage(message, { bypassRoleIds: ['other'] }).allowed, false);
});

test('a named person may post text without holding any role', () => {
  const message = { authorId: 'kenson', content: 'gm' };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { bypassUserIds: ['kenson'] }).allowed, true);
  assert.equal(evaluateMessage(message, { bypassUserIds: ['someone-else'] }).allowed, false);
});

test('an unknown author is never mistaken for an exempt one', () => {
  assert.equal(evaluateMessage({ content: 'gm' }, { bypassUserIds: ['kenson'] }).allowed, false);
});
