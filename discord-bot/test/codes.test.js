import test from 'node:test';
import assert from 'node:assert/strict';
import { ALPHABET, extractCodes, generateCode, normalizeCode } from '../src/lib/codes.js';

test('generateCode produces codes in the expected format', () => {
  const code = generateCode();
  assert.match(code, /^VIP-[A-Z0-9]{6}$/);
  for (const char of code.slice(4)) assert.ok(ALPHABET.includes(char));
});

test('generateCode avoids collisions through isTaken', () => {
  const taken = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode({ isTaken: (candidate) => taken.has(candidate) });
    assert.ok(!taken.has(code));
    taken.add(code);
  }
  assert.equal(taken.size, 200);
});

test('generateCode never uses ambiguous characters', () => {
  for (let i = 0; i < 300; i += 1) {
    const body = generateCode({ length: 10 }).slice(4);
    assert.ok(!/[OIL01]/.test(body), `ambiguous code: ${body}`);
  }
});

test('normalizeCode accepts lowercase, spaces and separators', () => {
  assert.equal(normalizeCode('vip-7k3qdm'), 'VIP-7K3QDM');
  assert.equal(normalizeCode('VIP 7K3 QDM'), 'VIP-7K3QDM');
  assert.equal(normalizeCode('vip7k3qdm'), 'VIP-7K3QDM');
});

test('normalizeCode rejects invalid codes', () => {
  assert.equal(normalizeCode('VIP-7K3QD'), null, 'too short');
  assert.equal(normalizeCode('ABC-7K3QDM'), null, 'wrong prefix');
  assert.equal(normalizeCode('VIP-7K3QD0'), null, 'character outside the alphabet');
  assert.equal(normalizeCode(null), null);
});

test('extractCodes finds the code inside free-form text', () => {
  assert.deepEqual(extractCodes('Payment memo: VIP-7K3QDM thanks!'), ['VIP-7K3QDM']);
  assert.deepEqual(extractCodes('memo vip 7k3qdm'), ['VIP-7K3QDM']);
  assert.deepEqual(extractCodes('payment<br>VIP-<b>7K3QDM</b>'), ['VIP-7K3QDM']);
});

test('extractCodes returns several codes without duplicates', () => {
  const codes = extractCodes('VIP-7K3QDM and also VIP-AAAA22 and again vip-7k3qdm');
  assert.equal(codes.length, 2);
  assert.ok(codes.includes('VIP-7K3QDM'));
  assert.ok(codes.includes('VIP-AAAA22'));
});

test('extractCodes does not invent codes that are not there', () => {
  assert.deepEqual(extractCodes('thanks for the payment!'), []);
  assert.deepEqual(extractCodes('VIP membership'), []);
  assert.deepEqual(extractCodes(''), []);
});
