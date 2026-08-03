import { createSign, constants } from 'node:crypto';
import { DEFAULT_API_BASE, isPriceCents } from './kalshi.js';

/**
 * Reading the analyst's own Kalshi account.
 *
 * A record built from button presses is a record of what somebody said they
 * did. A record built from fills is a record of what the exchange saw them do
 * — the same claim, except nobody has to take it on faith, including the
 * analyst's own memory of where he got in.
 *
 * Read-only by construction: nothing in this file can place, amend or cancel
 * an order, and the only paths it will sign are listed below. That is a real
 * limit rather than a promise, because the credential itself is not read-only
 * — whoever holds it can trade the account, which is why it lives in the
 * host's environment and never in this repository.
 */
export const READABLE_PATHS = ['/portfolio/fills', '/portfolio/positions', '/portfolio/balance'];

/**
 * Kalshi authenticates each request with an RSA-PSS signature over
 * `timestamp + METHOD + path`, not with a bearer token, so a captured header
 * is useless a few seconds later.
 */
export function signRequest({ privateKeyPem }, { method, path, timestamp }) {
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64',
  );
}

export function authHeaders(credentials, { method, path, now = Date.now() }) {
  const timestamp = String(now);
  return {
    'KALSHI-ACCESS-KEY': credentials.keyId,
    'KALSHI-ACCESS-SIGNATURE': signRequest(credentials, { method, path, timestamp }),
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    accept: 'application/json',
  };
}

/** Whether an account is configured at all. Both halves or neither. */
export function hasCredentials(settings) {
  return Boolean(settings?.keyId && settings?.privateKeyPem);
}

/**
 * One authenticated GET. Never throws, and refuses any path not on the
 * read-only list — a typo that reached an order endpoint would be signed with
 * a key that can spend money.
 */
