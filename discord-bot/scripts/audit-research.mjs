import { readFileSync } from 'node:fs';
import { marketSnapshots } from '../src/signals/validation.js';

// Offline only. Never requests credentials, reconstructs fills or changes the store.
const [path, previousPath] = process.argv.slice(2);
if (!path) throw new Error('Usage: node scripts/audit-research.mjs report.json [previous.json]');
const report = JSON.parse(readFileSync(path, 'utf8'));
const previous = previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')) : null;
const observations = report.observations ?? [];
const trades = report.profiles?.always?.trades ?? [];
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2 : null;
};
const stats = (rows) => ({ trades: rows.length, wins: rows.filter((t) => t.profit > 0).length,
  losses: rows.filter((t) => t.profit < 0).length, flat: rows.filter((t) => t.profit === 0).length,
  profit: rows.reduce((s, t) => s + t.profit, 0), fees: rows.reduce((s, t) => s + t.fees, 0) });
const id = (trade) => `${trade.ticker}:${trade.openedAt}`;
const priorTrades = new Set((previous?.profiles?.always?.trades ?? []).map(id));
const outcomes = new Map(observations.filter((row) => row.outcomeSource === 'kalshi-market:official-result')
  .map((row) => [row.ticker, row.outcome]));
const high = trades.filter((trade) => trade.entryEvidence?.probability >= 0.99);
const resolvedHigh = high.filter((trade) => outcomes.get(trade.ticker) === 0 || outcomes.get(trade.ticker) === 1);
const snapshots = marketSnapshots(observations);
const byTicker = new Map();
for (const row of observations) {
  if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
  byTicker.get(row.ticker).push(row);
}
const discrepancies = [...byTicker.entries()].flatMap(([ticker, rows]) => {
  const late = rows.filter((row) => row.secondsLeft > 0 && row.secondsLeft <= 60 &&
    row.outcomeSource === 'kalshi-market:official-result');
  if (!late.length) return [];
  const sampleAverage = mean(late.map((row) => row.spot));
  const last = late.at(-1);
  return Number(sampleAverage > last.strike) === last.outcome ? [] : [{ ticker,
    sampleAverage, strike: last.strike, officialOutcome: last.outcome, samples: late.length }];
});

// Diagnose clock alignment on a common set of windows. These shifted values
// were observed LATER and must NEVER be used as a tradable backtest input.
const firstAt = Math.min(...observations.map((row) => row.at));
const lastAt = Math.max(...observations.map((row) => row.at));
const comparable = [...byTicker.values()].map((rows) => {
  const first = rows[0];
  return { openAt: first.at + first.secondsLeft * 1000 - 900000, strike: first.strike };
}).filter((row) => row.openAt - 60000 >= firstAt && row.openAt + 4500000 <= lastAt);
const lagDiagnostic = [0, 900, 1800, 2700, 3600, 4500].map((lagSeconds) => {
  const errors = comparable.flatMap(({ openAt, strike }) => {
    const prices = observations.filter((row) => row.at >= openAt - 60000 + lagSeconds * 1000 &&
      row.at < openAt + lagSeconds * 1000).map((row) => row.spot);
    return prices.length ? [mean(prices) - strike] : [];
  });
  return { lagSeconds, windows: errors.length, medianAbsoluteError: median(errors.map(Math.abs)),
    rmse: errors.length ? Math.sqrt(mean(errors.map((e) => e * e))) : null };
});

console.log(JSON.stringify({
  schemaVersion: report.schemaVersion,
  observations: observations.length,
  markets: byTicker.size,
  timestampedQuotes: observations.filter((row) => Number.isFinite(row.evidence?.sourceAt)).length,
  always: stats(trades), newTrades: previous ? stats(trades.filter((trade) => !priorTrades.has(id(trade)))) : null,
  forced: stats(trades.filter((trade) => trade.forced)),
  modelEntries: stats(trades.filter((trade) => !trade.forced)),
  highProbability: { threshold: 0.99, realisedTrades: stats(high),
    officialSettlements: resolvedHigh.length,
    correctSettlements: resolvedHigh.filter((trade) => outcomes.get(trade.ticker) === Number(trade.side === 'up')).length },
  scoring: { markets: snapshots.length,
    modelBrier: mean(snapshots.map((row) => (row.model - row.outcome) ** 2)),
    marketBrier: mean(snapshots.map((row) => ((row.bid + row.ask) / 200 - row.outcome) ** 2)) },
  lagDiagnostic, lateWindowDiscrepancies: discrepancies,
  latestObservation: observations.at(-1), latestTrade: trades.at(-1),
  limitations: ['Paper ledger amounts are simulated, not bank deposits or exchange fill confirmations.',
    'Last-minute samples are sparse; their mean is not an official settlement value.',
    'The lag comparison uses later observations for diagnosis only. No corrected historical trading profits are claimed.'],
}, null, 2));
