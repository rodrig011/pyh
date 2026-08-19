import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { isAuthorized, startDashboardServer } from '../src/dashboard/server.js';

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const priceHistory = Array.from({ length: 90 }, (_, i) => 65_000 + Math.sin(i / 3) * 40);

function mutableStore() {
  let dashboardPosition = null;
  return {
    listSamples: () => priceHistory.map((price, i) => ({ at: Date.now() - i * 1000, price })),
    riskState: () => null,
    dashboardPosition: () => dashboardPosition,
    setDashboardPosition: (p) => { dashboardPosition = p; return p; },
    clearDashboardPosition: () => { dashboardPosition = null; },
    listTradeOrders: () => [],
  };
}

test('isAuthorized is open with no token configured', () => {
  assert.equal(isAuthorized(undefined, undefined), true);
  assert.equal(isAuthorized('anything', undefined), true);
});

test('isAuthorized requires an exact match once a token is set', () => {
  assert.equal(isAuthorized('secret', 'secret'), true);
  assert.equal(isAuthorized('wrong', 'secret'), false);
  assert.equal(isAuthorized(undefined, 'secret'), false);
});

function startServer(t, { token = null } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = {
    brandName: 'Test Room',
    picks: { defaultAsset: 'BTC', kalshi: { enabled: false } },
    dashboard: { enabled: true, port, token },
  };
  const store = { listSamples: () => [] };
  const server = startDashboardServer({ store, config });
  t.after(() => server.close());
  return new Promise((resolve) => server.once('listening', () => resolve({ port })));
}

test('the page loads and mentions the brand name', async (t) => {
  const { port } = await startServer(t);
  const response = await get(port, '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /Test Room/);
});

test('the page is never cached — a phone holding yesterday\'s HTML looks exactly like a live bug', async (t) => {
  const { port } = await startServer(t);
  const response = await get(port, '/');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('the read endpoint answers with a reason when Kalshi is off', async (t) => {
  const { port } = await startServer(t);
  const response = await get(port, '/api/read');
  const body = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.match(body.reason, /not enabled/);
});

test('a token-gated dashboard refuses a request with no token', async (t) => {
  const { port } = await startServer(t, { token: 'shh' });
  const response = await get(port, '/api/read');
  assert.equal(response.status, 401);
});

test('a token-gated dashboard accepts the right header', async (t) => {
  const { port } = await startServer(t, { token: 'shh' });
  const response = await get(port, '/api/read', { 'x-dashboard-token': 'shh' });
  assert.equal(response.status, 200);
});

test('an unknown path is a plain 404, not the page', async (t) => {
  const { port } = await startServer(t);
  const response = await get(port, '/whatever');
  assert.equal(response.status, 404);
});

function startServerWithDeps(t, { token = null, openBoard, fetchSpotPrice } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = {
    brandName: 'Test Room',
    picks: { defaultAsset: 'BTC', kalshi: { enabled: true, seriesTicker: 'KXBTC15M' } },
    dashboard: { enabled: true, port, token },
  };
  const store = mutableStore();
  const server = startDashboardServer({ store, config, deps: { openBoard, fetchSpotPrice } });
  t.after(() => server.close());
  return new Promise((resolve) => server.once('listening', () => resolve({ port, store })));
}

const boardWithOneMarket = async () => ({
  contracts: [
    {
      price: 50,
      market: {
        ticker: 'K-1',
        floor_strike: 65_000,
        close_time: new Date(Date.now() + 500_000).toISOString(),
        yes_bid_dollars: '0.49',
        yes_ask_dollars: '0.51',
        liquidity_dollars: '4000',
      },
    },
  ],
});

test('POST /api/enter records a manual position the store can read back', async (t) => {
  const { port, store } = await startServerWithDeps(t, {
    openBoard: boardWithOneMarket,
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });

  const response = await post(port, '/api/enter?side=up');
  const body = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(store.dashboardPosition().side, 'up');
});

test('POST /api/enter requires the token like the read endpoint does', async (t) => {
  const { port } = await startServerWithDeps(t, {
    token: 'shh',
    openBoard: boardWithOneMarket,
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });

  const response = await post(port, '/api/enter?side=up');
  assert.equal(response.status, 401);
});

test('POST /api/exit clears whatever was entered by hand', async (t) => {
  const { port, store } = await startServerWithDeps(t, {
    openBoard: boardWithOneMarket,
    fetchSpotPrice: async () => ({ price: 65_000 }),
  });

  await post(port, '/api/enter?side=down');
  assert.ok(store.dashboardPosition());

  const response = await post(port, '/api/exit');
  assert.equal(response.status, 200);
  assert.equal(store.dashboardPosition(), null);
});
