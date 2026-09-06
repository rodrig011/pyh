/** Public Kalshi depth. Both arrays are BIDS; YES asks are 1 - NO bids.
 * https://docs.kalshi.com/getting_started/orderbook_responses */
export function parseOrderbook(body, { ticker, at } = {}) {
  const fp = body?.orderbook_fp;
  const book = fp ?? body?.orderbook;
  if (!book) return null;
  function levels(rows, dollars) {
    if (!Array.isArray(rows)) return null;
    return rows.flatMap((row) => {
      const price = Number(row?.[0]) * (dollars ? 100 : 1);
      const count = Number(row?.[1]);
      return Number.isFinite(price) && price > 0 && price < 100 && count > 0
        ? [{ price, count }] : [];
    }).sort((a, b) => b.price - a.price);
  }
  const yes = levels(book.yes_dollars ?? book.yes, !!fp || !!book.yes_dollars);
  const no = levels(book.no_dollars ?? book.no, !!fp || !!book.no_dollars);
  if (!yes || !no) return null;
  const bid = yes[0]?.price ?? 0;
  const ask = no.length ? 100 - no[0].price : 100;
  if (bid > ask) return null;
  const yesNear = yes.filter((row) => row.price >= bid - 5);
  const noNear = no.filter((row) => row.price >= (no[0]?.price ?? 0) - 5);
  const yesSize = yesNear.reduce((s, row) => s + row.count, 0);
  const noSize = noNear.reduce((s, row) => s + row.count, 0);
  const dollars = [...yesNear, ...noNear].reduce((s, row) => s + row.price * row.count / 100, 0);
  return { ticker, at, bid, ask, bidSize: yes[0]?.count ?? 0, askSize: no[0]?.count ?? 0,
    liquidityDollars: dollars, complete: yes.length > 0 && no.length > 0,
    depthImbalance: yesSize + noSize > 0 ? (yesSize - noSize) / (yesSize + noSize) : null };
}

/** Cont/Kukanov/Stoikov best-quote event imbalance, normalized by observed size.
 * This is sampled OFI for this contract; not BTC exchange flow or a trade count. */
export function sampledOfi(previous, current) {
  if (!previous?.complete || !current?.complete || previous.ticker !== current.ticker ||
      !(current.at > previous.at) || current.at - previous.at > 30_000) return null;
  const bid = (current.bid >= previous.bid ? current.bidSize : 0) -
    (current.bid <= previous.bid ? previous.bidSize : 0);
  const ask = -(current.ask <= previous.ask ? current.askSize : 0) +
    (current.ask >= previous.ask ? previous.askSize : 0);
  const scale = current.bidSize + previous.bidSize + current.askSize + previous.askSize;
  return scale > 0 ? (bid + ask) / scale : null;
}

// Cache is scoped to the HTTP client, host and ticker, never reused across environments.
const clients = new WeakMap();
export async function enrichOrderbook(market, settings, {
  fetchImpl = globalThis.fetch, timeoutMs = 3000, now = Date.now(),
} = {}) {
  if (!market?.ticker || !settings.apiBase) return market;
  let cache = clients.get(fetchImpl);
  if (!cache) { cache = new Map(); clients.set(fetchImpl, cache); }
  const key = `${settings.apiBase}/${market.ticker}`;
  const previous = cache.get(key);
  if (previous && now >= previous.at && now - previous.at < 1000) return { ...market, ...previous.fields };
  try {
    const response = await fetchImpl(`${settings.apiBase}/markets/${encodeURIComponent(market.ticker)}/orderbook?depth=100`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ...market, book_error: `HTTP ${response.status}` };
    const snapshot = parseOrderbook(await response.json(), { ticker: market.ticker, at: now });
    if (!snapshot) return { ...market, book_error: 'invalid orderbook response' };
    const fields = {
      yes_bid_dollars: (snapshot.bid / 100).toFixed(4),
      yes_ask_dollars: (snapshot.ask / 100).toFixed(4),
      yes_bid_size: snapshot.bidSize, yes_ask_size: snapshot.askSize,
      book_liquidity_dollars: snapshot.liquidityDollars, book_at: now,
      book_complete: snapshot.complete,
      microstructure: { ofi: sampledOfi(previous?.snapshot, snapshot),
        bookImbalance: snapshot.depthImbalance, bookComplete: snapshot.complete },
    };
    cache.set(key, { at: now, snapshot, fields });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return { ...market, ...fields };
  } catch (error) {
    return { ...market, book_error: error.name === 'TimeoutError' ? 'orderbook timeout' : 'orderbook unavailable' };
  }
}
