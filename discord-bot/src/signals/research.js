import { walkForwardValidation } from './validation.js';
import { forwardResearch } from './modelLab.js';
import { EXIT_STUDY_VERSION, exitStudySummary } from './exitStudy.js';
import { EXECUTION_POLICY_VERSION } from './executionRisk.js';

export function tradeDiagnostics(trades = []) {
  const groups = new Map();
  const tickers = new Map();
  for (const trade of trades) {
    if (!Number.isFinite(trade.profit)) continue;
    const key = `${trade.forced ? 'forced' : 'model'}:${trade.reason ?? 'unknown'}`;
    const group = groups.get(key) ?? { category: key, trades: 0, wins: 0, losses: 0, breakEven: 0, profit: 0, fees: 0 };
    group.trades += 1;
    group.wins += trade.profit > 1e-8 ? 1 : 0;
    group.losses += trade.profit < -1e-8 ? 1 : 0;
    group.breakEven += Math.abs(trade.profit) <= 1e-8 ? 1 : 0;
    group.profit += trade.profit;
    group.fees += Number.isFinite(trade.fees) ? trade.fees : 0;
    groups.set(key, group);
    if (trade.ticker) tickers.set(trade.ticker, (tickers.get(trade.ticker) ?? 0) + 1);
  }
  return {
    groups: [...groups.values()],
    repeatedMarkets: [...tickers].filter(([, count]) => count > 1).map(([ticker, count]) => ({ ticker, trades: count })),
    missingEntryEvidence: trades.filter((trade) => !trade.entryEvidence).length,
    missingExitEvidence: trades.filter((trade) => trade.reason !== 'settled' && !trade.exitEvidence).length,
    note: 'Descriptive results from retained trades. Exit reasons do not establish the causal reason BTC moved.',
  };
}

/** Allowlisted trading data only: never export the payment store or credentials. */
export function researchExport(store, asset = 'BTC', now = Date.now()) {
  const observations = (store.listQuotes?.(asset) ?? []).map((row) => ({
    at: row.at, ticker: row.ticker, secondsLeft: row.secondsLeft,
    spot: row.spot, strike: row.strike, bid: row.bid, ask: row.ask,
    model: row.model, outcome: row.outcome, outcomeSource: row.outcomeSource,
    outcomeRecordedAt: row.outcomeRecordedAt ?? null,
    evidence: row.evidence ?? null,
  }));
  const exportAccounts = (accounts) => Object.fromEntries(Object.entries(accounts ?? {}).map(([name, account]) => {
    const trades = (account.trades ?? []).map((t) => ({
      ticker: t.ticker, side: t.side, strike: t.strike, openedAt: t.openedAt, at: t.at,
      entryCents: t.entryCents, exitCents: t.exitCents, contracts: t.contracts,
      profit: t.profit, cost: t.cost, proceeds: t.proceeds, fees: t.fees,
      reason: t.reason, forced: t.forced, entryReason: t.entryReason, entryEvidence: t.entryEvidence,
      exitEvidence: t.exitEvidence ?? null,
      settlementSource: t.settlementSource, settlementPrice: t.settlementPrice,
    }));
    const position = account.position ? {
      ticker: account.position.ticker, side: account.position.side,
      strike: account.position.strike, contracts: account.position.contracts,
      entryCents: account.position.entryCents, cost: account.position.cost,
      openedAt: account.position.openedAt, closesAt: account.position.closesAt,
      lastBidCents: account.position.lastBidCents ?? null, lastMarkAt: account.position.lastMarkAt ?? null,
      entryEvidence: account.position.entryEvidence ?? null,
    } : null;
    return [name, { start: account.start, cash: account.cash, startedAt: account.startedAt,
      runId: `${name}:${account.epoch ?? account.startedAt ?? 'legacy'}`,
      exitStudy: { ...exitStudySummary(account), trials: (account.exitStudy?.trials ?? []).map((t) => ({
        ticker: t.ticker, side: t.side, openedAt: t.openedAt, closesAt: t.closesAt,
        entryCents: t.entryCents, costCents: t.costCents, entryPolicy: t.entryPolicy,
        actualProfitCents: t.actualProfitCents, actualClosedAt: t.actualClosedAt, actualReason: t.actualReason,
        holdProfitCents: t.holdProfitCents, outcome: t.outcome, outcomeRecordedAt: t.outcomeRecordedAt,
        outcomeSource: t.outcomeSource,
      })) },
      position, marketRisk: account.marketRisk ?? null,
      closedProfit: account.tradeStats?.netProfit ?? trades.reduce((sum, t) => sum + (t.profit ?? 0), 0),
      retainedTrades: trades.length,
      lifetimeTrades: account.tradeStats?.total ?? trades.length, trades, diagnostics: tradeDiagnostics(trades) }];
  }));
  const profiles = exportAccounts(store.paperAccounts?.());
  const archivedRuns = (store.paperArchives?.() ?? []).map((archive) => ({
    at: archive.at, reason: archive.reason, profiles: exportAccounts(archive.accounts),
  }));
  return { schemaVersion: 2, exportedAt: now, asset, observations, profiles,
    implementation: { executionPolicy: EXECUTION_POLICY_VERSION, exitStudy: EXIT_STUDY_VERSION },
    archivedRuns,
    modelResearch: forwardResearch(observations),
    validation: walkForwardValidation(observations, { requireVerifiedFeed: true }),
    limitations: ['Only retained history is exported; older truncated rows cannot be reconstructed.',
      'Missing past entry features remain missing; no retrospective thesis is invented.',
      'Paper fees use conservative per-contract cent rounding; they are not confirmed exchange fees.',
      'Rows without brti-latest-v2 timestamps may contain the old delayed feed; do not train a new calibration on them.'] };
}
