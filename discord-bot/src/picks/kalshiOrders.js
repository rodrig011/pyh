import { randomUUID } from 'node:crypto';
import { DEFAULT_API_BASE, isPriceCents } from './kalshi.js';
import { authHeaders, hasCredentials } from './kalshiAccount.js';

/**
 * Placing an order with real money, and everything that stops it going wrong.
 *
 * The sibling of this file, `kalshiAccount.js`, is read-only by construction —
 * it refuses to sign anything but three portfolio endpoints. This one is the
 * exception to that, and every rule in it exists because of a specific way real
 * money gets lost by software rather than by being wrong about a market.
 *
 * LIMIT ORDERS ONLY. Never market. A market order on a thin book fills wherever
 * the book happens to be, and this exchange showed us a live contract with
 * `liquidity_dollars: 0.0000` — a market order there could fill at any price at
 * all. A limit at the price the decision was made on can only fill at that
 * price or better, which means a stale read costs a missed trade instead of a
 * surprise.
 *
 * IDEMPOTENT BY CLIENT ORDER ID. This is the one that actually bites. A POST
 * that times out has an unknown fate: the order may have been placed, or not.
 * Retrying without an idempotency key is how one intended trade becomes two
 * real ones, and it happens exactly when the network is worst and nobody is
 * watching. Kalshi honours `client_order_id`, so a retry of the same logical
 * order is the same order rather than a second one.
 *
 * A PATH WHITELIST, same as the read side. A typo that reached a different
 * endpoint would be signed with a key that can spend.
 */

export const ORDER_PATHS = ['/portfolio/orders'];

/** The most a single order may ever be, whatever the caller asks for. */
export const MAXIMUM_CONTRACTS = 500;

/**
 * The order body Kalshi expects.
 *
 * Pure, so what gets sent can be asserted on without a network — which matters
 * more here than anywhere else in this repository, because the cost of being
 * wrong is not a bad signal, it is money.
 */
export function buildOrder({
  ticker,
  side,
  contracts,
  limitCents,
  clientOrderId = null,
  action = 'buy',
}) {
  if (!ticker) return { order: null, error: 'no ticker' };
  if (side !== 'yes' && side !== 'no') return { order: null, error: `bad side: ${side}` };
  if (action !== 'buy' && action !== 'sell') return { order: null, error: `bad action: ${action}` };

  const count = Math.floor(Number(contracts));
  if (!(count >= 1)) return { order: null, error: 'no contracts' };
  if (count > MAXIMUM_CONTRACTS) return { order: null, error: `${count} contracts is over the cap` };

  const price = Math.round(Number(limitCents));
  // A price of 0 or 100 is not a limit, it is a market order in disguise.
  if (!isPriceCents(price) || price <= 0 || price >= 100) {
    return { order: null, error: `bad limit price: ${limitCents}` };
  }

  return {
    order: {
      ticker,
      action,
      side,
      count,
      // Never 'market'. See the note at the top of this file.
      type: 'limit',
      // The price is named per side: a NO order is priced in NO cents.
      ...(side === 'yes' ? { yes_price: price } : { no_price: price }),
      // The same logical order retried is the same order, not a second one.
      client_order_id: clientOrderId ?? randomUUID(),
    },
    error: null,
  };
}

/**
 * Sends one order. Never throws.
 *
 * The return distinguishes three fates, and the third is the important one:
 * placed, rejected, or UNKNOWN. A timeout is not a rejection — the order may be
 * live — so it is reported as unknown and the risk ledger counts it as spent.
 * Treating an unknown as a rejection is how a daily limit gets quietly doubled.
 */
export async function placeOrder(
  settings,
  { ticker, side, contracts, limitCents, clientOrderId = null, action = 'buy' },
  { fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now() } = {},
) {
  if (!hasCredentials(settings)) {
    return { status: 'rejected', error: 'no trading credentials configured', order: null };
  }

  const { order, error } = buildOrder({ ticker, side, contracts, limitCents, clientOrderId, action });
  if (error) return { status: 'rejected', error, order: null };

  const path = '/portfolio/orders';
  if (!ORDER_PATHS.includes(path)) {
    return { status: 'rejected', error: `refusing to sign ${path}`, order: null };
  }

  const base = settings.apiBase ?? DEFAULT_API_BASE;
  const url = `${base}${path}`;
  const signedPath = `${new URL(base).pathname}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...authHeaders(settings, { method: 'POST', path: signedPath, now }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(order),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      // A 4xx is a real rejection: the exchange saw it and said no. A 5xx is
      // not — the order may have been accepted before the failure — so it is
      // treated as unknown and paid for.
      const definite = response.status >= 400 && response.status < 500;
      return {
        status: definite ? 'rejected' : 'unknown',
        error: `HTTP ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}`,
        order,
        body,
      };
    }

    return { status: 'placed', error: null, order, body, orderId: body?.order?.order_id ?? null };
  } catch (error_) {
    // Timed out or the socket died. The order's fate is genuinely unknown.
    return {
      status: 'unknown',
      error: error_.name === 'AbortError' ? 'timed out' : error_.message,
      order,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What an order actually cost, in dollars, once the exchange reports it.
 *
 * Read from the fill rather than from the intent, because a limit order can
 * fill partially and a partial fill that is accounted as whole overstates the
 * day's spending — which errs safe — while the reverse understates it, which
 * does not.
 */
export function orderCostDollars(result, { contracts, limitCents }) {
  const filled = Number(result?.body?.order?.taker_fill_count ?? result?.body?.order?.count);
  const count = Number.isFinite(filled) && filled > 0 ? filled : Math.floor(Number(contracts) || 0);
  const price = Number(limitCents);
  if (!(count > 0) || !isPriceCents(price)) return 0;
  return (count * price) / 100;
}

/**
 * The record kept of every order, which is also the risk ledger.
 *
 * Written BEFORE the money is known to have moved, and updated afterwards. An
 * order that was sent and never recorded is an order the daily limit does not
 * know about.
 */
export function orderRecord({
  ticker,
  side,
  contracts,
  limitCents,
  result,
  at = Date.now(),
  reason = null,
}) {
  return {
    at,
    ticker,
    side,
    contracts: Math.floor(Number(contracts) || 0),
    limitCents: Math.round(Number(limitCents) || 0),
    status: result?.status ?? 'unknown',
    orderId: result?.orderId ?? null,
    clientOrderId: result?.order?.client_order_id ?? null,
    error: result?.error ?? null,
    costDollars: orderCostDollars(result, { contracts, limitCents }),
    // Filled in when the position closes, so the streak rule and the day's
    // realised total have something to read.
    profitDollars: null,
    reason,
  };
}
