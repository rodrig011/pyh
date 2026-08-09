import { createServer } from 'node:http';
import { createLogger } from '../lib/logger.js';
import { openBoard } from '../picks/kalshi.js';
import { fetchSpotPrice } from '../picks/price.js';
import { fetchTrades } from '../picks/whales.js';
import { computeRead, enterManualPosition } from './read.js';
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
 * A page for looking at the model's current call from a browser instead of
 * Discord, plus two small write endpoints for tracking a position entered by
 * hand elsewhere (Kalshi's own app, say). Never places a real order — the
 * only thing it ever writes is "I'm in, watch this for me."
 */
export function startDashboardServer({ store, config, deps = {} }) {
  const boardFetch = deps.openBoard ?? openBoard;
  const priceFetch = deps.fetchSpotPrice ?? fetchSpotPrice;
  const tradesFetch = deps.fetchTrades ?? fetchTrades;
  const dashboard = config.dashboard ?? {};
  const page = dashboardPage(config.brandName ?? 'Live Read');

  function respondJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  function authorized(request, url) {
    const token = request.headers['x-dashboard-token'] ?? url.searchParams.get('token');
    return isAuthorized(token, dashboard.token);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname === '/api/read') {
      if (!authorized(request, url)) return respondJson(response, 401, { ok: false, reason: 'unauthorized' });

      try {
        const read = await computeRead(store, config, {
          openBoard: boardFetch,
          fetchSpotPrice: priceFetch,
          fetchTrades: tradesFetch,
        });
        respondJson(response, 200, read);
      } catch (error) {
        log.error(`Read failed: ${error.message}`);
        respondJson(response, 200, { ok: false, reason: 'internal error' });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/enter') {
      if (!authorized(request, url)) return respondJson(response, 401, { ok: false, reason: 'unauthorized' });

      const side = url.searchParams.get('side');
      try {
        const result = await enterManualPosition(store, config, side, { openBoard: boardFetch, fetchSpotPrice: priceFetch });
        respondJson(response, result.ok ? 200 : 400, result);
      } catch (error) {
        log.error(`Manual entry failed: ${error.message}`);
        respondJson(response, 200, { ok: false, reason: 'internal error' });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/exit') {
      if (!authorized(request, url)) return respondJson(response, 401, { ok: false, reason: 'unauthorized' });
      store.clearDashboardPosition();
      respondJson(response, 200, { ok: true });
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
