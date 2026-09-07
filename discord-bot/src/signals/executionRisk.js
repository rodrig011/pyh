export const EXECUTION_POLICY_VERSION = 'bounded-risk-v2';

/** Available size at the quoted level. YES bids are NO asks and vice versa. */
export function quotedEntrySize(market, side) {
  const key = side === 'down' ? 'yes_bid_size' : 'yes_ask_size';
  const raw = market?.[key] ?? market?.[`${key}_fp`];
  if (raw == null || raw === '') return null;
  const size = Number(raw);
  return Number.isFinite(size) && size >= 0 ? Math.floor(size) : null;
}

/** A per-contract cash budget, carried across closes and restarts. Profits
 * do not refill it: repeated bets on one settlement are not independent. */
export function entryRiskBudget(account, ticker, {
  maximumFraction = 0.02, maximumMarketFraction = 0.05,
} = {}) {
  const cash = Math.max(0, Number(account.cash) || 0);
  const prior = account.marketRisk?.ticker === ticker ? account.marketRisk : null;
  const basisCash = prior?.basisCash ?? cash;
  const committedDollars = prior?.committedDollars ?? 0;
  const marketLimitDollars = basisCash * Math.max(0, maximumMarketFraction);
  return {
    ticker, basisCash, committedDollars, marketLimitDollars,
    availableDollars: Math.max(0, Math.min(cash, cash * Math.max(0, maximumFraction),
      marketLimitDollars - committedDollars)),
    policyVersion: EXECUTION_POLICY_VERSION,
  };
}
