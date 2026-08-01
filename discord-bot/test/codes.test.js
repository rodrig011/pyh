import test from 'node:test';
import assert from 'node:assert/strict';
import { ALPHABET, extractCodes, generateCode, normalizeCode } from '../src/lib/codes.js';

test('generateCode produce codigos con el formato esperado', () => {
  const code = generateCode();
  assert.match(code, /^VIP-[A-Z0-9]{6}$/);
  for (const char of code.slice(4)) assert.ok(ALPHABET.includes(char));
});

test('generateCode evita colisiones usando isTaken', () => {
  const taken = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode({ isTaken: (candidate) => taken.has(candidate) });
    assert.ok(!taken.has(code));
    taken.add(code);
  }
  assert.equal(taken.size, 200);
});

test('generateCode no usa caracteres ambiguos', () => {
  for (let i = 0; i < 300; i += 1) {
    const body = generateCode({ length: 10 }).slice(4);
    assert.ok(!/[OIL01]/.test(body), `codigo ambiguo: ${body}`);
  }
});

test('normalizeCode acepta minusculas, espacios y separadores', () => {
  assert.equal(normalizeCode('vip-7k3qdm'), 'VIP-7K3QDM');
  assert.equal(normalizeCode('VIP 7K3 QDM'), 'VIP-7K3QDM');
  assert.equal(normalizeCode('vip7k3qdm'), 'VIP-7K3QDM');
});

test('normalizeCode rechaza codigos invalidos', () => {
  assert.equal(normalizeCode('VIP-7K3QD'), null, 'demasiado corto');
  assert.equal(normalizeCode('ABC-7K3QDM'), null, 'prefijo incorrecto');
  assert.equal(normalizeCode('VIP-7K3QD0'), null, 'caracter fuera del alfabeto');
  assert.equal(normalizeCode(null), null);
});

test('extractCodes encuentra el codigo dentro de un texto libre', () => {
  assert.deepEqual(extractCodes('Nota del pago: VIP-7K3QDM gracias!'), ['VIP-7K3QDM']);
  assert.deepEqual(extractCodes('memo vip 7k3qdm'), ['VIP-7K3QDM']);
  assert.deepEqual(extractCodes('pago<br>VIP-<b>7K3QDM</b>'), ['VIP-7K3QDM']);
});

test('extractCodes devuelve varios codigos sin duplicados', () => {
  const codes = extractCodes('VIP-7K3QDM y tambien VIP-AAAA22 y otra vez vip-7k3qdm');
  assert.equal(codes.length, 2);
  assert.ok(codes.includes('VIP-7K3QDM'));
  assert.ok(codes.includes('VIP-AAAA22'));
});

test('extractCodes no inventa codigos donde no los hay', () => {
  assert.deepEqual(extractCodes('gracias por el pago!'), []);
  assert.deepEqual(extractCodes('VIP membership'), []);
  assert.deepEqual(extractCodes(''), []);
});
