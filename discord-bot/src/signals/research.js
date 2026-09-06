import { walkForwardValidation } from './validation.js';

export function tradeDiagnostics(trades = []) {
  const groups = new Map();
  const tickers = new Map();
  for (const trade of trades) {
    if (!Number.isFinite(trade.profit)) continue;
    const key = `${trade.forced ? 'forced' : 'model'}:${trade.reason ?? 'unknown'}`;
    const group = groups.get(key) ?? { category: key, trades: 0, wins: 0, losses: 0, profit: 0, fees: 0 };
    group.trades += 1;
    group.wins += trade.profit > 0 ? 1 : 0;
    group.losses += trade.profit < 0 ? 1 : 0;
    group.profit += trade.profit;
    group.fees += Number.isFinite(trade.fees) ? trade.fees : 0;
    groups.set(key, group);
    if (trade.ticker) tickers.set(trade.ticker, (tickers.get(trade.ticker) ?? 0) + 1);
  }
  return {
    groups: [...groups.values()],
    repeatedMarkets: [...tickers].filter(([, count]) => count > 1).map(([ticker, count]) => ({ ticker, trades: count })),
    missingEntryEvidence: trades.filter((trade) => !trade.entryEvidence).length,
    note: 'Descriptive results from retained trades. Exit reasons do not establish the causal reason BTC moved.',
  };
}

/** Allowlisted trading data only: never export the payment store or credentials. */
export function researchExport(store, asset = 'BTC', now = Date.now()) {
  const observations = (store.listQuotes?.(asset) ?? []).map((row) => ({
    at: row.at, ticker: row.ticker, secondsLeft: row.secondsLeft,
    spot: row.spot, strike: row.strike, bid: row.bid, ask: row.ask,
    model: row.model, outcome: row.outcome, outcomeSource: row.outcomeSource,
  }));
  const profiles = Object.fromEntries(Object.entries(store.paperAccounts?.() ?? {}).map(([name, account]) => {
    const trades = (account.trades ?? []).map((t) => ({
      ticker: t.ticker, side: t.side, strike: t.strike, openedAt: t.openedAt, at: t.at,
      entryCents: t.entryCents, exitCents: t.exitCents, contracts: t.contracts,
      profit: t.profit, cost: t.cost, proceeds: t.proceeds, fees: t.fees,
      reason: t.reason, forced: t.forced, entryReason: t.entryReason, entryEvidence: t.entryEvidence,
      settlementSource: t.settlementSource, settlementPrice: t.settlementPrice,
    }));
    return [name, { start: account.start, cash: account.cash, retainedTrades: trades.length,
      lifetimeTrades: account.tradeStats?.total ?? trades.length, trades, diagnostics: tradeDiagnostics(trades) }];
  }));
  return { schemaVersion: 1, exportedAt: now, asset, observations, profiles,
    validation: walkForwardValidation(observations),
    limitations: ['Only retained history is exported; older truncated rows cannot be reconstructed.',
      'Missing past entry features remain missing; no retrospective thesis is invented.'] };
}
