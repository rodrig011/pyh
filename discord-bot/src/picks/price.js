import { DEFAULT_API_BASE } from './kalshi.js';
import { readAccount } from './kalshiAccount.js';

/** BTC uses the timestamped CF BRTI index through Kalshi. Exchange feeds are
 * explicitly labelled fallbacks; they never stand in for official settlement. */
export const PRICE_SOURCES = [
  {
    name: 'coinbase',
    constituent: true,
    url: (asset) => `https://api.coinbase.com/v2/prices/${asset}-USD/spot`,
    parse: (body) => Number.parseFloat(body?.data?.amount),
  },
  {
    name: 'kraken',
    constituent: true,
    url: (asset) => `https://api.kraken.com/0/public/Ticker?pair=${asset}USD`,
    parse: (body) => {
      const pairs = body?.result ?? {};
      const first = Object.values(pairs)[0];
      return Number.parseFloat(first?.c?.[0]);
    },
  },
  {
    name: 'bitstamp',
    constituent: true,
    url: (asset) => `https://www.bitstamp.net/api/v2/ticker/${asset.toLowerCase()}usd/`,
    parse: (body) => Number.parseFloat(body?.last),
  },
  {
    name: 'gemini',
    constituent: true,
    url: (asset) => `https://api.gemini.com/v1/pubticker/${asset.toLowerCase()}usd`,
    parse: (body) => Number.parseFloat(body?.last),
  },
  {
    name: 'binance',
    constituent: false,
    url: (asset) => `https://api.binance.com/api/v3/ticker/price?symbol=${asset}USDT`,
    parse: (body) => Number.parseFloat(body?.price),
  },
];

export const BRTI_FEED_VERSION = 'brti-latest-v2';
export const BRTI_MAX_AGE_MS = 15_000;

function numericPrice(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function valueTime(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  // CF's `time` is Unix milliseconds (also serialized as a string).
  const number = Number(raw);
  if (Number.isFinite(number)) return number > 0 ? number : null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** /values contains one hour in ASCENDING time order. Never use row zero.
 * See https://docs.cfbenchmarks.com/api/rest/values/ . Only value fields are
 * numbers here: serverTime, amendment time and index identifiers aren't prices.
 */
export function readBrtiValues(body) {
  const rows = [];
  const seen = new Set();
  function visit(node, inheritedId = '') {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const row of node) visit(row, inheritedId);
      return;
    }
    const id = String(node.id ?? node.index ?? node.symbol ?? node.name ?? node.ticker ?? inheritedId).toUpperCase();
    if (id && id !== 'BRTI') return;
    const price = numericPrice(node.value ?? node.price ?? node.rate ?? node.level ??
      node.last ?? node.current ?? node.index_value ?? node.indexValue);
    if (price !== null) rows.push({
      price, sourceAt: valueTime(node.time ?? node.timestamp ?? node.at),
      amendedAt: valueTime(node.amendTime),
      repeated: node.repeatOfPreviousValue === true,
    });
    for (const key of ['payload', 'data', 'result', 'results', 'values', 'items']) visit(node[key], id);
    for (const key of ['BRTI', 'brti']) {
      const value = node[key];
      if (typeof value === 'object') visit(value, 'BRTI');
      else if (numericPrice(value) !== null) rows.push({ price: numericPrice(value), sourceAt: null });
    }
  }
  visit(body);
  return rows.sort((a, b) => (a.sourceAt ?? -Infinity) - (b.sourceAt ?? -Infinity) ||
    (a.amendedAt ?? 0) - (b.amendedAt ?? 0));
}

/** Compatibility parser; the network boundary additionally requires freshness. */
export function readBrti(body) {
  return readBrtiValues(body).at(-1)?.price ?? null;
}

export function environmentKalshiCredentials(env = process.env) {
  const pairs = [
    {
      keyId: env.KALSHI_API_KEY_ID?.trim(),
      privateKeyPem: env.KALSHI_PRIVATE_KEY?.replace(/\\n/g, '\n').trim(),
      credentialSource: 'kalshi-api',
    },
    {
      // BRTI is a signed GET on the read-only allowlist. If Railway only has
      // the deliberately separate trading key, it can authenticate this read
      // without giving the price path any ability to place an order.
      keyId: env.KALSHI_TRADING_KEY_ID?.trim(),
      privateKeyPem: env.KALSHI_TRADING_PRIVATE_KEY?.replace(/\\n/g, '\n').trim(),
      credentialSource: 'kalshi-trading-fallback',
    },
  ];
  const pair = pairs.find((candidate) => candidate.keyId && candidate.privateKeyPem);
  if (!pair) return null;
  return { ...pair, apiBase: env.KALSHI_API_BASE?.trim() || undefined };
}

