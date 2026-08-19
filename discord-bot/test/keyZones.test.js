import test from 'node:test';
import assert from 'node:assert/strict';
import { findKeyZones, matchingZone } from '../src/signals/keyZones.js';

test('a support/resistance level and a fair value gap edge at the same price form a key zone', () => {
  const levels = [{ type: 'resistance', price: 65000, touches: 4, quality: 80 }];
  const fairValueGaps = [{ bias: 'bearish', high: 65004, low: 64950 }];

  const zones = findKeyZones({ levels, fairValueGaps });
  assert.equal(zones.length, 1);
  assert.ok(zones[0].sources.includes('resistance'));
  assert.ok(zones[0].sources.includes('bearish fvg'));
});

test('two support/resistance levels alone are never a key zone -- there is no second independent source', () => {
  const levels = [
    { type: 'resistance', price: 65000, touches: 4, quality: 80 },
    { type: 'support', price: 64000, touches: 2, quality: 60 },
  ];
  assert.deepEqual(findKeyZones({ levels }), []);
});

test('two fair value gaps alone are never a key zone either', () => {
  const fairValueGaps = [
    { bias: 'bullish', high: 65004, low: 64950 },
    { bias: 'bearish', high: 63500, low: 63400 },
  ];
  assert.deepEqual(findKeyZones({ fairValueGaps }), []);
});

test('a level and a gap that do not actually overlap are not clustered together', () => {
  const levels = [{ type: 'support', price: 64000, touches: 2, quality: 60 }];
  const fairValueGaps = [{ bias: 'bullish', high: 70000, low: 69900 }];
  assert.deepEqual(findKeyZones({ levels, fairValueGaps }), []);
});

test('empty or missing inputs return no zones rather than throwing', () => {
  assert.deepEqual(findKeyZones({}), []);
  assert.deepEqual(findKeyZones(), []);
});

test('matchingZone finds the zone nearest a given price within tolerance', () => {
  const zones = [{ price: 65000, sources: ['resistance', 'bearish fvg'] }];
  assert.ok(matchingZone(zones, 65010));
  assert.equal(matchingZone(zones, 70000), null);
  assert.equal(matchingZone(zones, NaN), null);
});
