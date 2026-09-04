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
 *
 * V2 ORDER SCHEMA. Kalshi retired `/portfolio/orders` — the path this file
 * used until it started coming back `410: Please switch to the V2
 * endpoints` — for `/portfolio/events/orders`, which drops separate yes/no
 * sides and buy/sell actions for a single book `side` ("bid" or "ask"),
 * always priced in YES-denominated dollars. Confirmed against two
 * independent, actively-maintained open-source Kalshi clients (arshka's
 * pykalshi and mvanhorn's printing-press-library) rather than against
 * Kalshi's own docs site, which this environment cannot reach — both agree
 * on the mapping below. Nothing about the RISK rails changed: still one
 * limit order at a time, still idempotent by client_order_id, still a path
 * whitelist.
 */

export const ORDER_PATHS = ['/portfolio/events/orders'];

/** The most a single order may ever be, whatever the caller asks for. */
export const MAXIMUM_CONTRACTS = 500;

/**
 * BUY/SELL crossed with YES/NO, collapsed into the single book side V2
 * wants — because YES and NO are complementary (always sum to $1), every
 * order is really a bid or an ask on the same underlying question:
 *
 *   BUY  YES -> bid   (paying to hold YES)
 *   SELL YES -> ask   (giving up YES at that price)
 *   BUY  NO  -> ask   (equivalent to selling YES at the complementary price)
 *   SELL NO  -> bid   (equivalent to buying YES at the complementary price)
 */
export function bookSide(action, side) {
  if (action === 'buy') return side === 'yes' ? 'bid' : 'ask';
  return side === 'yes' ? 'ask' : 'bid';
}

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
  exchangeIndex = 0,
  clientOrderId = null,
  action = 'buy',
}) {
  if (!ticker) return { order: null, error: 'no ticker' };
  if (side !== 'yes' && side !== 'no') return { order: null, error: `bad side: ${side}` };
  if (action !== 'buy' && action !== 'sell') return { order: null, error: `bad action: ${action}` };

  const count = Math.floor(Number(contracts));
  if (!(count >= 1)) return { order: null, error: 'no contracts' };
  if (count > MAXIMUM_CONTRACTS) return { order: null, error: `${count} contracts is over the cap` };

  const marketExchangeIndex = Number(exchangeIndex);
  if (!Number.isInteger(marketExchangeIndex) || marketExchangeIndex < 0) {
    return { order: null, error: `bad exchange index: ${exchangeIndex}` };
  }

  const priceCents = Math.round(Number(limitCents));
  // A price of 0 or 100 is not a limit, it is a market order in disguise.
  if (!isPriceCents(priceCents) || priceCents <= 0 || priceCents >= 100) {
    return { order: null, error: `bad limit price: ${limitCents}` };
  }

  // V2 prices are always YES-denominated, whichever side is actually being
  // traded — a NO order at 40c is a YES price of 60c, since the two sum to
  // a dollar. Four decimal places matches every reference client checked;
  // Kalshi supports sub-cent pricing now, and this format works whether the
  // exchange wants that precision or not.
  const yesPriceDollars = side === 'yes' ? priceCents / 100 : 1 - priceCents / 100;

  return {
    order: {
      ticker,
      side: bookSide(action, side),
      // A quoted decimal, not a JSON number — confirmed against Kalshi's own
      // published example request, which sends whole-contract counts as
      // "10.00". A bare 1 here is exactly the kind of type mismatch that
      // gets a 400 with no explanation.
      count: count.toFixed(2),
      price: yesPriceDollars.toFixed(4),
      // An approval is for the quote visible NOW, not permission for a stale
      // order to sit on Kalshi and fill minutes later. IOC fills immediately
      // at this limit or better and cancels whatever remains.
      time_in_force: 'immediate_or_cancel',
      // REQUIRED by CreateOrderV2Request, confirmed from a reference
      // client's own source comment: omitting this is literally what a
      // "400 missing_parameters" means. "maker" is the exchange's own
      // default (cancel the RESTING order on a self-cross rather than the
      // incoming one) — this bot only ever holds one position, so a
      // self-cross should never actually happen, but the field still has to
      // be present.
      self_trade_prevention_type: 'maker',
      // Markets are sharded by exchange_index. This must be copied from the
      // selected market; forcing every ticker onto shard 0 makes a perfectly
      // valid ticker look nonexistent and Kalshi answers 404.
      exchange_index: marketExchangeIndex,
      // The same logical order retried is the same order, not a second one.
      client_order_id: clientOrderId ?? randomUUID(),
    },
    error: null,
  };
}

/**
 * The human-readable part of a rejection, tried against every shape Kalshi
 * has actually used rather than one assumed shape — a schema mismatch here
 * is exactly how a real 400 reached a person as "HTTP 400" and nothing
 * else, with the real reason sitting unread in the response the whole time.
 * Falls all the way back to the raw body rather than ever hiding what the
 * exchange said.
 */
export function errorDetail(body) {
  if (!body) return null;
  if (typeof body.error === 'string') return body.error;
  if (typeof body.error?.message === 'string') return body.error.message;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.detail === 'string') return body.detail;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return body.errors.map((e) => (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)))).join('; ');
  }
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