function officialKalshiCredentials(credentials) {
  if (!credentials) return null;
  const configured = credentials.apiBase?.trim();
  const legacy = configured && new URL(configured).hostname === 'api.elections.kalshi.com';
  return { ...credentials, apiBase: !configured || legacy ? DEFAULT_API_BASE : configured };
}

/** Official index Kalshi uses for KXBTC15M settlement. Read-only by construction. */
export async function fetchBrtiPrice(credentials, options = {}) {
  if (!credentials) {
    return {
      price: null,
      source: 'kalshi-brti',
      error: 'Kalshi BRTI: no complete Kalshi API credential pair is configured',
      errorCode: 'missing_credentials',
    };
  }
  const result = await readAccount(officialKalshiCredentials(credentials), '/cfbenchmarks/values?id=BRTI', options);
  if (result.error) {
    const status = Number(result.status);
    const errorCode = status === 401 || status === 403
      ? 'not_entitled'
      : status === 429
        ? 'rate_limited'
        : status === 503
          ? 'upstream_unavailable'
          : 'request_failed';
    const guidance = errorCode === 'not_entitled'
      ? 'Kalshi rejected BRTI access; verify the API key and ask Kalshi to enable the CF Benchmarks entitlement'
      : errorCode === 'rate_limited'
        ? 'Kalshi BRTI rate limit reached; wait before retrying'
        : errorCode === 'upstream_unavailable'
          ? 'Kalshi/CF Benchmarks BRTI is temporarily unavailable'
          : `Kalshi BRTI request failed: ${result.error}`;
    return { price: null, source: 'kalshi-brti', error: guidance, errorCode, httpStatus: status || null };
  }
  const receivedAt = options.now ?? Date.now();
  const values = readBrtiValues(result.body);
  const newest = values.at(-1);
  const fail = (errorCode, error) => ({ price: null, source: 'kalshi-brti', errorCode, error,
    sourceAt: newest?.sourceAt ?? null, at: receivedAt });
  if (!newest) return fail('invalid_response', 'Kalshi BRTI returned HTTP 200 but no usable BRTI value');
  if (!Number.isFinite(newest.sourceAt)) return fail('missing_timestamp', 'Kalshi BRTI value has no calculation timestamp');
  if (newest.repeated) return fail('repeated_value', 'Kalshi BRTI is repeating a previous value');
  const ageMs = receivedAt - newest.sourceAt;
  if (ageMs > BRTI_MAX_AGE_MS || ageMs < -5_000) {
    return fail('stale_price', `Kalshi BRTI calculation time is ${Math.round(ageMs / 1000)}s from now`);
  }
  return { price: newest.price, source: 'kalshi-brti', at: receivedAt,
    sourceAt: newest.sourceAt, ageMs, feedVersion: BRTI_FEED_VERSION, problems: [],
    history: values.filter((row) => !row.repeated && Number.isFinite(row.sourceAt) &&
      row.sourceAt >= receivedAt - 3_600_000 && row.sourceAt <= receivedAt)
      .map((row) => ({ at: row.sourceAt, sourceAt: row.sourceAt, price: row.price,
        source: 'kalshi-brti', feedVersion: BRTI_FEED_VERSION })),
  };
}

