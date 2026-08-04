import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPACITY, appendSample, collectOnce, historyQuality, pricesSince } from '../src/signals/collector.js';

// This runs two thousand times a day beside the code that handles money, and
// everything the engine claims is computed from what it wrote down.

test('samples accumulate in order', () => {
  let samples = [];
  samples = appendSample(samples, { at: 1000, price: 65000 });
  samples = appendSample(samples, { at: 2000, price: 65010 });

  assert.equal(samples.length, 2);
  assert.deepEqual(pricesSince(samples, 0), [65000, 65010]);
});

test('an out-of-order or repeated tick is refused, not appended', () => {
  const samples = appendSample(appendSample([], { at: 2000, price: 65000 }), { at: 1000, price: 64000 });

  // Returns computed across a backwards timestamp are nonsense, and every
  // probability downstream would inherit it.
  assert.equal(samples.length, 1);
  assert.equal(appendSample(samples, { at: 2000, price: 1 }).length, 1);
});

test('rubbish never gets written down', () => {
  assert.equal(appendSample([], { at: 1000, price: 0 }).length, 0);
  assert.equal(appendSample([], { at: 1000, price: -5 }).length, 0);
  assert.equal(appendSample([], { price: 65000 }).length, 0);
  assert.equal(appendSample([], null).length, 0);
});

test('the buffer has a hard ceiling, because the volume also holds the payments', () => {
  let samples = [];
  for (let i = 0; i < DEFAULT_CAPACITY + 500; i += 1) {
    samples = appendSample(samples, { at: i * 1000, price: 65000 + i });
  }

  assert.equal(samples.length, DEFAULT_CAPACITY);
  // The newest survive; the oldest are the ones dropped.
  assert.equal(samples.at(-1).price, 65000 + DEFAULT_CAPACITY + 499);
});

test('a hole in the history is caught rather than measured across', () => {
  const clean = Array.from({ length: 30 }, (_, i) => ({ at: i * 30_000, price: 65000 }));
  const holed = [...clean];
  holed[15] = { at: holed[14].at + 5 * 60_000, price: 65000 };
  for (let i = 16; i < holed.length; i += 1) holed[i] = { at: holed[i - 1].at + 30_000, price: 65000 };

  assert.equal(historyQuality(clean).ok, true);

  const verdict = historyQuality(holed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /gap/);
});

test('too little history is not enough history', () => {
  const short = Array.from({ length: 5 }, (_, i) => ({ at: i * 30_000, price: 65000 }));
  assert.equal(historyQuality(short).ok, false);
  assert.match(historyQuality(short).reason, /needed/);
});

test('one pass reads a price and writes it down', async () => {
  const stored = {};
  const store = {
    listSamples: (asset) => stored[asset] ?? [],
    putSamples: (asset, samples) => {
      stored[asset] = samples;
    },
  };

  const result = await collectOnce(store, {
    fetchPrice: async () => ({ price: 65123.45, source: 'coinbase' }),
    now: 1000,
  });

  assert.equal(result.added, true);
  assert.equal(stored.BTC.length, 1);
  assert.equal(stored.BTC[0].price, 65123.45);
});

test('a feed that is down costs a sample, never the bot', async () => {
  const store = { listSamples: () => [], putSamples: () => assert.fail('nothing to write') };

  const thrown = await collectOnce(store, {
    fetchPrice: async () => {
      throw new Error('coinbase is down');
    },
  });
  const empty = await collectOnce(store, { fetchPrice: async () => ({ price: null }) });

  assert.equal(thrown.added, false);
  assert.match(thrown.reason, /coinbase is down/);
  assert.equal(empty.added, false);
});
