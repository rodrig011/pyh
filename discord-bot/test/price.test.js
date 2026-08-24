import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  PRICE_SOURCES,
  fetchBrtiPrice,
  fetchSpotPrice,
  formatChange,
  formatPrice,
  gradeByPrice,
  readBrti,
  readPrice,
} from '../src/picks/price.js';

test('Kalshi BRTI is used before every exchange fallback', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const kalshiCredentials = {
    keyId: 'read-only-test',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    apiBase: 'https://example.test/trade-api/v2',
  };
  const calls = [];
  const result = await fetchSpotPrice('BTC', {
    kalshiCredentials,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ data: { payload: { value: '68123.45' } } }) };
    },
  });
  assert.equal(result.price, 68123.45);
  assert.equal(result.source, 'kalshi-brti');
  assert.equal(calls.length, 1, 'no exchange fallback was mixed into a successful BRTI read');
});

test('BRTI parser accepts the documented wrapped value shapes', () => {
  assert.equal(readBrti({ data: { payload: { value: '68000.12' } } }), 68000.12);
  assert.equal(readBrti({ data: { payload: { values: { BRTI: { value: '68001.25' } } } } }), 68001.25);
  assert.equal(readBrti({ data: { payload: {} } }), null);
});

test('the legacy Kalshi host is upgraded for the BRTI passthrough', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  let requested = null;
  const result = await fetchBrtiPrice({
    keyId: 'read-only-test',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    apiBase: 'https://api.elections.kalshi.com/trade-api/v2',
  }, {
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, json: async () => ({ data: { payload: { value: '68111.22' } } }) };
    },
  });
  assert.match(requested, /^https:\/\/external-api\.kalshi\.com/);
  assert.equal(result.source, 'kalshi-brti');
});

test('BTC stays out instead of silently switching from Kalshi to Coinbase', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  let calls = 0;
  const result = await fetchSpotPrice('BTC', {
    kalshiCredentials: {
      keyId: 'read-only-test',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 403, text: async () => 'not entitled' };
    },
  });
  assert.equal(result.price, null);
  assert.equal(result.source, 'kalshi-brti');
  assert.equal(calls, 1, 'Coinbase and other exchanges were never queried');
});

// The exchange response shapes, pinned. These are what the parser is written
// against, so a change in any of them fails here rather than silently returning
// null and dropping every call back to manual grading.

// `constituent` says whether the venue is actually inside the CME CF index
// Kalshi settles against. A price from outside it is grading the contract on a
// number the exchange never looks at, so the order of this list matters.
const BODIES = {
  coinbase: { data: { base: 'BTC', currency: 'USD', amount: '97213.45' } },
  kraken: { error: [], result: { XXBTZUSD: { c: ['97213.45', '0.01'] } } },
  binance: { symbol: 'BTCUSDT', price: '97213.45000000' },
  bitstamp: { last: '97213.45', open: '96800.00', pair: 'BTC/USD' },
  gemini: { last: '97213.45', bid: '97213.00', ask: '97214.00' },
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
    // Some venues want the pair lower-cased, so the check is on the symbol
    // being present at all rather than on its casing.
    assert.match(source.url('BTC'), /BTC/i);
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

  const result = await fetchSpotPrice('BTC', { fetchImpl, allowExchangeFallback: true });
  assert.equal(result.source, 'kraken');
  assert.equal(result.price, 97213.45);
  assert.match(result.problems[0], /coinbase/);
});

test('every source failing returns null rather than throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('no network');
  };

  const result = await fetchSpotPrice('BTC', { fetchImpl, allowExchangeFallback: true });
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

  const result = await fetchSpotPrice('BTC', { fetchImpl, allowExchangeFallback: true });
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

test('a move is written to one decimal, not three', () => {
  // "-25.373%" beside a price reads as a machine talking to itself.
  assert.equal(formatChange(-25.373), '-25.4%');
  assert.equal(formatChange(28.1666), '+28.2%');
  assert.equal(formatChange(0), '0.0%');
  assert.equal(formatChange(null), '—');
});

test('the preferred sources are the ones Kalshi actually settles against', () => {
  // Kalshi resolves crypto contracts on the CME CF Real-Time Index, a
  // volume-weighted median across a fixed set of constituent exchanges.
  // Reading a venue outside that set means grading a contract against a
  // number the exchange never looks at — so non-constituents must never be
  // preferred over constituents.
  const firstNonConstituent = PRICE_SOURCES.findIndex((source) => !source.constituent);
  const lastConstituent = PRICE_SOURCES.map((s) => s.constituent).lastIndexOf(true);

  assert.ok(PRICE_SOURCES[0].constituent, 'the first source must be in the index');
  assert.ok(
    firstNonConstituent === -1 || firstNonConstituent > lastConstituent,
    'a venue outside the settlement index is being tried before one inside it',
  );

  // Binance in particular quotes against a stablecoin rather than dollars, so
  // it carries a basis of its own on top of not being in the index.
  const binance = PRICE_SOURCES.find((source) => source.name === 'binance');
  assert.equal(binance.constituent, false);
  assert.match(binance.url('BTC'), /USDT/);
});
