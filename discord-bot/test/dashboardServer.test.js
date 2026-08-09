import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { isAuthorized, startDashboardServer } from '../src/dashboard/server.js';

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
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