/**
 * Sends one order. Never throws.
 *
 * The return distinguishes five definite fates plus an unknown one:
 * filled, partial, unfilled, rejected, or UNKNOWN. A successful HTTP response
 * only says Kalshi accepted the order request; `fill_count` says whether a
 * trade actually happened.
 * Treating an unknown as a rejection is how a daily limit gets quietly doubled.
 */
export async function placeOrder(
  settings,
  { ticker, side, contracts, limitCents, exchangeIndex = 0, clientOrderId = null, action = 'buy' },
  { fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now() } = {},
) {
  if (!hasCredentials(settings)) {
    return { status: 'rejected', error: 'no trading credentials configured', order: null };
  }

  const { order, error } = buildOrder({
    ticker,
    side,
    contracts,
    limitCents,
    exchangeIndex,
    clientOrderId,
    action,
  });
  if (error) return { status: 'rejected', error, order: null };

  const path = '/portfolio/events/orders';
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
        error: `HTTP ${response.status}${errorDetail(body) ? `: ${errorDetail(body)}` : ''}`,
        order,
        body,
      };
    }

    // V2's create-order ack is a thin, TOP-LEVEL object — {order_id,
    // fill_count, remaining_count, ...} — not the full order nested under an
    // "order" key the way v1 returned it.
    const filledCount = body?.fill_count === null || body?.fill_count === undefined || body?.fill_count === ''
      ? NaN
      : Number(body.fill_count);
    const remainingCount = body?.remaining_count === null || body?.remaining_count === undefined || body?.remaining_count === ''
      ? NaN
      : Number(body.remaining_count);
    const requestedCount = Number(order.count);
    const hasFillCount = Number.isFinite(filledCount) && filledCount >= 0;
    let status = 'unknown';
    if (hasFillCount) {
      status = filledCount === 0
        ? 'unfilled'
        : filledCount + 1e-9 >= requestedCount
          ? 'filled'
          : 'partial';
    }
    return {
      status,
      error: hasFillCount ? null : 'Kalshi accepted the order but did not return fill_count',
      order,
      body,
      orderId: body?.order_id ?? null,
      filledCount: hasFillCount ? filledCount : null,
      remainingCount: Number.isFinite(remainingCount) ? remainingCount : null,
    };
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
export function confirmedFillCount(result) {
  const direct = result?.filledCount === null || result?.filledCount === undefined || result?.filledCount === ''
    ? NaN
    : Number(result.filledCount);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const rawBody = result?.body?.fill_count;
  const body = rawBody === null || rawBody === undefined || rawBody === '' ? NaN : Number(rawBody);
  return Number.isFinite(body) && body >= 0 ? body : null;
}

export function fillPriceCents(result, { side, limitCents }) {
  // V2 reports the average YES price in dollars even when the order traded NO.
  const rawPrice = result?.body?.average_fill_price;
  const yesDollars = rawPrice === null || rawPrice === undefined || rawPrice === '' ? NaN : Number(rawPrice);
  if (Number.isFinite(yesDollars) && yesDollars >= 0 && yesDollars <= 1) {
    return Math.round((side === 'no' ? 1 - yesDollars : yesDollars) * 10_000) / 100;
  }
  const fallback = Number(limitCents);
  return isPriceCents(fallback) ? fallback : null;
}

export function orderFeeDollars(result, count = confirmedFillCount(result)) {
  const averageFee = Number(result?.body?.average_fee_paid);
  return Number.isFinite(averageFee) && averageFee >= 0 && Number.isFinite(count)
    ? averageFee * count
    : 0;
}

export function orderCostDollars(result, { contracts, limitCents, side = 'yes' }) {
  if (result?.status === 'rejected' || result?.status === 'unfilled') return 0;
  const confirmed = confirmedFillCount(result);
  // Unknown fate is deliberately reserved at the full requested limit.
  const count = confirmed === null ? Math.floor(Number(contracts) || 0) : confirmed;
  const price = confirmed === null ? Number(limitCents) : fillPriceCents(result, { side, limitCents });
  if (!(count > 0) || !isPriceCents(price)) return 0;
  return (count * price) / 100 + orderFeeDollars(result, confirmed);
}

export function orderProceedsDollars(result, { contracts, limitCents, side = 'yes' }) {
  const count = confirmedFillCount(result);
  const price = fillPriceCents(result, { side, limitCents });
  if (!(count > 0) || !isPriceCents(price)) return 0;
  return Math.max(0, (count * price) / 100 - orderFeeDollars(result, count));
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
  forced = false,
}) {
  return {
    at,
    ticker,
    side,
    requestedContracts: Math.floor(Number(contracts) || 0),
    filledContracts: confirmedFillCount(result),
    contracts: confirmedFillCount(result) ?? Math.floor(Number(contracts) || 0),
    limitCents: Math.round(Number(limitCents) || 0),
    fillCents: fillPriceCents(result, { side, limitCents }),
    status: result?.status ?? 'unknown',
    orderId: result?.orderId ?? null,
    clientOrderId: result?.order?.client_order_id ?? null,
    error: result?.error ?? null,
    costDollars: orderCostDollars(result, { contracts, limitCents, side }),
    // Filled in when the position closes, so the streak rule and the day's
    // realised total have something to read.
    profitDollars: null,
    reason,
    // A real field, not a prefix on `reason` — riskLimits.js's forced-loss
    // circuit breaker has to filter and sum these reliably, and matching
    // text is how that silently breaks the day somebody edits the reason
    // string.
    forced: Boolean(forced),
  };
}
