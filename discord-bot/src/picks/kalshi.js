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
/**
 * Kalshi reports prices as dollar strings — "0.3900" for a 39¢ contract — and
 * kept the older whole-cent integers on some fields. Both are read, because a
 * live market answered with only the dollar form and the bot, looking for the
 * integers alone, reported "no usable price" on a market trading perfectly
 * well.
 */
function priceCentsFrom(market, names) {
  for (const name of names) {
    const raw = market[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    if (!Number.isFinite(value)) continue;
    const cents = name.endsWith('_dollars') ? value * 100 : value;
    if (isPriceCents(cents)) return cents;
  }
  return null;
}

export function readMarketPrice(market, side = 'yes') {
  if (!market || typeof market !== 'object') return null;

  // The side's own book first. On a two-sided market the NO quotes are the
  // real cost of taking the down side; deriving them from the YES last trade
  // is a second-hand estimate of a number the exchange already published.
  const bid = priceCentsFrom(market, [`${side}_bid_dollars`, `${side}_bid`]);
  const ask = priceCentsFrom(market, [`${side}_ask_dollars`, `${side}_ask`]);
  if (bid !== null && ask !== null && (bid > 0 || ask > 0)) {
    return { cents: Math.round((bid + ask) / 2), source: 'mid' };
  }

  // last_price is the YES side's last trade, so the NO price is its complement.
  const last = priceCentsFrom(market, ['last_price_dollars', 'last_price']);
  if (last !== null && last > 0) {
    return { cents: Math.round(side === 'yes' ? last : 100 - last), source: 'last_price' };
  }

  // One-sided book: better than nothing, and named so the room can see it.
  const only = bid ?? ask;
  if (only !== null && only > 0) return { cents: Math.round(only), source: 'one_sided' };

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

/**
 * A contract price, written the way the room says it out loud.
 *
 * Kalshi quotes 0–100¢ and that number is also the implied probability, so the
 * site and the traders both talk in percentages — "down is 53, up is 47". A
 * call that reads "in at 39¢" and one that reads "in at 39%" are the same
 * price, and only one of them matches what the analyst actually said.
 */
export function formatCents(cents) {
  return isPriceCents(cents) ? `${Math.round(cents)}%` : '—';
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

/**
 * The market whose window matches the call's.
 *
 * A new 15-minute market opens every quarter hour, so "the soonest one to
 * close" is a different contract depending on the second you ask. A call
 * opened at 02:14 belongs to the 02:15 market, and a call opened at 02:14:55
 * belongs to the 02:30 one — the same rule the call's own clock already used.
 * Matching on the close time keeps both ends of a trade on one contract.
 */
export function marketForClose(markets, closesAt = null, now = Date.now()) {
  const open = openMarkets(markets, now);
  if (open.length === 0) return null;
  if (!closesAt) return open[0];

  const closeOf = (market) => Date.parse(market.close_time ?? market.expiration_time ?? '');
  let best = null;
  let bestDistance = Infinity;
  for (const market of open) {
    const closes = closeOf(market);
    if (Number.isNaN(closes)) continue;
    const distance = Math.abs(closes - closesAt);
    if (distance < bestDistance) {
      best = market;
      bestDistance = distance;
    }
  }
  return best ?? open[0];
}

/**
 * One named market. Used to close a call against the very contract it was
 * opened on — by the time an exit is pressed, that market may have rolled over
 * and "the current market" is a different trade entirely.
 */
export async function fetchMarket(settings, ticker, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const base = settings.apiBase ?? DEFAULT_API_BASE;
  const url = `${base}/markets/${encodeURIComponent(ticker)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: settings.apiKeyId ? { 'KALSHI-ACCESS-KEY': settings.apiKeyId } : {},
    });
    if (!response.ok) return { market: null, error: `HTTP ${response.status}`, url };
    const body = await response.json();
    return { market: body?.market ?? null, error: null, url, body };
  } catch (error) {
    return { market: null, error: error.name === 'AbortError' ? 'timed out' : error.message, url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every contract open in the same window, with the price of each.
 *
 * This exists because of the most expensive mistake in the whole signal path,
 * and it was not a mistake of maths. Kalshi does not publish ONE fifteen-minute
 * bitcoin contract. It publishes a LADDER of them — a dozen strikes spaced
 * around spot, all closing at the same bell — and the engine was reading
 * exactly one of them: whichever happened to close soonest.
 *
 * So the bot spent all day forming an opinion about a single strike, usually
 * one already so far in or out of the money that no price on it was worth
 * paying, and refused. It looked like an engine that was too strict. It was an
 * engine that was near-sighted: it was refusing a board of twelve markets on
 * the evidence of one.
 *
 * Measured on the simulator, against a market with a real four-cent bias, the
 * share of windows containing at least one call goes from 36% to 76% when the
 * ladder is read instead of a single strike — at the SAME edge threshold, with
 * nothing loosened. It saturates around five strikes, because past that they
 * are all priced out anyway, so reading the whole board costs one request and
 * needs no cleverness about which part of it to read.
 */
export function boardForClose(markets, { closesAt = null, now = Date.now(), windowMs = 60 * 1000 } = {}) {
  const open = openMarkets(markets, now);
  if (open.length === 0) return [];

  const closeOf = (market) => Date.parse(market.close_time ?? market.expiration_time ?? '');

  // Which bell. Without an explicit one, the next bell to ring — the same rule
  // a single contract used, applied to the whole ladder behind it.
  const target = closesAt ?? closeOf(open[0]);
  if (!Number.isFinite(target)) return [];

  // A tolerance rather than an equality: the strikes of one window share a
  // close time, but the field is a formatted timestamp and one stray second
  // must not drop a strike off the board.
  return open.filter((market) => {
    const closes = closeOf(market);
    return Number.isFinite(closes) && Math.abs(closes - target) <= windowMs;
  });
}

/**
 * The whole board, priced, soonest bell first.
 *
 * Never throws, and a strike with no usable price is dropped rather than
 * carried as a null — a board is a list of things that can be traded.
 */
export async function openBoard(settings, options = {}) {
  const { closesAt = null, now = Date.now() } = options;
  const { markets, error, url } = await fetchMarkets(settings, options);
  if (error) return { contracts: [], error, url };

  const board = boardForClose(markets, { closesAt, now });
  if (board.length === 0) return { contracts: [], error: 'no open markets', url };

  const contracts = [];
  for (const market of board) {
    const price = readMarketPrice(market, settings.side ?? 'yes');
    if (!price) continue;
    contracts.push({ price: price.cents, priceSource: price.source, market });
  }

  return {
    contracts,
    error: contracts.length > 0 ? null : 'no usable price on any market in the window',
    url,
    // How much of the ladder was thrown away for want of a price, so a thin
    // board can be told from a broken parser.
    quoted: contracts.length,
    listed: board.length,
  };
}

/**
 * The strike nearest a coin flip.
 *
 * Which strike gets measured turns out to matter as much as what is measured.
 * `currentContract()` returns whichever market closes soonest, and a dozen
 * strikes in one window all close at the same instant — so it returns whichever
 * the exchange happened to list first, which is a fixed position on the ladder
 * rather than a fixed distance from the money. The edge log was therefore built
 * almost entirely from strikes far from the money, whose outcomes are nearly
 * decided: easy to forecast, priced at 3¢ or 96¢, and refused by the engine as
 * `priced_out` on sight.
 *
 * That is a measurement of a population the bot does not trade. The engine
 * trades near the money, so that is where the evidence has to come from.
 */
export function nearestTheMoneyContract(contracts) {
  let best = null;
  let bestDistance = Infinity;
  for (const contract of contracts ?? []) {
    if (!isPriceCents(contract?.price)) continue;
    const distance = Math.abs(contract.price - 50);
    if (distance < bestDistance) {
      best = contract;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The market a call should be priced against, and its price right now.
 *
 * `ticker` pins it to a contract already chosen; `closesAt` picks the one
 * covering that window. Without either it falls back to whatever closes next,
 * which is only right for a quote nobody is trading against.
 */
export async function currentContract(settings, options = {}) {
  const { ticker = null, closesAt = null, now = Date.now() } = options;

  if (ticker) {
    const { market, error, url } = await fetchMarket(settings, ticker, options);
    if (error || !market) return { price: null, market: null, error: error ?? 'no such market', url };
    const price = readMarketPrice(market, settings.side ?? 'yes');
    return {
      price: price?.cents ?? null,
      priceSource: price?.source ?? null,
      market,
      error: price ? null : 'no usable price on that market',
      url,
    };
  }

  const { markets, error, url } = await fetchMarkets(settings, options);
  if (error) return { price: null, market: null, error, url };

  const market = marketForClose(markets, closesAt, now);
  if (!market) return { price: null, market: null, error: 'no open markets', url };

  const price = readMarketPrice(market, settings.side ?? 'yes');
  return {
    price: price?.cents ?? null,
    priceSource: price?.source ?? null,
    market,
    error: price ? null : 'no usable price on that market',
    url,
  };
}
