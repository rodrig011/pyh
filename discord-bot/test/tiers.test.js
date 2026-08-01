import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney,
  highestTierCoveredBy,
  includedTiers,
  resolveGrantedTier,
  roleIdsForTier,
} from '../src/lib/tiers.js';

const tiers = {
  1: { tier: 1, priceCents: 5000, roleId: 'rol-1' },
  2: { tier: 2, priceCents: 10000, roleId: 'rol-2' },
  3: { tier: 3, priceCents: 20000, roleId: 'rol-3' },
};

test('los tiers son acumulativos', () => {
  assert.deepEqual(includedTiers(1), [1]);
  assert.deepEqual(includedTiers(2), [1, 2]);
  assert.deepEqual(includedTiers(3), [1, 2, 3]);
});

test('tier 3 otorga los tres roles, tier 2 dos, tier 1 uno', () => {
  assert.deepEqual(roleIdsForTier(3, tiers), ['rol-1', 'rol-2', 'rol-3']);
  assert.deepEqual(roleIdsForTier(2, tiers), ['rol-1', 'rol-2']);
  assert.deepEqual(roleIdsForTier(1, tiers), ['rol-1']);
});

test('roleIdsForTier ignora los roles sin configurar', () => {
  const parcial = { 1: { priceCents: 5000 }, 2: { priceCents: 10000, roleId: 'rol-2' } };
  assert.deepEqual(roleIdsForTier(2, parcial), ['rol-2']);
});

test('formatMoney muestra dolares', () => {
  assert.equal(formatMoney(5000), '$50.00');
  assert.equal(formatMoney(20000), '$200.00');
});

test('highestTierCoveredBy elige el nivel mas alto cubierto', () => {
  assert.equal(highestTierCoveredBy(4999, tiers), null);
  assert.equal(highestTierCoveredBy(5000, tiers), 1);
  assert.equal(highestTierCoveredBy(9999, tiers), 1);
  assert.equal(highestTierCoveredBy(10000, tiers), 2);
  assert.equal(highestTierCoveredBy(25000, tiers), 3);
});

test('un pago exacto otorga el tier comprado', () => {
  assert.deepEqual(resolveGrantedTier({ tier: 2 }, 10000, { tiers }), { ok: true, tier: 2 });
});

test('un pago insuficiente no otorga nada', () => {
  const result = resolveGrantedTier({ tier: 3 }, 10000, { tiers });
  assert.equal(result.ok, false);
  assert.match(result.reason, /insuficiente/);
});

test('la tolerancia permite pagos ligeramente menores', () => {
  assert.equal(resolveGrantedTier({ tier: 1 }, 4900, { tiers }).ok, false);
  assert.equal(resolveGrantedTier({ tier: 1 }, 4900, { tiers, toleranceCents: 100 }).ok, true);
});

test('pagar de mas sube de nivel cuando esta habilitado', () => {
  assert.deepEqual(resolveGrantedTier({ tier: 1 }, 20000, { tiers }), { ok: true, tier: 3 });
  assert.deepEqual(
    resolveGrantedTier({ tier: 1 }, 20000, { tiers, upgradeOnOverpay: false }),
    { ok: true, tier: 1 },
  );
});
