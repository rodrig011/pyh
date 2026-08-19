import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeAFullName, nameMatches, normalizeName } from '../src/lib/names.js';

// A wrong match here hands a stranger a paid membership. A missed one only
// costs a mod one button press. The asymmetry is the whole design.

test('normalizeName strips case, accents and punctuation', () => {
  assert.equal(normalizeName('  Chris  Swails-Jr. '), 'CHRIS SWAILS JR');
  assert.equal(normalizeName('José Peña'), 'JOSE PENA');
  assert.equal(normalizeName(null), '');
});

test('the same name written differently still matches', () => {
  assert.ok(nameMatches('Christopher Swails', 'CHRISTOPHER SWAILS'));
  assert.ok(nameMatches('christopher swails', 'Christopher  Swails'));
  assert.ok(nameMatches('José Peña', 'JOSE PENA'));
});

test('a shortened first name matches its full form', () => {
  assert.ok(nameMatches('Chris Swails', 'CHRISTOPHER SWAILS'));
  assert.ok(nameMatches('CHRISTOPHER SWAILS', 'Chris Swails'));
});

test('a surname on its own matches, since there is nothing else to compare', () => {
  assert.ok(nameMatches('Swails', 'CHRISTOPHER SWAILS'));
});

test('different surnames never match, however alike the first names', () => {
  assert.equal(nameMatches('Chris Swails', 'Chris Thielen'), false);
  assert.equal(nameMatches('Christopher Swails', 'Christopher Smith'), false);
});

test('different people sharing a surname do not match', () => {
  assert.equal(nameMatches('Maria Swails', 'Christopher Swails'), false);
});

test('a two-letter stub is not enough to match on', () => {
  // "JO" must not sweep up every Jonathan, Joseph and Joanna in the server.
  assert.equal(nameMatches('Jo Swails', 'Jonathan Swails'), false);
  assert.ok(nameMatches('Jon Swails', 'Jonathan Swails'));
});

test('empty or missing names never match', () => {
  assert.equal(nameMatches('', 'Chris Swails'), false);
  assert.equal(nameMatches('Chris Swails', null), false);
  assert.equal(nameMatches('   ', '  '), false);
});

test('looksLikeAFullName accepts a plain first-and-last name', () => {
  assert.ok(looksLikeAFullName('Jordan Rivera'));
  assert.ok(looksLikeAFullName("Mary-Jane O'Brien"));
  assert.ok(looksLikeAFullName('Maria de la Cruz'));
});

test('looksLikeAFullName rejects Discord handles, not just human names', () => {
  assert.equal(looksLikeAFullName('xX_King420_Xx'), false, 'digits and underscores');
  assert.equal(looksLikeAFullName('Chris'), false, 'one word, could be a first-name-only handle');
  assert.equal(looksLikeAFullName('🔥 Deadshot 🔥'), false, 'emoji');
  assert.equal(looksLikeAFullName(''), false);
  assert.equal(looksLikeAFullName(null), false);
  assert.equal(looksLikeAFullName('a b c d e'), false, 'too many words to plausibly be a name');
});