export async function readAccount(settings, path, { fetchImpl = globalThis.fetch, timeoutMs = 6000, now = Date.now() } = {}) {
  const [bare] = path.split('?');
  if (!READABLE_PATHS.includes(bare)) {
    return { body: null, error: `refusing to sign ${bare}: not a read-only path`, url: null };
  }
  if (!hasCredentials(settings)) {
    return { body: null, error: 'no Kalshi account credentials configured', url: null };
  }

  const base = settings.apiBase ?? DEFAULT_API_BASE;
  const url = `${base}${path}`;
  // The signature covers the path the server sees, query string excluded.
  const signedPath = `${new URL(base).pathname}${bare}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: authHeaders(settings, { method: 'GET', path: signedPath, now }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { body: null, error: `HTTP ${response.status}${text ? ` — ${text.slice(0, 300)}` : ''}`, url };
    }
    return { body: await response.json(), error: null, url };
  } catch (error) {
    return {
      body: null,
      error: error.name === 'AbortError' ? 'timed out' : error.message,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Prices come back as dollar strings on the newer fields, cents on the old. */
function centsOf(fill) {
  for (const name of ['yes_price_dollars', 'price_dollars', 'yes_price', 'price']) {
    const raw = fill?.[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    if (!Number.isFinite(value)) continue;
    const cents = name.endsWith('_dollars') ? value * 100 : value;
    if (isPriceCents(cents)) return cents;
  }
  return null;
}

/**
 * Turns a page of fills into the positions they add up to.
 *
 * A scalp is rarely one fill: an entry can be four partials at three prices,
 * and the exit another two. What the room needs is the position — the side,
 * the average price paid, and whether it is still open — so the fills are
 * folded per market rather than announced one by one.
 *
 * Pure, because this decides what gets published as somebody's track record.
 */
export function foldFills(fills, { seriesTicker = null } = {}) {
  const byMarket = new Map();

  for (const fill of fills ?? []) {
    const ticker = fill?.ticker;
    if (!ticker) continue;
    if (seriesTicker && !ticker.startsWith(seriesTicker)) continue;

    const cents = centsOf(fill);
    const count = Number(fill.count);
    if (cents === null || !Number.isFinite(count) || count <= 0) continue;

    const side = fill.side === 'no' ? 'no' : 'yes';
    const buying = (fill.action ?? 'buy') === 'buy';
    const at = Date.parse(fill.created_time ?? '') || null;

    const position = byMarket.get(ticker) ?? {
      ticker,
      side,
      contracts: 0,
      entryCost: 0,
      exitValue: 0,
      exited: 0,
      openedAt: null,
      closedAt: null,
    };

    if (buying) {
      position.side = side;
      position.contracts += count;
      position.entryCost += cents * count;
      position.openedAt = position.openedAt === null ? at : Math.min(position.openedAt, at);
    } else {
      position.exited += count;
      position.exitValue += cents * count;
      position.closedAt = position.closedAt === null ? at : Math.max(position.closedAt, at);
    }

    byMarket.set(ticker, position);
  }

  return [...byMarket.values()].map((position) => {
    const open = position.contracts - position.exited;
    const entry = position.contracts > 0 ? position.entryCost / position.contracts : null;
    const exit = position.exited > 0 ? position.exitValue / position.exited : null;
    return {
      ticker: position.ticker,
      side: position.side,
      // A DOWN call is a YES on nothing — it is a NO position on the up market.
      direction: position.side === 'no' ? 'down' : 'up',
      contracts: position.contracts,
      entryCents: entry === null ? null : Math.round(entry * 10) / 10,
      exitCents: exit === null ? null : Math.round(exit * 10) / 10,
      openContracts: open,
      isOpen: open > 0,
      openedAt: position.openedAt,
      closedAt: open > 0 ? null : position.closedAt,
      // What the trade actually returned, on the money that actually went in.
      returnPercent:
        entry === null || exit === null || entry <= 0 ? null : ((exit - entry) / entry) * 100,
    };
  });
}

/** Fills newer than a cursor, so the same trade is never announced twice. */
export function newFills(fills, since) {
  if (!since) return fills ?? [];
  return (fills ?? []).filter((fill) => (Date.parse(fill?.created_time ?? '') || 0) > since);
}

export async function fetchFills(settings, options = {}) {
  const limit = options.limit ?? 100;
  const { body, error, url } = await readAccount(settings, `/portfolio/fills?limit=${limit}`, options);
  return { fills: body?.fills ?? [], error, url, body };
}

export async function fetchBalance(settings, options = {}) {
  const { body, error, url } = await readAccount(settings, '/portfolio/balance', options);
  // Kalshi reports the balance in cents.
  const cents = Number(body?.balance);
  return { balanceCents: Number.isFinite(cents) ? cents : null, error, url, body };
}

/**
 * How much of the book a position represents.
 *
 * The size an analyst types is a claim. This is the same number measured: what
 * went in, over what there was to put in.
 */
export function sizePercentOf(position, balanceCents) {
  if (!position || !Number.isFinite(balanceCents) || balanceCents <= 0) return null;
  if (!Number.isFinite(position.entryCents) || !Number.isFinite(position.contracts)) return null;
  const spent = position.entryCents * position.contracts;
  return Math.min(100, Math.round((spent / (spent + balanceCents)) * 100));
}

/**
 * What the account says should happen to the room's calls.
 *
 * Kept apart from any publishing so the decision can be checked against fixed
 * input: this is the function that would post somebody's trades to a paying
 * audience, and it must never invent a position or close the wrong one.
 *
 * @param {object[]} positions folded fills
 * @param {object[]} picks every call this analyst has on record
 * @returns {{open: object[], close: Array<{pick: object, position: object}>}}
 */
export function planPublication(positions, picks) {
  const openPicks = (picks ?? []).filter((pick) => !pick.outcome);
  const byTicker = new Map(openPicks.filter((pick) => pick.marketTicker).map((pick) => [pick.marketTicker, pick]));
  const known = new Set((picks ?? []).map((pick) => pick.marketTicker).filter(Boolean));

  const open = [];
  const close = [];

  for (const position of positions ?? []) {
    if (position.isOpen) {
      // A position the room has never been told about. Announced once: the
      // ticker is what makes that judgement, not the timing of the poll.
      if (!known.has(position.ticker)) open.push(position);
      continue;
    }

    const pick = byTicker.get(position.ticker);
    if (pick && Number.isFinite(position.exitCents)) close.push({ pick, position });
  }

  return { open, close };
}
