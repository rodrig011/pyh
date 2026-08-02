import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_SOURCES,
  fetchSpotPrice,
  formatChange,
  formatPrice,
  gradeByPrice,
  readPrice,
} from '../src/picks/price.js';

// The exchange response shapes, pinned. These are what the parser is written
// against, so a change in any of them fails here rather than silently returning
// null and dropping every call back to manual grading.

const BODIES = {
  coinbase: { data: { base: 'BTC', currency: 'USD', amount: '97213.45' } },
  kraken: { error: [], result: { XXBTZUSD: { c: ['97213.45', '0.01'] } } },
  binance: { symbol: 'BTCUSDT', price: '97213.45000000' },
};

for (const source of PRICE_SOURCES) {
  test(`${source.name}: the price is read out of a real response body`, () => {
    assert.equal(readPrice(source, BODIES[source.name]), 97213.45);
  });

  test(`${source.name}: a body of the wrong shape yields null, not NaN`, () => {
    assert.equal(readPrice(source, {}), null);
    assert.equal(readPrice(source, { data: {} }), null);
  });

  test(`${source.name}: the URL carries the asset`, () => {
    assert.match(source.url('BTC'), /BTC/);
  });
}

test('a zero or negative price is refused', () => {
  const coinbase = PRICE_SOURCES[0];
  assert.equal(readPrice(coinbase, { data: { amount: '0' } }), null);
  assert.equal(readPrice(coinbase, { data: { amount: '-5' } }), null);
});

test('the first working source wins', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('coinbase')) throw new Error('down');
    return { ok: true, json: async () => BODIES.kraken };
  };

  const result = await fetchSpotPrice('BTC', { fetchImpl });
  assert.equal(result.source, 'kraken');
  assert.equal(result.price, 97213.45);
  assert.match(result.problems[0], /coinbase/);
});

test('every source failing returns null rather than throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('no network');
  };

  const result = await fetchSpotPrice('BTC', { fetchImpl });
  assert.equal(result.price, null);
  assert.equal(result.problems.length, PRICE_SOURCES.length, 'each failure is reported');
});

test('an HTTP error is reported and moves on to the next source', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, status: 429, json: async () => ({}) }
      : { ok: true, json: async () => BODIES.kraken };
  };

  const result = await fetchSpotPrice('BTC', { fetchImpl });
  assert.equal(result.price, 97213.45);
  assert.match(result.problems[0], /429/);
});

// Grading.

test('an up call that went up is a win, and the reverse is a loss', () => {
  assert.equal(gradeByPrice('up', 100000, 100500).outcome, 'win');
  assert.equal(gradeByPrice('up', 100000, 99500).outcome, 'loss');
  assert.equal(gradeByPrice('down', 100000, 99500).outcome, 'win');
  assert.equal(gradeByPrice('down', 100000, 100500).outcome, 'loss');
});

test('a move too small to matter is flat, not a win', () => {
  // One dollar on a hundred thousand is 0.001%: calling that correct would
  // inflate every record on the board.
  assert.equal(gradeByPrice('up', 100000, 100001).outcome, 'break_even');
  assert.equal(gradeByPrice('down', 100000, 100001).outcome, 'break_even');
});

test('the dead band is adjustable and respected on both sides', () => {
  assert.equal(gradeByPrice('up', 100000, 100400, 0.5).outcome, 'break_even');
  assert.equal(gradeByPrice('up', 100000, 100600, 0.5).outcome, 'win');
});

test('a missing or nonsensical price grades nothing at all', () => {
  assert.equal(gradeByPrice('up', null, 100), null);
  assert.equal(gradeByPrice('up', 100, undefined), null);
  assert.equal(gradeByPrice('up', 0, 100), null);
});

test('the change is reported with its sign', () => {
  assert.equal(formatChange(gradeByPrice('up', 100000, 100500).changePercent), '+0.5%');
  assert.equal(formatChange(gradeByPrice('up', 100000, 99500).changePercent), '-0.5%');
  assert.equal(formatPrice(97213.45), '$97,213.45');
  assert.equal(formatPrice(null), '—');
});