/** A price is only usable if it is a real positive number. */
export function readPrice(source, body) {
  const value = source.parse(body);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The current spot price, or null with the reason each source failed.
 *
 * Never throws: a missing price must degrade a call to manual grading, not take
 * the bot down mid-window.
 */
export async function fetchSpotPrice(
  asset = 'BTC',
  {
    sources = PRICE_SOURCES,
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
    kalshiCredentials = environmentKalshiCredentials(),
    allowExchangeFallback = process.env.BTC_ALLOW_EXCHANGE_FALLBACK?.trim().toLowerCase() === 'true',
  } = {},
) {
  const symbol = asset.toUpperCase();
  const problems = [];

  // Never synthesize the settlement index from constituent venues. Kalshi's
  // own BRTI feed is authoritative; exchanges below are only a labelled
  // fallback when the account lacks entitlement or the index is unavailable.
  let brti = null;
  if (symbol === 'BTC' && (kalshiCredentials || !allowExchangeFallback)) {
    brti = await fetchBrtiPrice(kalshiCredentials, { fetchImpl, timeoutMs });
    if (brti.price > 0) return brti;
    problems.push(`kalshi-brti: ${brti.error ?? 'unavailable'}`);
  }

  // BTC calls settle against BRTI. A live Coinbase number can look healthy
  // while disagreeing by enough dollars to flip a close market, so the safe
  // default is no BTC prediction rather than silently changing the ruler.
  if (symbol === 'BTC' && !allowExchangeFallback) {
    const error = brti.error ?? problems[0] ?? 'Kalshi BRTI unavailable';
    return {
      price: null,
      source: 'kalshi-brti',
      error,
      errorCode: brti.errorCode ?? 'unavailable',
      httpStatus: brti.httpStatus ?? null,
      at: Date.now(),
      problems: [error],
    };
  }

  for (const source of sources) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(source.url(symbol), { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        problems.push(`${source.name}: HTTP ${response.status}`);
        continue;
      }

      const price = readPrice(source, await response.json());
      if (price === null) {
        problems.push(`${source.name}: no usable price in the response`);
        continue;
      }

      return { price, source: source.name, at: Date.now(), problems };
    } catch (error) {
      problems.push(`${source.name}: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    }
  }

  return { price: null, source: null, at: Date.now(), problems };
}

/**
 * Grades a call from the two prices around it.
 *
 * A move too small to matter is a break-even rather than a win: settling a
 * one-cent drift as a correct call would inflate every record on the board, and
 * the whole point of the board is that it can go down.
 *
 * @param {'up'|'down'} direction
 * @param {number} entry
 * @param {number} exit
 * @param {number} [deadBandPercent] moves under this count as flat
 */
export function gradeByPrice(direction, entry, exit, deadBandPercent = 0.02) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return null;

  const changePercent = ((exit - entry) / entry) * 100;
  if (Math.abs(changePercent) < deadBandPercent) {
    return { outcome: 'break_even', changePercent };
  }

  const wentUp = changePercent > 0;
  const calledUp = direction === 'up';
  return { outcome: wentUp === calledUp ? 'win' : 'loss', changePercent };
}

export function formatPrice(value) {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A move, written the way a trader says it.
 *
 * Three decimals was precision nobody asked for and nobody trusts: "-25.373%"
 * beside a price reads as a machine talking to itself. One decimal is the
 * resolution the number actually has.
 */
export function formatChange(percent) {
  if (!Number.isFinite(percent)) return '—';
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/**
 * Grades a Kalshi call against the STRIKE, which is what the contract asks.
 *
 * The bug this exists to end, reported by the analyst himself: "Bitcoin price
 * it's going off of, not Kalshi odds — so it says we lost if bitcoin moves
 * higher than when we entered."
 *
 * He was right, and the mistake is worth stating precisely because it looks
 * like a rounding difference and is not. A Kalshi contract does not ask "did
 * bitcoin go up from where you clicked?". It asks "did bitcoin finish above
 * THIS LEVEL?" — a level fixed when the market opened, which is almost never
 * the price at the moment somebody entered.
 *
 * So a call entered at 65,050 against a strike of 65,000, held while bitcoin
 * drifts up to 65,120, is graded a LOSS by the entry-price rule and is in fact
 * a WIN: it finished above the strike, the contract pays a dollar. And the
 * mirror case marks real losses as wins. Every call where the entry and the
 * strike sat on opposite sides of the finish was graded backwards.
 */
export function gradeByStrike(direction, strike, exit, deadBandPercent = 0.02) {
  if (!Number.isFinite(strike) || !Number.isFinite(exit) || strike <= 0) return null;

  const changePercent = ((exit - strike) / strike) * 100;

  // Settling exactly on the strike is not a win for either side. Kalshi's own
  // rules resolve it, but from outside the only honest answer is "too close to
  // call" — better than picking a side and being wrong half the time.
  if (Math.abs(changePercent) < deadBandPercent) {
    return { outcome: 'break_even', changePercent, against: 'strike' };
  }

  const finishedAbove = changePercent > 0;
  const calledUp = direction === 'up';
  return {
    outcome: finishedAbove === calledUp ? 'win' : 'loss',
    changePercent,
    against: 'strike',
  };
}
