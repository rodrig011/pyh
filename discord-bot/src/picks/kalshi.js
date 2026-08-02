/**
 * Reading the contract price from Kalshi.
 *
 * BTC spot answers "did price go the called way". It does not answer "did the
 * trade make money", and on a scalp those come apart constantly: a contract
 * bought at 47¢ and sold at 61¢ paid 30% while spot barely moved, and a call
 * that was right at the candle close can still have been a loss if the contract
 * was bought at 80¢. What the room actually holds is the contract, so that is
 * what should be scored.
 *
 * Kalshi's response shapes could not be verified from the machine this was
 * written on — the network policy there blocks the host — so the parsing is
 * kept separate from the fetching and checked against fixtures, and
 * `/picks kalshi` prints exactly what the API returned so the real shape can be
 * pinned down against a live account rather than guessed at.
 */

export const DEFAULT_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

/**
 * Prices come back in cents (0–100), which is also how the site shows them.
 * Anything outside that is not a price and must not be treated as one.
 */
export function isPriceCents(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * The tradeable price of a market, in cents.
 *
 * `last_price` is what a scalper actually got filled near; the mid of the
 * bid/ask is the fallback when nothing has traded yet. A market with neither is
 * reported as unusable rather than guessed at, because a made-up entry price
 * produces a made-up profit.
 */
export function readMarketPrice(market, side = 'yes') {
  if (!market || typeof market !== 'object') return null;

  const last = Number(market.last_price);
  if (isPriceCents(last) && last > 0) {
    return { cents: side === 'yes' ? last : 100 - last, source: 'last_price' };
  }

  const bid = Number(side === 'yes' ? market.yes_bid : market.no_bid);
  const ask = Number(side === 'yes' ? market.yes_ask : market.no_ask);
  if (isPriceCents(bid) && isPriceCents(ask) && (bid > 0 || ask > 0)) {
    return { cents: Math.round((bid + ask) / 2), source: 'mid' };
  }

  return null;
}

/** Markets still open for trading, soonest to close first. */
export function openMarkets(markets, now = Date.now()) {
  return (markets ?? [])
    .filter((market) => market?.status === 'active' || market?.status === 'open')
    .filter((market) => {
      const closes = Date.parse(market.close_time ?? market.expiration_time ?? '');
      return Number.isNaN(closes) ? true : closes > now;
    })
    .sort((a, b) => Date.parse(a.close_time ?? 0) - Date.parse(b.close_time ?? 0));
}

/**
 * What a scalp actually returned, as a percentage of what went in.
 *
 * A contract is bought and sold in cents, so the return is the move over the
 * entry — not the move in the underlying. Buying at 47¢ and selling at 61¢ is
 * +29.8%, whatever BTC did in between.
 */
export function contractReturn(entryCents, exitCents) {
  if (!isPriceCents(entryCents) || !isPriceCents(exitCents) || entryCents <= 0) return null;
  return ((exitCents - entryCents) / entryCents) * 100;
}

/**
 * Grades a scalp on the contract, with a dead band so a one-cent drift is not
 * sold to the room as a win.
 */
export function gradeByContract(entryCents, exitCents, deadBandPercent = 1) {
  const change = contractReturn(entryCents, exitCents);
  if (change === null) return null;
  if (Math.abs(change) < deadBandPercent) return { outcome: 'break_even', changePercent: change };
  return { outcome: change > 0 ? 'win' : 'loss', changePercent: change };
}

export function formatCents(cents) {
  return isPriceCents(cents) ? `${Math.round(cents)}¢` : '—';
}

/**
 * Fetches the markets of a series. Read-only market data, which Kalshi serves
 * without a signature; a key is only added when one is configured, so this
 * works before anyone has set up credentials.
 *
 * Never throws: a feed that is down costs automatic grading, not the call.
 */
export async function fetchMarkets(settings, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const base = settings.apiBase ?? DEFAULT_API_BASE;
  const url = `${base}/markets?limit=50&status=open${settings.seriesTicker ? `&series_ticker=${encodeURIComponent(settings.seriesTicker)}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: settings.apiKeyId ? { 'KALSHI-ACCESS-KEY': settings.apiKeyId } : {},
    });
    if (!response.ok) {
      return { markets: [], error: `HTTP ${response.status}`, url };
    }
    const body = await response.json();
    return { markets: body?.markets ?? [], error: null, url, body };
  } catch (error) {
    return {
      markets: [],
      error: error.name === 'AbortError' ? 'timed out' : error.message,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The market a call should be priced against, and its price right now. */
export async function currentContract(settings, options = {}) {
  const { markets, error, url } = await fetchMarkets(settings, options);
  if (error) return { price: null, market: null, error, url };

  const open = openMarkets(markets);
  if (open.length === 0) return { price: null, market: null, error: 'no open markets', url };

  const market = open[0];
  const price = readMarketPrice(market, settings.side ?? 'yes');
  return {
    price: price?.cents ?? null,
    priceSource: price?.source ?? null,
    market,
    error: price ? null : 'no usable price on that market',
    url,
  };
}
