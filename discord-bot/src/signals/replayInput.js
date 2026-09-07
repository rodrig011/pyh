/** Allowlisted market data sufficient to rerun the engine. Never serialize
 * settings, credentials, order IDs, payment data, or arbitrary API envelopes. */
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined)
  .map((key) => [key, object[key]]));

export function captureReplayInput(input) {
  const market = pick(input.market, ['ticker', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask',
    'yes_bid_dollars', 'yes_ask_dollars', 'no_bid_dollars', 'no_ask_dollars',
    'yes_bid_size', 'yes_ask_size', 'yes_bid_size_fp', 'yes_ask_size_fp',
    'liquidity', 'liquidity_dollars', 'book_liquidity_dollars', 'book_at', 'close_time']);
  market.microstructure = pick(input.microstructure ?? input.market?.microstructure,
    ['ofi', 'cvd', 'bookImbalance', 'bookComplete']);
  return {
    ...pick(input, ['spot', 'strike', 'secondsLeft', 'marketPriceCents', 'now', 'sourceAt', 'feedVersion']),
    prices: [...(input.prices ?? [])],
    ...(Array.isArray(input.priceSamples) ? {
      priceSamples: input.priceSamples.map((r) => pick(r, ['at', 'price'])),
    } : {}),
    settlementSamples: input.secondsLeft < 60 ? (input.settlementSamples ?? [])
      .filter((r) => r.sourceAt >= input.now - 60_000 && r.sourceAt <= input.now)
      .map((r) => pick(r, ['source', 'sourceAt', 'price'])) : [],
    trades: (input.trades ?? []).map((r) => pick(r, ['taker_side', 'side', 'count', 'count_fp', 'size', 'amount'])),
    market,
  };
}
