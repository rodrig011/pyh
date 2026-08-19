import { createServer } from 'node:http';
import { createLogger } from '../lib/logger.js';

const log = createLogger('stripe-hook');

function readRawBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * Minimal HTTP endpoint for Stripe webhooks.
 *
 * Signature verification is the whole point: without it, anyone who finds the
 * URL could POST a fake "payment succeeded" and hand themselves a role. Events
 * that fail verification are rejected before they are even parsed.
 *
 * Returning a non-2xx makes Stripe retry, which is what we want when handling
 * fails — the event is not lost.
 */
export function startStripeWebhookServer({ config, stripe, onEvent }) {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }

    if (request.method !== 'POST' || request.url !== config.stripe.webhookPath) {
      response.writeHead(404);
      response.end();
      return;
    }

    let event;
    try {
      const raw = await readRawBody(request);
      event = stripe.webhooks.constructEvent(
        raw,
        request.headers['stripe-signature'],
        config.stripe.webhookSecret,
      );
    } catch (error) {
      log.warn(`Rejected webhook: ${error.message}`);
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end(`invalid signature: ${error.message}`);
      return;
    }

    try {
      await onEvent(event);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"received":true}');
    } catch (error) {
      log.error(`Handling ${event.type} failed: ${error.stack ?? error.message}`);
      // 500 tells Stripe to retry later.
      response.writeHead(500);
      response.end();
    }
  });

  server.listen(config.stripe.port, () => {
    log.info(`Listening on :${config.stripe.port}${config.stripe.webhookPath}`);
  });

  server.on('error', (error) => log.error(`Webhook server error: ${error.message}`));
  return server;
}
