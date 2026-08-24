import test from 'node:test';
import assert from 'node:assert/strict';
import { confluenceRead } from '../src/signals/confluence.js';

function movingBtcTape() {
  const prices = [];
  let price = 65_000;
  let state = 12345;
  for (let i = 0; i < 120; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    price *= Math.exp((state / 4294967296 - 0.5) * 0.0028);
    prices.push(price);
  }
  return prices;
}

test('ordinary BTC movement is not mislabeled as a squeeze that suppresses every call', () => {
  const read = confluenceRead({ prices: movingBtcTape() });
  assert.equal(read.squeeze, false);
  assert.equal(read.lean, 'up');
  assert.ok(read.indicators.bollingerWidthPercent > 0.1);
});

test('a genuinely flat BTC tape still stays neutral', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 65_000 + Math.sin(i) * 2);
  const read = confluenceRead({ prices });
  assert.equal(read.squeeze, true);
  assert.equal(read.lean, null);
});
