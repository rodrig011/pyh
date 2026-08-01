import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import Stripe from 'stripe';
import { startStripeWebhookServer } from '../src/payments/stripeWebhook.js';

const SECRET = 'whsec_test_secret';
const stripe = new Stripe('sk_test_not_a_real_key');

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function startServer(t, onEvent) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = { stripe: { port, webhookPath: '/stripe/webhook', webhookSecret: SECRET } };
  const server = startStripeWebhookServer({ config, stripe, onEvent });
  t.after(() => server.close());
  return new Promise((resolve) => server.once('listening', () => resolve({ port })));
}

const payload = JSON.stringify({
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: { object: { mode: 'subscription', payment_status: 'paid', client_reference_id: 'VIP-7K3QDM' } },
});

test('a properly signed event is accepted and handed to the bot', async (t) => {
  const seen = [];
  const { port } = await startServer(t, async (event) => seen.push(event.type));

  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const response = await post(port, '/stripe/webhook', payload, { 'stripe-signature': signature });

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['checkout.session.completed']);
});

test('a forged event is rejected — this is what stops free roles', async (t) => {
  const seen = [];
  const { port } = await startServer(t, async (event) => seen.push(event.type));

  const forged = await post(port, '/stripe/webhook', payload, { 'stripe-signature': 't=1,v1=deadbeef' });
  const unsigned = await post(port, '/stripe/webhook', payload);

  assert.equal(forged.status, 400);
  assert.equal(unsigned.status, 400);
  assert.deepEqual(seen, [], 'the handler never runs for unverified payloads');
});

test('an event signed with the wrong secret is rejected', async (t) => {
  const seen = [];
  const { port } = await startServer(t, async (event) => seen.push(event.type));

  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_someone_elses' });
  const response = await post(port, '/stripe/webhook', payload, { 'stripe-signature': signature });

  assert.equal(response.status, 400);
  assert.deepEqual(seen, []);
});

test('a handler failure returns 500 so Stripe retries instead of dropping the payment', async (t) => {
  const { port } = await startServer(t, async () => {
    throw new Error('database is down');
  });

  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const response = await post(port, '/stripe/webhook', payload, { 'stripe-signature': signature });

  assert.equal(response.status, 500);
});

test('other paths are not the webhook', async (t) => {
  const { port } = await startServer(t, async () => {});
  const response = await post(port, '/', payload);
  assert.equal(response.status, 404);
});
