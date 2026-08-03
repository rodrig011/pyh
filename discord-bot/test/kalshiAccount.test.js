import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, constants } from 'node:crypto';
import {
  READABLE_PATHS,
  authHeaders,
  foldFills,
  hasCredentials,
  newFills,
  readAccount,
  signRequest,
  sizePercentOf,
} from '../src/picks/kalshiAccount.js';

// This file holds a credential that can spend the analyst's money. Everything
// here is checked against fixed input, including the things it must refuse.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  keyId: 'key-1',
  privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

test('the signature covers the timestamp, the method and the path', () => {
  const signature = signRequest(credentials, {
    method: 'GET',
    path: '/trade-api/v2/portfolio/fills',
    timestamp: '1700000000000',
  });

  const verifier = createVerify('RSA-SHA256');
  verifier.update('1700000000000GET/trade-api/v2/portfolio/fills');
  verifier.end();

  assert.ok(
    verifier.verify(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature,
      'base64',
    ),
  );
});

test('a signature for one path does not authenticate another', () => {
  const forFills = signRequest(credentials, {
    method: 'GET',
    path: '/trade-api/v2/portfolio/fills',
    timestamp: '1700000000000',
  });

  const verifier = createVerify('RSA-SHA256');
  verifier.update('1700000000000GET/trade-api/v2/portfolio/orders');
  verifier.end();

  assert.equal(
    verifier.verify(
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      forFills,
      'base64',
    ),
    false,
  );
});

test('every header Kalshi expects is sent', () => {
  const headers = authHeaders(credentials, { method: 'GET', path: '/x', now: 1700000000000 });

  assert.equal(headers['KALSHI-ACCESS-KEY'], 'key-1');
  assert.equal(headers['KALSHI-ACCESS-TIMESTAMP'], '1700000000000');
  assert.ok(headers['KALSHI-ACCESS-SIGNATURE'].length > 0);
});

test('nothing outside the read-only list is ever signed', async () => {
  for (const path of ['/portfolio/orders', '/markets/x/order', '/portfolio/fills/../orders']) {
    const result = await readAccount({ ...credentials }, path, {
      fetchImpl: () => assert.fail('a write path must never reach the network'),
    });
    assert.match(result.error, /refusing to sign/);
  }

  assert.deepEqual(READABLE_PATHS, ['/portfolio/fills', '/portfolio/positions', '/portfolio/balance']);
});

test('no credentials means no request, not a broken one', async () => {
  const result = await readAccount({ keyId: 'k' }, '/portfolio/fills', {
    fetchImpl: () => assert.fail('should not reach the network'),
  });

  assert.match(result.error, /no Kalshi account credentials/);
  assert.equal(hasCredentials({ keyId: 'k' }), false);
  assert.equal(hasCredentials(credentials), true);
});

// Partial fills are the normal case on a scalp, not the exception.
const fills = [
  { ticker: 'KXBTC15M-A', side: 'no', action: 'buy', count: 10, yes_price_dollars: '0.60', created_time: '2026-08-03T06:20:00Z' },
  { ticker: 'KXBTC15M-A', side: 'no', action: 'buy', count: 10, yes_price_dollars: '0.62', created_time: '2026-08-03T06:20:30Z' },
  { ticker: 'KXBTC15M-A', side: 'no', action: 'sell', count: 20, yes_price_dollars: '0.75', created_time: '2026-08-03T06:26:00Z' },
  { ticker: 'OTHER-B', side: 'yes', action: 'buy', count: 5, yes_price_dollars: '0.40', created_time: '2026-08-03T06:21:00Z' },
];

test('partial fills fold into one position at the average price paid', () => {
  const [position] = foldFills(fills, { seriesTicker: 'KXBTC15M' });

  assert.equal(position.contracts, 20);
  assert.equal(position.entryCents, 61);
  assert.equal(position.exitCents, 75);
  assert.equal(position.isOpen, false);
  assert.equal(Math.round(position.returnPercent), 23);
});

test('a NO position is a DOWN call', () => {
  const [position] = foldFills(fills, { seriesTicker: 'KXBTC15M' });
  assert.equal(position.direction, 'down');
});

test('markets outside the series are left alone', () => {
  assert.equal(foldFills(fills, { seriesTicker: 'KXBTC15M' }).length, 1);
  assert.equal(foldFills(fills).length, 2);
});

test('a position still holding contracts is open, with no exit invented', () => {
  const [position] = foldFills(fills.slice(0, 2), { seriesTicker: 'KXBTC15M' });

  assert.equal(position.isOpen, true);
  assert.equal(position.openContracts, 20);
  assert.equal(position.exitCents, null);
  assert.equal(position.returnPercent, null);
  assert.equal(position.closedAt, null);
});

test('a cursor stops the same trade being announced twice', () => {
  const since = Date.parse('2026-08-03T06:20:30Z');
  assert.equal(newFills(fills, since).length, 2);
  assert.equal(newFills(fills, null).length, 4);
});

test('the size of a position is measured, not claimed', () => {
  const position = { entryCents: 61, contracts: 20 };
  // $12.20 in, $12.20 left: half the book.
  assert.equal(sizePercentOf(position, 1220), 50);
  assert.equal(sizePercentOf(position, 0), null);
  assert.equal(sizePercentOf(null, 5000), null);
});
