import { feePerContract } from './math.js';

/**
 * What a trade actually costs, as opposed to what it looks like it costs.
 *
 * This file exists because of a silent and expensive mistake: the engine was
 * measuring its edge against the MID price. Nobody trades at the mid. Buying
 * the YES side costs the ask; buying the NO side costs the NO ask, which is a
 * hundred minus the YES *bid* — not a hundred minus the YES ask, which is the
 * NO bid and is what you would receive for selling.
 *
 * On a market quoted 46/49, the mid is 47.5. A model that says 54 believes it
 * has 6.5¢ of edge on the up side. It has 5¢, because it pays 49. And on the
 * down side it does not have 6.5¢ against it — it has 54 − (100 − 46) = 0.
 * Half the spread, on every trade, invisible, against a threshold of six cents.
 *
 * Every number here is in cents of contract, because that is the unit the
 * exchange quotes in and converting early is how sides get mixed up.
 */

/**
 * The four prices that exist on a two-sided binary market.
 *
 * A binary contract is one instrument quoted two ways: the NO book is the YES
 * book reflected around a hundred. Deriving it rather than reading a separate
 * feed keeps the two sides consistent by construction.
 */
export function executablePrices(market, fallbackCents = null) {
  const toCents = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Kalshi publishes both dollars and cents depending on the field.
    return n > 0 && n <= 1 ? n * 100 : n;
  };

  const yesBid = toCents(market?.yes_bid_dollars ?? market?.yes_bid);
  const yesAsk = toCents(market?.yes_ask_dollars ?? market?.yes_ask);

  if (yesBid !== null && yesAsk !== null && yesAsk >= yesBid && yesAsk > 0) {
    return {
      yesBidCents: yesBid,
      yesAskCents: yesAsk,
      // Selling YES and buying NO are the same trade seen from two sides.
      noBidCents: 100 - yesAsk,
      noAskCents: 100 - yesBid,
      midCents: (yesBid + yesAsk) / 2,
      spreadCents: yesAsk - yesBid,
      // Named so a signal can say out loud that it is estimating.
      quoted: true,
    };
  }

  // No book. The last trade is the only thing left, and it is a price somebody
  // else got, not one on offer. Flagged rather than dressed up.
  if (!(fallbackCents > 0)) return null;
  return {
    yesBidCents: fallbackCents,
    yesAskCents: fallbackCents,
    noBidCents: 100 - fallbackCents,
    noAskCents: 100 - fallbackCents,
    midCents: fallbackCents,
    spreadCents: null,
    quoted: false,
  };
}

/** What opening a position on `side` costs per contract, before fees. */
export function entryPriceCents(side, prices) {
  if (!prices) return null;
  return side === 'down' ? prices.noAskCents : prices.yesAskCents;
}

/** What closing a position on `side` pays per contract, before fees. */
export function exitPriceCents(side, prices) {
  if (!prices) return null;
  return side === 'down' ? prices.noBidCents : prices.yesBidCents;
}

/**
 * Every cent the exchange takes on a position, from open to close.
 *
 * `settle` is the whole reason this is a function and not a constant. Kalshi
 * charges per trade and charges nothing to settle a contract that expires in
 * the money, so a position carried to the bell pays ONE fee and a position
 * sold early pays two. At mid prices that difference is around 1.75¢, which on
 * a six-cent edge is nearly a third of it.
 */
export function positionCostCents(entryCents, exitCents, { feeRate = 0.07, settle = false } = {}) {
  if (!(entryCents > 0)) return null;

  const entryFee = feePerContract(entryCents / 100, feeRate) * 100;
  if (settle) return entryFee;

  if (!(exitCents > 0)) return null;
  return entryFee + feePerContract(exitCents / 100, feeRate) * 100;
}

/**
 * The edge that survives everything, for one side of one market.
 *
 * The only number worth acting on. `probability` is the chance THIS side wins,
 * `prices` is the real book, and the answer is in cents per contract after the
 * spread has been crossed and the exchange has been paid.
 */
export function netEdgeCents(probability, side, prices, { feeRate = 0.07, settle = true } = {}) {
  const entry = entryPriceCents(side, prices);
  if (!Number.isFinite(probability) || !(entry > 0) || entry >= 100) return null;

  // Held to settlement, the exit is worth 100 or 0 and neither is charged a
  // fee. Sold early it costs a second one, so the pessimistic assumption is
  // the one that keeps the engine honest about what it is promising.
  const cost = positionCostCents(entry, entry, { feeRate, settle });
  if (cost === null) return null;

  const gross = probability * 100 - entry;
  const net = gross - cost;

  return {
    side,
    entryCents: entry,
    grossCents: gross,
    feeCents: cost,
    netCents: net,
    // Per dollar actually at risk, which is what compares across prices: two
    // cents on a ten cent contract is not the same trade as two on an eighty.
    returnOnRisk: net / entry,
  };
}

/**
 * The fee as a share of the money at risk, by price.
 *
 * Worth having as a function because the shape is not the one people expect.
 * The fee in cents peaks at 50¢, but as a fraction of what you put up it falls
 * steadily as the price rises — 0.07·p·(1−p)/p simplifies to 0.07·(1−p) — so
 * an 80¢ contract is charged a quarter of what a 20¢ one is charged, per
 * dollar risked. The rounding up to the whole cent then bites hardest at the
 * cheap end, where a single cent is a tenth of the stake.
 */
export function feeShareOfRisk(priceCents, feeRate = 0.07) {
  if (!(priceCents > 0) || priceCents >= 100) return null;
  return (feePerContract(priceCents / 100, feeRate) * 100) / priceCents;
}
