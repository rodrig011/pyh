/**
 * Live spot prices, used to stamp a call when it is made and to grade it when
 * the window closes.
 *
 * Kalshi is where these calls get traded, but a 15-minute "up or down" is
 * settled by the underlying price, not by a contract's order book — so the spot
 * feed is the thing worth wiring in. Two independent exchanges are tried in
 * turn: a call that cannot be graded because one venue had a bad minute is a
 * worse outcome than asking a second one.
 *
 * The parsing is separated from the fetching so the shape each exchange returns
 * can be checked against fixtures rather than against the internet.
 */

/**
 * Ordered to match what Kalshi actually settles against.
 *
 * Kalshi resolves every crypto contract on the CME CF Real-Time Index, which is
 * a volume-weighted MEDIAN across a fixed set of constituent exchanges —
 * Bitstamp, Coinbase, Gemini, itBit/Paxos, Kraken, Bullish, Crypto.com and
 * LMAX Digital. Reading a price from outside that set means grading the
 * contract against a number the exchange never looks at.
 *
 * `constituent` marks the sources that are actually in the index. Binance is
 * not one of them, and its pair is BTC against a stablecoin rather than
 * against dollars, so it carries a basis of its own on top. It stays as a last
 * resort — a slightly wrong price beats no price when the alternative is
 * grading a member's call by hand — but it is never preferred and it is
 * labelled so a wrong read can be traced.
 */
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
  { sources = PRICE_SOURCES, timeoutMs = 5000, fetchImpl = globalThis.fetch } = {},
) {
  const symbol = asset.toUpperCase();
  const problems = [];

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
