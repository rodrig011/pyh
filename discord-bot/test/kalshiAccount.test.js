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

// This decides what gets published to a paying room as somebody's trades.
const openPosition = {
  ticker: 'KXBTC15M-A',
  direction: 'up',
  entryCents: 39,
  exitCents: null,
  isOpen: true,
  contracts: 10,
};
const closedPosition = { ...openPosition, isOpen: false, exitCents: 50, returnPercent: 28.2 };

test('a position the room has not been told about is opened once', async () => {
  const { planPublication } = await import('../src/picks/kalshiAccount.js');

  assert.equal(planPublication([openPosition], []).open.length, 1);

  // Already published: seen again on the next poll, and not announced twice.
  const existing = [{ id: 'p1', marketTicker: 'KXBTC15M-A', outcome: null }];
  assert.equal(planPublication([openPosition], existing).open.length, 0);
});

test('a call is closed only against the position on its own market', async () => {
  const { planPublication } = await import('../src/picks/kalshiAccount.js');
  const picks = [
    { id: 'p1', marketTicker: 'KXBTC15M-A', outcome: null },
    { id: 'p2', marketTicker: 'KXBTC15M-B', outcome: null },
  ];

  const plan = planPublication([closedPosition], picks);
  assert.equal(plan.close.length, 1);
  assert.equal(plan.close[0].pick.id, 'p1');
});

test('a call already settled is never closed again', async () => {
  const { planPublication } = await import('../src/picks/kalshiAccount.js');
  const picks = [{ id: 'p1', marketTicker: 'KXBTC15M-A', outcome: 'win' }];

  assert.equal(planPublication([closedPosition], picks).close.length, 0);
  // And it is not reopened either.
  assert.equal(planPublication([openPosition], picks).open.length, 0);
});

test('a closed position with no exit price closes nothing', async () => {
  const { planPublication } = await import('../src/picks/kalshiAccount.js');
  const picks = [{ id: 'p1', marketTicker: 'KXBTC15M-A', outcome: null }];

  assert.equal(planPublication([{ ...closedPosition, exitCents: null }], picks).close.length, 0);
});

test('nothing at all is planned from an empty account', async () => {
  const { planPublication } = await import('../src/picks/kalshiAccount.js');
  const plan = planPublication([], []);

  assert.deepEqual(plan.open, []);
  assert.deepEqual(plan.close, []);
});

test('nothing is published while the switch is off', async () => {
  const { syncKalshiAccount } = await import('../src/picks/commands.js');

  const result = await syncKalshiAccount(
    {},
    { listPicks: () => [] },
    {
      guildId: 'g',
      picks: { kalshi: { account: { ...credentials, autoPublish: false } } },
    },
    { fetchImpl: () => assert.fail('a switched-off sync must not reach the network') },
  );

  assert.deepEqual(result, { published: 0, closed: 0 });
});

test('publishing without credentials does nothing rather than half-working', async () => {
  const { syncKalshiAccount } = await import('../src/picks/commands.js');

  const result = await syncKalshiAccount(
    {},
    { listPicks: () => [] },
    { guildId: 'g', picks: { kalshi: { account: { autoPublish: true } } } },
    { fetchImpl: () => assert.fail('should not reach the network') },
  );

  assert.deepEqual(result, { published: 0, closed: 0 });
});

test('the balance is read once a minute, not on every pass', async () => {
  const { syncKalshiAccount } = await import('../src/picks/commands.js');

  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(new URL(url).pathname);
    return { ok: true, json: async () => ({ fills: [], balance: 1000 }) };
  };

  const config = {
    guildId: 'g',
    picks: { kalshi: { account: { ...credentials, autoPublish: true, seriesTicker: 'KXBTC15M' } } },
  };
  const store = { listPicks: () => [] };

  const now = Date.now();
  await syncKalshiAccount({}, store, config, { fetchImpl, now });
  await syncKalshiAccount({}, store, config, { fetchImpl, now: now + 2000 });
  await syncKalshiAccount({}, store, config, { fetchImpl, now: now + 4000 });

  const fills = asked.filter((path) => path.endsWith('/fills')).length;
  const balances = asked.filter((path) => path.endsWith('/balance')).length;

  assert.equal(fills, 3, 'fills are read on every pass — that is the whole point');
  assert.equal(balances, 1, 'the balance moves slowly and is cached');
});

test('only the newest fills are asked for, so the poll stays cheap', async () => {
  const { syncKalshiAccount } = await import('../src/picks/commands.js');

  let seen = null;
  const fetchImpl = async (url) => {
    if (url.includes('/fills')) seen = url;
    return { ok: true, json: async () => ({ fills: [], balance: 1000 }) };
  };

  await syncKalshiAccount(
    {},
    { listPicks: () => [] },
    { guildId: 'g', picks: { kalshi: { account: { ...credentials, autoPublish: true } } } },
    { fetchImpl, now: Date.now() + 120_000 },
  );

  assert.match(seen, /limit=25/);
});
