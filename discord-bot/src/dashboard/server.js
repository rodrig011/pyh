import { createServer } from 'node:http';
import { createLogger } from '../lib/logger.js';
import { openBoard } from '../picks/kalshi.js';
import { fetchSpotPrice } from '../picks/price.js';
import { computeRead } from './read.js';
import { dashboardPage } from './page.js';

const log = createLogger('dashboard');

/**
 * Whether this request is allowed to see the read.
 *
 * No token configured means no gate — fine for a first look, wrong for a
 * dashboard showing the exact calls people pay for. `DASHBOARD_TOKEN` is
 * checked as a simple shared secret against a header, nothing fancier: this
 * is one person looking at their own screen, not a multi-user login system.
 */
export function isAuthorized(requestToken, configuredToken) {
  if (!configuredToken) return true;
  return requestToken === configuredToken;
}

/**
 * A read-only page and a JSON endpoint behind it, for looking at the model's
 * current call from a browser instead of Discord. Never places an order,
 * never touches the store beyond reading price samples — this cannot affect
 * trading even if the page is left open and forgotten.
 */
export function startDashboardServer({ store, config, deps = {} }) {
  const boardFetch = deps.openBoard ?? openBoard;
  const priceFetch = deps.fetchSpotPrice ?? fetchSpotPrice;
  const dashboard = config.dashboard ?? {};
  const page = dashboardPage(config.brandName ?? 'Live Read');

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname === '/api/read') {
      const token = request.headers['x-dashboard-token'] ?? url.searchParams.get('token');
      if (!isAuthorized(token, dashboard.token)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, reason: 'unauthorized' }));
        return;
      }

      try {
        const read = await computeRead(store, config, { openBoard: boardFetch, fetchSpotPrice: priceFetch });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(read));
      } catch (error) {
        log.error(`Read failed: ${error.message}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, reason: 'internal error' }));
      }
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(dashboard.port, () => {
    log.info(
      `Dashboard listening on :${dashboard.port}` +
        (dashboard.token ? ' (token required)' : ' (⚠️ no DASHBOARD_TOKEN set — anyone with the URL can see it)'),
    );
  });

  server.on('error', (error) => log.error(`Dashboard server error: ${error.message}`));
  return server;
}
