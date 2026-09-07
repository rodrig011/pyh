import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scalpEntryBudget } from '../src/signals/scalp.js';
import { marketSnapshots } from '../src/signals/validation.js';

const EPS = 1e-8;
const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);
const mean = (xs) => xs.length ? sum(xs, (x) => x) / xs.length : null;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n ? (s[Math.floor((n - 1) / 2)] + s[Math.floor(n / 2)]) / 2 : null;
};
const key = (t) => JSON.stringify([t.ticker, t.side, t.openedAt, t.at]);

export function summarizeTrades(rows) {
  const usable = rows.filter((t) => Number.isFinite(t.profit) && Number.isFinite(t.fees));
  const net = sum(usable, (t) => t.profit), fees = sum(usable, (t) => t.fees);
  return {
    trades: usable.length, excludedInvalid: rows.length - usable.length,
    wins: usable.filter((t) => t.profit > EPS).length,
    losses: usable.filter((t) => t.profit < -EPS).length,
    breakEven: usable.filter((t) => Math.abs(t.profit) <= EPS).length,
    net, fees, gross: net + fees,
  };
}

/** Descriptive audit only. Filtering an observed ledger is not a new backtest. */
export function auditExecution(report, previous = null) {
  const profiles = {};
  for (const [name, account] of Object.entries(report.profiles ?? {})) {
    const trades = [...(account.trades ?? [])].sort((a, b) => a.openedAt - b.openedAt || a.at - b.at);
    const previousTrades = previous?.profiles?.[name]?.trades ?? [];
    const previousKeys = new Set(previousTrades.map(key));
    const currentKeys = new Set(trades.map(key));
    const byReason = {}, byTicker = new Map(), last = new Map();
    const gaps = [], quick = [], changedSide = [], budgetPass = [], budgetFail = [], budgetUnknown = [];
    const accountingErrors = [];
    for (const trade of trades) {
      (byReason[trade.reason ?? 'unknown'] ??= []).push(trade);
      byTicker.set(trade.ticker, (byTicker.get(trade.ticker) ?? 0) + 1);
      const prior = last.get(trade.ticker);
      if (prior && Number.isFinite(prior.at) && Number.isFinite(trade.openedAt)) {
        const gap = (trade.openedAt - prior.at) / 1000;
        gaps.push(gap);
        if (gap >= 0 && gap <= 30) quick.push(trade);
        if (prior.side !== trade.side) changedSide.push(trade);
      }
      last.set(trade.ticker, trade);
      const budget = scalpEntryBudget(trade.entryCents, trade.entryEvidence?.probability,
        { marginCents: name === 'careful' ? 0.5 : 0.25 });
      (budget ? budget.coversCosts ? budgetPass : budgetFail : budgetUnknown).push(trade);
      const inputs = [trade.profit, trade.proceeds, trade.cost, trade.contracts, trade.entryCents, trade.exitCents, trade.fees];
      if (!inputs.every(Number.isFinite)) { accountingErrors.push({ key: key(trade), reason: 'missing inputs' }); continue; }
      const formula = trade.contracts * (trade.exitCents - trade.entryCents) / 100 - trade.fees;
      if (Math.abs(trade.profit - formula) > EPS || Math.abs(trade.profit - (trade.proceeds - trade.cost)) > EPS) {
        accountingErrors.push({ key: key(trade), recorded: trade.profit, recomputed: formula });
      }
    }
    const summary = summarizeTrades(trades);
    profiles[name] = {
      start: account.start, cash: account.cash, ...summary,
      newTrades: summarizeTrades(trades.filter((t) => !previousKeys.has(key(t)))),
      missingPreviousTrades: previousTrades.filter((t) => !currentKeys.has(key(t))).length,
      duplicateKeys: trades.length - currentKeys.size,
      cashMinusStartMinusClosedProfit: account.cash - account.start - summary.net,
      accountingErrors,
      uniqueMarkets: byTicker.size,
      maximumTradesPerMarket: Math.max(0, ...byTicker.values()),
      byExitReason: Object.fromEntries(Object.entries(byReason).map(([k, rows]) => [k, summarizeTrades(rows)])),
      earlyExits: summarizeTrades(trades.filter((t) => t.reason !== 'settled')),
      reentries: gaps.length, medianReentrySeconds: median(gaps),
      overlappingTrades: gaps.filter((n) => n < 0).length,
      reentriesWithin30Seconds: summarizeTrades(quick),
      changedSideReentries: summarizeTrades(changedSide),
      medianHoldingSeconds: median(trades.filter((t) => Number.isFinite(t.at) && Number.isFinite(t.openedAt))
        .map((t) => (t.at - t.openedAt) / 1000)),
      entryBudgetCohorts: { pass: summarizeTrades(budgetPass), fail: summarizeTrades(budgetFail), unknown: summarizeTrades(budgetUnknown) },
      missingExitEvidence: trades.filter((t) => t.reason !== 'settled' && !t.exitEvidence).length,
    };
  }
  const verified = (report.observations ?? []).filter((r) =>
    r.evidence?.feedVersion === 'brti-latest-v2' && Number.isFinite(r.evidence?.sourceAt) &&
    r.at - r.evidence.sourceAt >= -5000 && r.at - r.evidence.sourceAt <= 15000);
  const forecast = [600, 300].map((secondsLeft) => {
    const rows = marketSnapshots(verified, { targetSecondsLeft: secondsLeft })
      .filter((r) => Math.abs(r.secondsLeft - secondsLeft) <= 20);
    return { secondsLeft, markets: rows.length,
      modelBrier: mean(rows.map((r) => (r.model - r.outcome) ** 2)),
      marketBrier: mean(rows.map((r) => ((r.bid + r.ask) / 200 - r.outcome) ** 2)),
      modelCorrect: rows.filter((r) => (r.model >= 0.5) === (r.outcome === 1)).length,
      marketCorrect: rows.filter((r) => ((r.bid + r.ask) / 200 >= 0.5) === (r.outcome === 1)).length,
    };
  });
  return { exportedAt: report.exportedAt, observations: report.observations?.length ?? 0,
    verifiedObservations: verified.length, profiles, forecast,
    limitations: [
      'Recorded paper prices and fees are assumptions, not confirmed fills or exchange fee receipts.',
      'Entry-budget cohorts retain original exits, sizes and capital reuse; their sums are not a counterfactual strategy return.',
      'Repeated trades in the same market are dependent observations.',
      'Past exit probabilities cannot be recovered when exitEvidence is missing.',
      'Cash reconciliation can differ when a position is open or the exported ledger is truncated.',
      'Tiny floating-point residuals within 1e-8 dollars are classified as break-even without rewriting the ledger.',
    ] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/audit-execution.mjs report.json [previous.json]');
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(JSON.stringify(auditExecution(read(process.argv[2]), process.argv[3] ? read(process.argv[3]) : null), null, 2) + '\n');
}
